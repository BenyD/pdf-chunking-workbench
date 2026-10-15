#!/usr/bin/env python3
"""Write a labelled question set for every document with Claude, save it, and seed it into the eval table.

    worker/.venv/bin/python scripts/make_questions.py                 # generate for every ready document, save and seed
    worker/.venv/bin/python scripts/make_questions.py --seed          # after a reset: seed the saved sets into the documents again
    worker/.venv/bin/python scripts/make_questions.py --per-doc 12 --model claude-sonnet-5-5 --base http://localhost:3001

How a set is made. Passages are sampled from the document across its pages and its kinds (text, table rows,
whole tables, figures, forms). For each one the model writes a question someone who works with the document
would ask, which that passage answers, and names the shortest exact phrase from the passage (a value, a code,
a name, a date) that the right passage must contain. A phrase that is not in the passage word for word, or
that already appears in the question, is rejected and the model is asked once more. Sets are saved under
scripts/benchmarks/<document>.json so they survive a reset, and scripts/eval.py measures recall@k on them.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "scripts" / "benchmarks"

SCHEMA = {
    "type": "object",
    "properties": {
        "question": {"type": "string", "description": "One question, in plain words, that the passage answers."},
        "must_contain": {"type": "string", "description": "The shortest exact phrase from the passage that the answering passage must contain: a value, code, name, date or term, at most six words, copied word for word."},
        "answer": {"type": "string", "description": "The answer in one short sentence."},
    },
    "required": ["question", "must_contain", "answer"],
    "additionalProperties": False,
}

SYSTEM = (
    "You write evaluation questions for a search system over pharmaceutical, regulatory and legal documents. "
    "You are given one passage from a document, with where it sits. Write one question that someone who works with "
    "this document would ask (a pharmacist, a pricing analyst, a regulatory officer, a QA manager or a lawyer, "
    "whichever fits) and that this passage answers. Ask the way a person would, not by copying the passage's wording, "
    "and make the question specific enough that only this passage answers it: name the product, section, code, "
    "field or condition it concerns. Then pick must_contain: the shortest exact phrase from the passage that the "
    "answering passage must contain, copied word for word from the passage, at most six words, and part of the "
    "answer rather than a word the question already uses. Prefer a value, a code, a name or a date over common words."
)


def key_from_env() -> str:
    k = os.environ.get("ANTHROPIC_API_KEY")
    if k:
        return k
    env = ROOT / "worker" / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("ANTHROPIC_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("ANTHROPIC_API_KEY not set and not in worker/.env")


def http(method: str, url: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"} if body is not None else {})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower().replace(".pdf", "")).strip("-")


def spread(items: list, n: int) -> list:
    """n items evenly spaced through the list, so a set covers the whole document."""
    if n <= 0 or not items:
        return []
    if len(items) <= n:
        return list(items)
    step = len(items) / n
    return [items[int(i * step)] for i in range(n)]


def pick_passages(chunks: list[dict], per_doc: int, rng: random.Random) -> list[dict]:
    """A spread of passages by kind: half text, a quarter table rows, the rest whole tables, figures and forms."""
    by = {k: [] for k in ("text", "table_row", "table", "figure", "record")}
    for c in sorted(chunks, key=lambda c: (c["page_start"], c["ordinal"])):
        t = c["chunk_type"]
        raw = c.get("raw_text") or ""
        if t == "text" and len(raw) >= 200:
            by["text"].append(c)
        elif t == "table_row" and len(re.findall(r"\d", raw)) >= 2:
            by["table_row"].append(c)
        elif t == "table" and len(raw) >= 200:
            by["table"].append(c)
        elif t == "figure" and (c.get("metadata") or {}).get("vision"):
            by["figure"].append(c)
        elif t == "record":
            by["record"].append(c)
    want = {"text": round(per_doc * 0.5), "table_row": round(per_doc * 0.25), "table": max(1, per_doc // 8), "figure": max(1, per_doc // 6), "record": 1}
    out: list[dict] = []
    for kind, n in want.items():
        pool = by[kind]
        rng.shuffle(pool) if kind == "table_row" else None
        out += spread(sorted(pool, key=lambda c: c["ordinal"]) if kind != "table_row" else pool[:max(n * 3, n)], n)
    # top up from text when a kind had too little
    short = per_doc - len(out)
    if short > 0:
        rest = [c for c in by["text"] if c not in out]
        out += spread(rest, short)
    return out[:per_doc]


async def ask(client, model: str, doc_name: str, chunk: dict, feedback: str | None) -> dict | None:
    location = (chunk.get("context") or "").strip()
    text = (chunk.get("raw_text") or "")[:6000]
    prompt = (
        f"<document>{doc_name}</document>\n<location>{location}</location>\n<kind>{chunk['chunk_type']}</kind>\n"
        f"<passage>\n{text}\n</passage>\n\n"
        + (f"Your previous attempt was rejected: {feedback}. Try again.\n\n" if feedback else "")
        + "Write the question, the must_contain phrase and the answer."
    )
    resp = await client.messages.create(
        model=model,
        max_tokens=600,
        system=SYSTEM,
        messages=[{"role": "user", "content": prompt}],
        output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
    )
    if resp.stop_reason == "refusal":
        return None
    txt = "".join(b.text for b in resp.content if b.type == "text")
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        return None


def check(q: dict, chunk: dict) -> str | None:
    """Why a generated question is unusable, or None when it is fine."""
    mc, question = norm(q.get("must_contain", "")), norm(q.get("question", ""))
    if len(mc) < 2 or len(mc.split()) > 6:
        return "must_contain must be one to six words"
    if mc not in norm(chunk.get("raw_text") or ""):
        return "must_contain is not in the passage word for word"
    if mc in question:
        return "must_contain already appears in the question; pick a phrase from the answer instead"
    if len(question) < 15 or "?" not in question:
        return "write one real question"
    return None


async def make_set(client, model: str, doc: dict, chunks: list[dict], per_doc: int, concurrency: int) -> list[dict]:
    rng = random.Random(42)
    passages = pick_passages(chunks, per_doc, rng)
    sem = asyncio.Semaphore(concurrency)
    name = doc["name"].replace(".pdf", "")

    async def one(chunk: dict) -> dict | None:
        async with sem:
            feedback = None
            for _ in range(2):
                q = await ask(client, model, name, chunk, feedback)
                if not q:
                    return None
                feedback = check(q, chunk)
                if feedback is None:
                    return {"question": q["question"].strip(), "must_contain": q["must_contain"].strip(), "expected_page": chunk["page_start"],
                            "answer": q["answer"].strip(), "chunk_type": chunk["chunk_type"]}
            return None

    results = await asyncio.gather(*(one(c) for c in passages))
    return [r for r in results if r]


def all_chunks(base: str, doc_id: str) -> list[dict]:
    out: list[dict] = []
    offset = 0
    while True:
        r = http("GET", f"{base}/api/documents/{doc_id}/chunks?offset={offset}&limit=1000")
        out += r["chunks"]
        if len(r["chunks"]) < 1000:
            return out
        offset += 1000


def seed(base: str, doc: dict, questions: list[dict]) -> int:
    have = {norm(q["question"]) for q in http("GET", f"{base}/api/eval/questions?document_id={doc['id']}")["questions"]}
    n = 0
    for q in questions:
        if norm(q["question"]) in have:
            continue
        http("POST", f"{base}/api/eval/questions", {"document_id": doc["id"], "question": q["question"], "must_contain": q["must_contain"], "expected_page": q["expected_page"]})
        n += 1
    return n


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:3001")
    ap.add_argument("--model", default="claude-sonnet-5-5")
    ap.add_argument("--per-doc", type=int, default=12)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--seed", action="store_true", help="only seed the saved sets into the current documents")
    ap.add_argument("--force", action="store_true", help="regenerate a set that already exists on disk")
    args = ap.parse_args()

    docs = [d for d in http("GET", f"{args.base}/api/documents")["documents"] if d["status"] == "ready"]
    OUT.mkdir(parents=True, exist_ok=True)

    if args.seed:
        for d in docs:
            f = OUT / f"{slug(d['name'])}.json"
            if f.exists():
                n = seed(args.base, d, json.loads(f.read_text())["questions"])
                print(f"{d['name']}: seeded {n}")
        return

    import anthropic
    client = anthropic.AsyncAnthropic(api_key=key_from_env(), max_retries=4, timeout=120.0)
    for d in docs:
        f = OUT / f"{slug(d['name'])}.json"
        if f.exists() and not args.force:
            qs = json.loads(f.read_text())["questions"]
            print(f"{d['name']}: {len(qs)} saved questions, seeding")
        else:
            chunks = all_chunks(args.base, d["id"])
            per = args.per_doc if (d.get("page_count") or 1) > 1 else max(3, args.per_doc // 3)
            qs = await make_set(client, args.model, d, chunks, per, args.concurrency)
            f.write_text(json.dumps({"document": d["name"], "generated": date.today().isoformat(), "model": args.model, "questions": qs}, indent=2, ensure_ascii=False) + "\n")
            kinds = {}
            for q in qs:
                kinds[q["chunk_type"]] = kinds.get(q["chunk_type"], 0) + 1
            print(f"{d['name']}: wrote {len(qs)} questions {kinds}")
        print(f"  seeded {seed(args.base, d, qs)} new")


if __name__ == "__main__":
    asyncio.run(main())
