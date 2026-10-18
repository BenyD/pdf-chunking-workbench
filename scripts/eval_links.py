#!/usr/bin/env python3
"""Does following the document's own references find answers that search alone misses, and at what cost?

    cd worker && .venv/bin/python ../scripts/eval_links.py [--set crossref|crossref-hard|crossref-docs|main|all]

crossref-docs asks questions whose answer is in another document (the BNSS citing sections of the BNS),
twice: searching the document the reader is in, and searching every document.

For each question, three ways to fill the passages a reader sees:
  top 5            the search's best five
  top 10           the search's best ten: more passages, no links
  top 5 + links    the best five, then up to five passages they link to (a figure's key, the table or
                   section they cite, the passage sharing a unit number), in rank order: the same ten slots,
                   spent on what the document points at instead of on the next search results
for keywords only, the app (rule-cut passages, local model) and the generative setup (model-written context,
API embeddings). A hit is the expected phrase in the document's own words on the expected page. Also reports
how many passages and tokens a reader goes through.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))
from app.config import settings  # noqa: E402
from app.llm import local, voyage  # noqa: E402

KIND_ORDER = {"key": 0, "ref": 1, "shared": 2}
DIR_ORDER = {"out": 0, "shared": 1, "in": 2}
OUT = ROOT / "scripts" / "benchmarks" / "links-eval.json"


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def questions(c, which: str) -> list[dict]:
    qs = []
    for setname, fname in (("crossref", "crossref.json"), ("crossref-hard", "crossref-hard.json"), ("crossref-docs", "crossref-docs.json")):
        if which not in (setname, "both", "all") or not (ROOT / "scripts" / "benchmarks" / fname).exists():
            continue
        for q in json.loads((ROOT / "scripts" / "benchmarks" / fname).read_text())["questions"]:
            d = c.execute("select id::text from documents where name = %s and status = 'ready'", (q["doc"],)).fetchone()
            a = c.execute("select id::text from documents where name = %s and status = 'ready'", (q["answer_doc"],)).fetchone() if q.get("answer_doc") else None
            if d:
                q = {**q, "answer_doc_id": a["id"] if a else None}
                qs.append({**q, "doc_id": d["id"], "set": setname})
                if setname == "crossref-docs":
                    qs.append({**q, "doc_id": None, "set": "crossref-docs, all documents"})
    if which in ("main", "both", "all"):
        for r in c.execute("""select q.document_id::text as doc_id, d.name as doc, q.question, q.must_contain, q.expected_page
                                from eval_questions q join documents d on d.id = q.document_id where d.status = 'ready'""").fetchall():
            qs.append({**r, "set": "main"})
    return qs


def search(c, fn: str, q: str, vec, strategy: str, doc: str, k: int) -> list[dict]:
    v = None if vec is None else "[" + ",".join(f"{x:.6f}" for x in vec) + "]"
    return c.execute(f"""select h.id::text as id, h.document_id::text as document_id, h.raw_text, h.page_start, h.page_end, h.metadata, c.token_count
                           from {fn}(%s, %s::vector, %s, %s::uuid, %s, 60, 1, %s) h join chunks c on c.id = h.id
                          order by h.rrf_score desc""", (q, v, strategy, doc, k, 0 if vec is None else 1)).fetchall()


_NAMED = re.compile(r"\b(section|table|figure|fig\.?|annex|appendix|step|note)s?\s+(\d{1,3}(?:\.\d{1,3})*[A-Z]?|[A-Z])\b", re.I)


def named(q: str) -> list[re.Pattern]:
    """The sections, tables and figures a question names, as the search route matches them against link labels."""
    words = {"fig": "figure", "fig.": "figure", "appendix": "annex"}
    return [re.compile(rf"\b{words.get(m.group(1).lower(), m.group(1).lower())}\s+{re.escape(m.group(2))}(?![\w.])", re.I)
            for m in _NAMED.finditer(q)]


def expand(c, hits: list[dict], q: str = "", vec=None, which: str | None = None, extra: int = 5) -> list[dict]:
    """Every passage the top hits link to, ranked against the question (rank_linked), the best `extra` kept. Links whose
    label names a section, table or figure the question names come first, as in the search route."""
    have = {h["id"] for h in hits}
    ids = list(dict.fromkeys(l["id"] for h in hits for l in h["metadata"].get("links", []) if l.get("id") and l["id"] not in have))
    if not ids:
        return []
    v = None if vec is None else "[" + ",".join(f"{x:.6f}" for x in vec) + "]"
    ranked = c.execute("""select id::text as id, document_id::text as document_id, raw_text, page_start, page_end, metadata, token_count
                            from rank_linked(%s::uuid[], %s, %s::vector, %s::vector, %s)""",
                       (ids, q, v if which == "loc" else None, v if which == "api" else None, len(ids))).fetchall()
    labels = {l["id"]: l["label"] for h in hits for l in h["metadata"].get("links", []) if l.get("id")}
    pats = named(q)
    first = [r for r in ranked if any(p.search(labels.get(r["id"], "")) for p in pats)]
    return (first + [r for r in ranked if r not in first])[:extra]


def hit(rows: list[dict], q: dict) -> bool:
    n = norm(q["must_contain"])
    return any(n in norm(r["raw_text"]) and (q["expected_page"] is None or r["page_start"] <= q["expected_page"] <= r["page_end"])
               and (not q.get("answer_doc_id") or r["document_id"] == q["answer_doc_id"]) for r in rows)


def main(which: str) -> None:
    with psycopg.connect(settings.database_url, autocommit=True, row_factory=dict_row) as c:
        qs = questions(c, which)
        api = voyage.embed([q["question"] for q in qs], input_type="query")
        loc = [local.embed_query(q["question"]) for q in qs]
        setups = [("Keywords only", "hybrid_search", "structural", None),
                  ("The app (local model)", "hybrid_search_local", "structural", "loc"),
                  ("Generative AI", "hybrid_search", "contextual", "api")]
        res: dict = {}
        for name, fn, strat, vk in setups:
            for i, q in enumerate(qs):
                vec = None if vk is None else (loc[i] if vk == "loc" else api[i])
                top10 = search(c, fn, q["question"], vec, strat, q["doc_id"], 10)
                top5 = top10[:5]
                linked = expand(c, top5, q["question"], vec, vk)
                for way, rows in (("top 5", top5), ("top 10", top10), ("top 5 + links", top5 + linked)):
                    r = res.setdefault((q["set"], name, way), {"n": 0, "hits": 0, "passages": 0, "tokens": 0})
                    r["n"] += 1
                    r["hits"] += hit(rows, q)
                    r["passages"] += len(rows)
                    r["tokens"] += sum(x["token_count"] or 0 for x in rows)
    out = []
    for (st, name, way), r in res.items():
        out.append({"set": st, "setup": name, "way": way, "recall": round(r["hits"] / r["n"], 3), "questions": r["n"],
                    "passages": round(r["passages"] / r["n"], 1), "tokens": round(r["tokens"] / r["n"])})
    OUT.write_text(json.dumps(out, indent=2) + "\n")
    for st in sorted({o["set"] for o in out}):
        print(f"\n{st} ({out[[o['set'] for o in out].index(st)]['questions']} questions)")
        print(f"  {'setup':24} {'way':15} {'answer found':>12} {'passages':>9} {'tokens':>7}")
        for o in [o for o in out if o["set"] == st]:
            print(f"  {o['setup']:24} {o['way']:15} {o['recall'] * 100:11.0f}% {o['passages']:9} {o['tokens']:7,}")
    print(f"\nwrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default="all", choices=["crossref", "crossref-hard", "crossref-docs", "main", "both", "all"])
    main(ap.parse_args().set)
