#!/usr/bin/env python3
"""Ask the hand-written questions in scripts/benchmarks/real-docs.json of the local app (pure mode) and say where
each answer turned up: in the top five, only under a result as a linked passage, or nowhere.

    cd worker && .venv/bin/python ../scripts/ingest_pure.py ../samples/real-test/*.pdf
    .venv/bin/python ../scripts/test_real_docs.py [--base http://localhost:3001]
"""
from __future__ import annotations

import argparse
import json
import re
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def call(base: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def main(base: str, file: str) -> None:
    qs = json.loads((ROOT / "scripts" / "benchmarks" / file).read_text())["questions"]
    ids = {d["name"]: d["id"] for d in call(base, "/api/documents")["documents"]}
    tally = {"top 5": 0, "linked": 0, "missed": 0}
    for q in qs:
        time.sleep(2.1)                                  # the search route allows 30 a minute
        res = call(base, "/api/search", {"query": q["question"], "document_id": ids[q["doc"]], "mode": "pure"})["results"]
        want, doc = norm(q["must_contain"]), ids[q.get("answer_doc", q["doc"])]
        also = norm(q.get("also", ""))                    # a second phrase the same passage must hold, for a short answer
        ok = lambda t: want in norm(t) and also in norm(t)
        rank = next((i + 1 for i, r in enumerate(res[:5]) if r["document_id"] == doc and ok(r["raw_text"])), None)
        link = next((l for r in res[:5] for l in r.get("linked") or [] if l["document_id"] == doc and ok(l["raw_text"])), None)
        where = f"top 5 (#{rank})" if rank else f"linked: {link['label']}" if link else "missed"
        tally["top 5" if rank else "linked" if link else "missed"] += 1
        print(f"  {where:28} {q['kind']:24} {q['question'][:80]}")
    n = len(qs)
    print(f"\n{n} questions: {tally['top 5']} in the top five, {tally['linked']} only as a linked passage, {tally['missed']} missed")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:3001")
    ap.add_argument("--file", default="real-docs.json", help="the question set in scripts/benchmarks")
    a = ap.parse_args()
    main(a.base, a.file)
