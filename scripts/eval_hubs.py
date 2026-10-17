#!/usr/bin/env python3
"""How often do passages with almost no text of their own (contents entries, stray fragments) crowd the top five?

    cd worker && .venv/bin/python ../scripts/eval_hubs.py --label before   # or --label after
    cd worker && .venv/bin/python ../scripts/eval_hubs.py --base https://quescenta-demo.vercel.app --label prod-before

A small embedding model scores a short or list-like passage close to many unrelated questions: "15. Documentation
115 General 115 ..." from a contents page, a lone "A", a figure whose only text is "Figure J". Such passages are
hubs: they come first for questions they do not answer. This runs every main benchmark question through the app's
pure-mode search (hybrid_search_local: rule-cut passages, local model) twice, inside the question's own document
and across all documents, and counts in the top five:

  contents      a text passage at least half made of contents entries ("Title ... page number")
  _is_toc       what references.py's _is_toc flags (the rule the reference links use)
  under 40      a text or figure passage under 40 characters
  Hindi         for a question asked in English, a passage written mostly in an Indian script, which the
                English-only model cannot read (a Hindi question finding Hindi passages is not counted)
  hit           the expected phrase in the document's own words on the expected page, in the right document

Each run is saved under its label in scripts/benchmarks/hubs-eval.json; with both a "before" and an "after" run
saved (or "prod-before" and "prod-after"), the comparison and every question whose rank changed are printed.
With --base, the questions and the search go through a running app's API (/api/eval/questions, /api/search in
mode "pure"), paced under the search route's 30-a-minute limit, so production can be measured without its
database password.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.request
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))
from app.chunk.references import _is_toc  # noqa: E402
from app.config import settings  # noqa: E402
from app.llm import local  # noqa: E402

OUT = ROOT / "scripts" / "benchmarks" / "hubs-eval.json"
K = 5
SHORT = 40
# a contents entry: a title starting with a capital, with no digit or full stop, then the page it starts on, then
# the next entry or the end. The same pattern as own_text_length() in the 20261019000000 migration.
ENTRY = re.compile(r"[A-Z][^\n.0-9]{1,120}?\s[0-9]{1,3}(?=\s+[A-Z0-9]|\s*$)")


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


INDIC = re.compile(r"[\u0900-\u0D7F]")


def is_indic(text: str) -> bool:
    return len(INDIC.findall(text)) > len(re.findall(r"[A-Za-z]", text))


def is_contents(chunk_type: str, text: str) -> bool:
    t = re.sub(r"\s+", " ", text).strip()
    return chunk_type == "text" and bool(t) and sum(len(m) for m in ENTRY.findall(t)) >= len(t) / 2


def db_source():
    """The questions and a search function, straight from the local database."""
    c = psycopg.connect(settings.database_url, autocommit=True, row_factory=dict_row)
    qs = c.execute("""select q.document_id::text as doc_id, d.name as doc, q.question, q.must_contain, q.expected_page
                        from eval_questions q join documents d on d.id = q.document_id
                       where d.status = 'ready' order by d.name, q.created_at""").fetchall()

    def search(question: str, doc: str | None) -> list[dict]:
        v = "[" + ",".join(f"{x:.6f}" for x in local.embed_query(question)) + "]"
        return c.execute("""select h.document_id::text as doc_id, h.chunk_type, h.raw_text, h.page_start, h.page_end
                              from hybrid_search_local(%s, %s::vector, 'structural', %s::uuid, %s, 60, 1, 1) h
                             order by h.rrf_score desc""", (question, v, doc, K)).fetchall()
    return qs, search


def http_source(base: str):
    """The same through a running app's API, two seconds apart."""
    def call(path: str, body: dict | None = None) -> dict:
        req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)
    names = {d["id"]: d["name"] for d in call("/api/documents")["documents"] if d["status"] == "ready"}
    qs = sorted(({"doc_id": q["document_id"], "doc": names[q["document_id"]], "question": q["question"],
                  "must_contain": q["must_contain"], "expected_page": q["expected_page"], "created_at": q["created_at"]}
                 for q in call("/api/eval/questions")["questions"] if q["document_id"] in names),
                key=lambda q: (q["doc"], q["created_at"]))

    def search(question: str, doc: str | None) -> list[dict]:
        time.sleep(2.1)
        res = call("/api/search", {"query": question, "document_id": doc, "k": K, "mode": "pure"})["results"]
        return [{**r, "doc_id": r["document_id"]} for r in res]
    return qs, search


def run(base: str | None) -> dict:
    qs, search = http_source(base.rstrip("/")) if base else db_source()
    per_q, totals = [], {}
    for q in qs:
        entry = {"doc": q["doc"], "question": q["question"], "ranks": {}}
        for scope, doc in (("document", q["doc_id"]), ("all", None)):
            rows = search(q["question"], doc)
            t = totals.setdefault(scope, {"questions": 0, "hits": 0, "rr": 0.0, "contents": 0, "is_toc": 0, "short": 0,
                                          "q_contents": 0, "q_short": 0, "first_contents": 0, "first_short": 0,
                                          "indic": 0, "q_indic": 0, "first_indic": 0})
            rank = None
            for i, r in enumerate(rows):
                if rank is None and r["doc_id"] == q["doc_id"] and norm(q["must_contain"]) in norm(r["raw_text"]) \
                        and (q["expected_page"] is None or r["page_start"] <= q["expected_page"] <= r["page_end"]):
                    rank = i + 1
            flags = [(is_contents(r["chunk_type"], r["raw_text"]), _is_toc(SimpleNamespace(raw_text=r["raw_text"])),
                      r["chunk_type"] in ("text", "figure") and len(r["raw_text"].strip()) < SHORT,
                      is_indic(r["raw_text"]) and not INDIC.search(q["question"])) for r in rows]
            t["questions"] += 1
            t["hits"] += rank is not None
            t["rr"] += 1 / rank if rank else 0
            t["contents"] += sum(f[0] for f in flags)
            t["is_toc"] += sum(f[1] for f in flags)
            t["short"] += sum(f[2] for f in flags)
            t["q_contents"] += any(f[0] for f in flags)
            t["q_short"] += any(f[2] for f in flags)
            t["first_contents"] += bool(flags) and flags[0][0] and rank != 1
            t["first_short"] += bool(flags) and flags[0][2] and rank != 1
            t["indic"] += sum(f[3] for f in flags)
            t["q_indic"] += any(f[3] for f in flags)
            t["first_indic"] += bool(flags) and flags[0][3] and rank != 1
            entry["ranks"][scope] = rank
        per_q.append(entry)
    for t in totals.values():
        t["recall"] = round(t["hits"] / t["questions"], 3)
        t["mrr"] = round(t.pop("rr") / t["questions"], 3)
    return {"date": date.today().isoformat(), "k": K, "source": base or "local database", "totals": totals, "per_question": per_q}


def show(saved: dict, pair: tuple[str, str]) -> None:
    labels = [l for l in pair if l in saved] or list(saved)
    for scope in ("document", "all"):
        print(f"\n{'in the question’s own document' if scope == 'document' else 'across all documents'}, top {K}")
        w = max(len(l) for l in labels) + 2
        print(f"  {'':34}" + "".join(f"{l:>{w}}" for l in labels))
        rows = [("recall@5", lambda t: f"{t['recall'] * 100:.1f}%"), ("MRR", lambda t: f"{t['mrr']:.3f}"),
                ("contents passages in top 5", lambda t: t["contents"]), ("  questions with one", lambda t: t["q_contents"]),
                ("  ranked first, not the answer", lambda t: t["first_contents"]), ("_is_toc passages in top 5", lambda t: t["is_toc"]),
                (f"under {SHORT} characters in top 5", lambda t: t["short"]), ("  questions with one", lambda t: t["q_short"]),
                ("  ranked first, not the answer", lambda t: t["first_short"]),
                ("Hindi passages, English questions", lambda t: t.get("indic", "")), ("  questions with one", lambda t: t.get("q_indic", "")),
                ("  ranked first, not the answer", lambda t: t.get("first_indic", ""))]
        for name, f in rows:
            print(f"  {name:34}" + "".join(f"{f(saved[l]['totals'][scope])!s:>{w}}" for l in labels))
    if all(l in saved for l in pair):
        print(f"\nquestions whose rank changed ({pair[0]} -> {pair[1]}; - is not in the top 5)")
        before = {(b["doc"], b["question"]): b for b in saved[pair[0]]["per_question"]}
        for a in saved[pair[1]]["per_question"]:
            b = before.get((a["doc"], a["question"]))
            if not b:
                continue
            for scope in ("document", "all"):
                rb, ra = b["ranks"][scope], a["ranks"][scope]
                if rb != ra:
                    print(f"  {scope:8} {rb or '-'} -> {ra or '-'}  {b['doc'][:28]:28} {b['question'][:90]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", help="save this run under the label (before / after); without it, print what is saved")
    ap.add_argument("--base", help="measure a running app through its API instead of the local database")
    ap.add_argument("--compare", nargs=2, metavar=("BEFORE", "AFTER"), help="the two saved runs to compare")
    args = ap.parse_args()
    saved = json.loads(OUT.read_text()) if OUT.exists() else {}
    if args.label:
        saved[args.label] = run(args.base)
        OUT.write_text(json.dumps(saved, indent=2, ensure_ascii=False) + "\n")
    prod = (args.label or "").startswith("prod") or (not args.label and args.base)
    show(saved, tuple(args.compare) if args.compare else ("prod-before", "prod-after") if prod else ("before", "after"))
