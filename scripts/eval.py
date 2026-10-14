#!/usr/bin/env python3
"""Recall@k for the built-in question sets, through the running web app.

    python3 scripts/eval.py            # against http://localhost:3001
    python3 scripts/eval.py https://your-deployment.vercel.app 5

A question counts as found when one of the top-k passages contains the
expected phrase. The numbers are what to quote when asked "how good is it".
"""
import json
import sys
import urllib.request

base = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3001").rstrip("/")
k = int(sys.argv[2]) if len(sys.argv) > 2 else 5


def get(path):
    with urllib.request.urlopen(base + path) as r:
        return json.load(r)


def post(path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


docs = get("/api/documents")
docs = docs.get("documents", docs)
rows = []
for d in docs:
    if d["status"] != "ready":
        continue
    qs = get(f"/api/eval/questions?document_id={d['id']}")["questions"]
    if not qs:
        continue
    r = post("/api/eval/run", {"document_id": d["id"], "k": k})
    s = r["summary"][0]
    rows.append((d["name"].replace(".pdf", ""), s["total"], s["recall_at_k"], s["mrr"]))
    for row in r["rows"]:
        rank = row["hits"][0]["rank"]
        if rank is None:
            print(f"  missed: {row['question']}  (expected '{row['must_contain']}')")

print(f"\n{'Document':44} {'questions':>9} {'recall@' + str(k):>9} {'MRR':>6}")
for name, n, rec, mrr in rows:
    print(f"{name[:44]:44} {n:>9} {rec:>9.0%} {mrr:>6.2f}")
