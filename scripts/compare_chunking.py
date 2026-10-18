#!/usr/bin/env python3
"""Chunk the same documents every way worth comparing, then score each way on the same questions.

Run from worker/ so the worker's settings and keys load:

    cd worker
    .venv/bin/python ../scripts/compare_chunking.py build              # every method, every document with questions
    .venv/bin/python ../scripts/compare_chunking.py build --only structural
    .venv/bin/python ../scripts/compare_chunking.py eval               # prints the table, writes scripts/benchmarks/comparison.json

`build` parses each PDF with the worker's own parser and stores, beside the live rows:

    fixed         300-token windows with 20% overlap over the plain text of each page (Bedrock fixed-size)
    semantic      sentences grouped until the meaning shifts: each sentence embedded with one
                  neighbour either side, a cut where the distance to the next is in the top 5%,
                  300 tokens at most (Bedrock semantic chunking)
    hierarchical  300-token children inside 1,500-token parents, 60 tokens of overlap at both
                  levels; parents stored as hier_parent (Bedrock hierarchical chunking)
    structural    our chunker with every model call off: cut at headings, whole tables plus a
                  chunk per row, figures with their captions and printed labels

Every method is embedded with the app's own model (voyage-4), so the chunking is the only thing
that differs. The baselines read the page text the way a plain extractor does; pages that only
an OCR pass can read are given the OCR text, which is a kindness to them.

`eval` runs every benchmark question through the app's own search function for each setup and
counts a hit when one of the top five passages contains the expected phrase in the document's own
words (never in a model-written sentence) on the expected page. It also reports how many tokens
the top five add up to: what a person, or a model writing an answer, has to read.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import uuid
from datetime import date
from pathlib import Path

import numpy as np
import psycopg
import pymupdf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

from app import db, storage  # noqa: E402
from app.chunk.structural import chunk_structural  # noqa: E402
from app.config import settings  # noqa: E402
from app.chunk.tokens import _enc, count  # noqa: E402
from app.llm import voyage  # noqa: E402
from app.parse.layout import parse_document  # noqa: E402
from app.parse.model import PageLayout, TableBlock, TextBlock  # noqa: E402

METHODS = ["fixed", "semantic", "hierarchical", "structural"]
OUT = ROOT / "scripts" / "benchmarks" / "comparison.json"

# Prices read on 2026-10-15 (README, "Models and cost"): dollars per million tokens.
PRICE = {"voyage": 0.06, "haiku_in": 0.10, "haiku_out": 0.50, "opus_in": 4.0, "opus_out": 20.0}


def _conn() -> psycopg.Connection:
    """Plain tuple rows (the worker's helper returns dicts)."""
    return psycopg.connect(settings.database_url, autocommit=True)


# ---------------------------------------------------------------------------
# text the baselines see
# ---------------------------------------------------------------------------

def _layout_text(lay: PageLayout) -> str:
    parts: list[str] = []
    for b in lay.blocks:
        if isinstance(b, TextBlock):
            parts.append(b.text)
        elif isinstance(b, TableBlock):
            parts += [" ".join(c for c in row if c) for row in [b.header, *b.rows]]
    return "\n".join(p for p in parts if p.strip())


def page_texts(doc: pymupdf.Document, layouts: list[PageLayout]) -> list[str]:
    """Plain extraction per page; the OCR text where the page has no usable text layer."""
    out = []
    for i, lay in enumerate(layouts):
        t = doc[i].get_text("text")
        if lay.ocr_applied or len(t.strip()) < 20:
            t = _layout_text(lay)
        out.append(t)
    return out


def _stream(texts: list[str]) -> tuple[list[int], list[int]]:
    toks: list[int] = []
    pages: list[int] = []
    for pno, t in enumerate(texts, 1):
        ids = _enc.encode(t + "\n", disallowed_special=())
        toks += ids
        pages += [pno] * len(ids)
    return toks, pages


def _windows(start: int, end: int, size: int, overlap: int):
    i = start
    while i < end:
        j = min(i + size, end)
        yield i, j
        if j >= end:
            break
        i = j - overlap


def _row(doc_id: str, strategy: str, ordinal: int, text: str, p0: int, p1: int, parent: str | None = None) -> dict:
    return {
        "id": str(uuid.uuid4()), "document_id": doc_id, "strategy": strategy, "chunk_type": "text",
        "ordinal": ordinal, "content": text, "raw_text": text, "context": None,
        "page_start": p0, "page_end": p1, "bboxes": [], "parent_id": parent, "prev_id": None, "next_id": None,
        "metadata": {}, "token_count": count(text), "embedding": None,
    }


# ---------------------------------------------------------------------------
# the methods
# ---------------------------------------------------------------------------

def fixed_rows(doc_id: str, texts: list[str], size: int = 300, overlap: int = 60) -> list[dict]:
    toks, pages = _stream(texts)
    return [_row(doc_id, "fixed", n, _enc.decode(toks[a:b]), pages[a], pages[b - 1])
            for n, (a, b) in enumerate(_windows(0, len(toks), size, overlap))]


def hierarchical_rows(doc_id: str, texts: list[str], parent: int = 1500, child: int = 300, overlap: int = 60) -> tuple[list[dict], list[dict]]:
    toks, pages = _stream(texts)
    parents, children = [], []
    for pn, (a, b) in enumerate(_windows(0, len(toks), parent, overlap)):
        p = _row(doc_id, "hier_parent", pn, _enc.decode(toks[a:b]), pages[a], pages[b - 1])
        parents.append(p)
        for c, d in _windows(a, b, child, overlap):
            children.append(_row(doc_id, "hierarchical", len(children), _enc.decode(toks[c:d]), pages[c], pages[d - 1], parent=p["id"]))
    return parents, children


_SENT = re.compile(r"(?<=[.!?;:])\s+(?=[A-Z0-9(“\"])")


def semantic_rows(doc_id: str, texts: list[str], max_tokens: int = 300, buffer: int = 1, pct: float = 95) -> tuple[list[dict], int]:
    """Bedrock-style semantic chunking. Returns the rows and the tokens spent embedding sentence windows."""
    sents: list[tuple[str, int]] = []
    for pno, t in enumerate(texts, 1):
        flat = re.sub(r"\s*\n\s*", " ", t).strip()
        for s in _SENT.split(flat):
            ids = _enc.encode(s.strip(), disallowed_special=())
            for a in range(0, len(ids), max_tokens):          # a "sentence" longer than the budget is cut
                piece = _enc.decode(ids[a:a + max_tokens]).strip()
                if piece:
                    sents.append((piece, pno))
    if not sents:
        return [], 0
    windows = [" ".join(s for s, _ in sents[max(0, i - buffer): i + buffer + 1]) for i in range(len(sents))]
    vecs = np.array(voyage.embed(windows, input_type="document"), dtype=np.float32)
    vecs /= np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-9
    dist = 1 - np.sum(vecs[:-1] * vecs[1:], axis=1)
    cut = float(np.percentile(dist, pct)) if len(dist) else 1.0
    rows, cur, cur_n = [], [], 0
    for i, (s, pno) in enumerate(sents):
        n = count(s)
        boundary = i > 0 and dist[i - 1] > cut
        if cur and (boundary or cur_n + n > max_tokens):
            rows.append(_row(doc_id, "semantic", len(rows), " ".join(x for x, _ in cur), cur[0][1], cur[-1][1]))
            cur, cur_n = [], 0
        cur.append((s, pno))
        cur_n += n
    if cur:
        rows.append(_row(doc_id, "semantic", len(rows), " ".join(x for x, _ in cur), cur[0][1], cur[-1][1]))
    return rows, sum(count(w) for w in windows)


def structural_rows(doc_id: str, layouts: list[PageLayout], title: str) -> list[dict]:
    drafts = chunk_structural(layouts, title)
    for d in drafts:
        d.image_png = None
    return [d.to_row(doc_id, "structural") for d in drafts]


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

def documents_with_questions() -> list[dict]:
    with _conn() as c:
        cur = c.cursor()
        cur.execute("""select d.id::text as id, d.name, d.storage_path, d.stats from documents d
                       where d.status = 'ready' and exists (select 1 from eval_questions q where q.document_id = d.id)
                       order by d.name""")
        cols = [x.name for x in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def build(methods: list[str], match: str | None = None) -> None:
    docs = [d for d in documents_with_questions() if not match or match.lower() in d["name"].lower()]
    print(f"{len(docs)} documents with benchmark questions; building {', '.join(methods)}")
    tally: dict[str, int] = {}
    for d in docs:
        t0 = time.time()
        pdf = pymupdf.open(stream=storage.download(d["storage_path"]), filetype="pdf")
        layouts = parse_document(pdf)
        texts = page_texts(pdf, layouts)
        title = d["name"].rsplit(".", 1)[0]
        rows: list[dict] = []
        extra = 0
        if "fixed" in methods:
            rows += fixed_rows(d["id"], texts)
        if "hierarchical" in methods:
            parents, children = hierarchical_rows(d["id"], texts)
            rows += parents + children
        if "semantic" in methods:
            sem, extra = semantic_rows(d["id"], texts)
            rows += sem
            tally["semantic_windows"] = tally.get("semantic_windows", 0) + extra
        if "structural" in methods:
            rows += structural_rows(d["id"], layouts, title)

        to_embed = [r for r in rows if r["strategy"] != "hier_parent"]
        vecs = voyage.embed([r["content"] for r in to_embed], input_type="document")
        for r, v in zip(to_embed, vecs):
            r["embedding"] = v
        stored = {"hier_parent" if m == "hierarchical" else m for m in methods} | ({"hierarchical"} if "hierarchical" in methods else set())
        with db.conn() as c:
            c.execute("delete from chunks where document_id = %s and strategy = any(%s)", (d["id"], list(stored)))
        # parents before children, so the children's parent links resolve
        db.insert_chunks([r for r in rows if r["strategy"] == "hier_parent"])
        db.insert_chunks([r for r in rows if r["strategy"] != "hier_parent"])
        counts = {s: sum(1 for r in rows if r["strategy"] == s) for s in sorted({r["strategy"] for r in rows})}
        for r in to_embed:
            tally[r["strategy"]] = tally.get(r["strategy"], 0) + r["token_count"]
        print(f"  {title[:44]:44} {counts}  {time.time() - t0:.0f}s")
    print("embedding tokens:", tally)


# ---------------------------------------------------------------------------
# eval
# ---------------------------------------------------------------------------

SETUPS = [
    # key, label, strategy searched, keyword weight, meaning weight, returns parents
    ("fixed_vec", "Fixed-size 300 tokens, meaning search", "fixed", 0, 1, False),
    ("fixed_hyb", "Fixed-size 300 tokens, hybrid search", "fixed", 1, 1, False),
    ("semantic_vec", "Semantic chunking, meaning search", "semantic", 0, 1, False),
    ("hier_vec", "Hierarchical 1,500 / 300, meaning search", "hierarchical", 0, 1, True),
    ("hier_hyb", "Hierarchical 1,500 / 300, hybrid search", "hierarchical", 1, 1, True),
    ("struct_kw", "Structure-aware, keywords only (no AI at all)", "structural", 1, 0, False),
    ("struct_hyb", "Structure-aware + embeddings API (no generative AI)", "structural", 1, 1, False),
    ("struct_local", "Structure-aware + local open-source model (the app: no API, nothing generated)", "structural", 1, 1, False),
    ("ctx_kw", "Structure-aware + AI context, keywords only", "contextual", 1, 0, False),
    ("ctx_hyb", "Structure-aware + AI context + embeddings API (optional generative AI)", "contextual", 1, 1, False),
]


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


LOCAL_SETUPS = {"struct_local"}       # meaning search from the local model's vectors (embedding_local)
# The search page asks for 8 results (web/src/app/api/search/route.ts) and the SQL draws 4 times that many
# candidates from each list. hybrid_search_local scores passages with little text of their own lower within those
# candidates (section 29), so the count changes the order: every setup is searched with the app's 8, top 5 scored.
APP_K = 8


def _search(cur, q: str, emb, strategy: str, doc_id: str, kw: float, vec: float, k: int, fn: str = "hybrid_search") -> list[dict]:
    cur.execute(
        f"""select h.id::text, h.raw_text, h.page_start, h.page_end, c.token_count, h.parent_id::text, h.fts_rank, h.vec_rank
             from {fn}(%s, %s::vector, %s, %s::uuid, %s, 60, %s, %s) h join chunks c on c.id = h.id
            order by h.rrf_score desc""",
        (q, None if vec == 0 else "[" + ",".join(f"{x:.6f}" for x in emb) + "]", strategy, doc_id, k, float(kw), float(vec)),
    )
    cols = [x.name for x in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    if vec == 0:
        rows = [r for r in rows if r["fts_rank"] is not None]
    if kw == 0:
        rows = [r for r in rows if r["vec_rank"] is not None]
    return rows


def evaluate(k: int = 5) -> None:
    with _conn() as c:
        cur = c.cursor()
        cur.execute("""select q.document_id::text, d.name, q.question, q.must_contain, q.expected_page
                         from eval_questions q join documents d on d.id = q.document_id
                        where d.status = 'ready' order by d.name, q.created_at""")
        questions = cur.fetchall()
        have = dict(cur.execute("select strategy, count(*) from chunks group by 1").fetchall())
        has_local = cur.execute("select exists (select 1 from chunks where embedding_local is not null)").fetchone()[0]
        setups = [s for s in SETUPS if have.get(s[2]) and (s[0] not in LOCAL_SETUPS or has_local)]
        print(f"{len(questions)} questions; setups with data: {', '.join(s[0] for s in setups)}")
        embs = voyage.embed([q[2] for q in questions], input_type="query")
        if has_local:
            from app.llm import local
            local_embs = [local.embed_query(q[2]) for q in questions]

        results = {s[0]: [] for s in setups}
        parent_cache: dict[str, dict] = {}
        for qi, ((doc_id, name, question, needle, page), emb) in enumerate(zip(questions, embs)):
            for key, _label, strategy, kw, vec, parents in setups:
                if key in LOCAL_SETUPS:
                    hits = _search(cur, question, local_embs[qi], strategy, doc_id, kw, vec, max(k, APP_K), "hybrid_search_local")
                else:
                    hits = _search(cur, question, emb, strategy, doc_id, kw, vec, max(k, APP_K))
                if parents:                                  # children replaced by their parents, duplicates dropped
                    ids = [h["parent_id"] for h in hits if h["parent_id"]]
                    missing = [i for i in ids if i not in parent_cache]
                    if missing:
                        cur.execute("select id::text, raw_text, page_start, page_end, token_count from chunks where id = any(%s::uuid[])", (missing,))
                        for r in cur.fetchall():
                            parent_cache[r[0]] = {"raw_text": r[1], "page_start": r[2], "page_end": r[3], "token_count": r[4]}
                    seen, merged = set(), []
                    for i in ids:
                        if i not in seen and i in parent_cache:
                            seen.add(i)
                            merged.append(parent_cache[i])
                    hits = merged
                rank = None
                for i, h in enumerate(hits[:k]):
                    text_ok = not needle or _norm(needle) in _norm(h["raw_text"])
                    page_ok = page is None or (h["page_start"] <= page <= h["page_end"])
                    if text_ok and page_ok:
                        rank = i + 1
                        break
                results[key].append({"doc": name, "question": question, "rank": rank, "tokens": sum(h["token_count"] for h in hits[:k])})

    def summary(rows: list[dict]) -> dict:
        n = len(rows)
        return {"questions": n, "recall": round(sum(1 for r in rows if r["rank"]) / n, 3) if n else None,
                "mrr": round(sum(1 / r["rank"] for r in rows if r["rank"]) / n, 3) if n else None,
                "tokens_read": round(sum(r["tokens"] for r in rows) / n) if n else None}

    doc_names = sorted({r["doc"] for rows in results.values() for r in rows})
    report = {
        "date": date.today().isoformat(), "k": k, "questions": len(questions),
        "setups": [{"key": s[0], "label": s[1], "strategy": s[2], **summary(results[s[0]]),
                    "by_document": {dn: summary([r for r in results[s[0]] if r["doc"] == dn]) for dn in doc_names}}
                   for s in setups],
    }
    report["build_cost"] = build_cost()
    first = results[setups[0][0]]
    report["per_question"] = [{"doc": r["doc"].rsplit(".", 1)[0], "question": r["question"],
                               "ranks": {s[0]: results[s[0]][i]["rank"] for s in setups}} for i, r in enumerate(first)]
    OUT.write_text(json.dumps(report, indent=2) + "\n")

    print(f"\n{'Setup':52} {'recall@5':>9} {'MRR':>6} {'tokens read':>12}")
    for s in report["setups"]:
        print(f"{s['label']:52} {s['recall'] * 100:8.0f}% {s['mrr']:6.2f} {s['tokens_read']:12,}")
    print("\nper document, recall@5:")
    print(f"{'':40}" + "".join(f"{s['key']:>11}" for s in report["setups"]))
    for dn in doc_names:
        print(f"{dn[:40]:40}" + "".join(f"{(s['by_document'][dn]['recall'] or 0) * 100:10.0f}%" for s in report["setups"]))
    print(f"\nwrote {OUT.relative_to(ROOT)}")


def build_cost() -> dict:
    """What indexing all the benchmark documents cost per method, from stored token counts and measured model usage."""
    with _conn() as c:
        emb = dict(c.execute("""select c.strategy, sum(c.token_count) from chunks c
                                 where c.strategy <> 'hier_parent'
                                   and c.document_id in (select document_id from eval_questions) group by 1""").fetchall())
        llm = c.execute("""select coalesce(sum((stats->'llm'->'tokens'->>'haiku_in')::bigint), 0),
                                  coalesce(sum((stats->'llm'->'tokens'->>'haiku_out')::bigint), 0),
                                  coalesce(sum((stats->'llm'->'tokens'->>'opus_in')::bigint), 0),
                                  coalesce(sum((stats->'llm'->'tokens'->>'opus_out')::bigint), 0)
                             from documents where id in (select document_id from eval_questions)""").fetchone()
    llm = [float(x) for x in llm]
    emb = {k: float(v) for k, v in emb.items()}
    model = (llm[0] * PRICE["haiku_in"] + llm[1] * PRICE["haiku_out"] + llm[2] * PRICE["opus_in"] + llm[3] * PRICE["opus_out"]) / 1e6
    out = {s: {"embedding_tokens": int(n), "dollars": round(n * PRICE["voyage"] / 1e6, 4)} for s, n in emb.items()}
    if "contextual" in out:
        out["contextual"]["model_dollars"] = round(model, 4)
        out["contextual"]["dollars"] = round(out["contextual"]["dollars"] + model, 4)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["build", "eval"])
    ap.add_argument("--only", nargs="*", choices=METHODS, help="build just these methods")
    ap.add_argument("-k", type=int, default=5)
    ap.add_argument("--doc", help="build only documents whose name contains this")
    a = ap.parse_args()
    if a.command == "build":
        build(a.only or METHODS, a.doc)
    else:
        evaluate(a.k)
