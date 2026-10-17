#!/usr/bin/env python3
"""Questions whose answer is somewhere other than the passage that matches them.

    cd worker && .venv/bin/python ../scripts/make_crossref_questions.py      # writes scripts/benchmarks/crossref.json

From the links the document itself makes (worker/app/chunk/references.py: "see Table 2", "(5.1)", "See
section 163", a unit number recorded in two places), pairs are drawn: a passage R where a reader starts, and
the passage T it points at. Claude Sonnet writes one question per pair the way a reader of R would ask it,
answered only in T, with a short phrase copied from T as the expected answer. A pair is kept only if that
phrase is in T, is not in R and is not in the question, so R alone cannot answer it. A model writes the test,
never the app's answers.
"""
from __future__ import annotations

import asyncio
import json
import random
import re
import sys
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))
from app.config import settings  # noqa: E402

OUT = ROOT / "scripts" / "benchmarks" / "crossref.json"
OUT_HARD = ROOT / "scripts" / "benchmarks" / "crossref-hard.json"
HARD = "--hard" in sys.argv
STOP = set("""a an and are as at be by can do does for from has have how in is it its may must of on or the their there
this to was what when where which who why will with would should under any each other than shall not be""".split())
PER_DOC = {"Bharatiya Nagarik": 8, "Bharatiya Nyaya": 6, "humira": 8, "who-trs986": 5, "QC Inspection": 3, "Tablet press": 3}
if "--hard" in sys.argv:
    PER_DOC = {k: v * 2 for k, v in PER_DOC.items()}      # the stricter check drops more drafts
SYSTEM = (
    "You write test questions for a document search system. You get passage R, where a reader is, and passage T, "
    "which R refers to (by a figure, table, section or step number, or a shared unit or code). Write ONE question a "
    "reader of R would naturally ask next, phrased from R's subject and wording, whose answer is stated only in T. Then "
    "copy a short phrase (3 to 10 words) from T, exactly as written, that is the answer. The phrase must not appear in R "
    "and must not appear in your question. If no such natural question exists, set skip to true."
)
SYSTEM_HARD = SYSTEM + (
    " Hard mode: the reader has only seen R. Use only R's words and R's subject in the question; do not use any name, "
    "number or term that appears in T but not in R. Refer to T only the way R does (for example 'the table this "
    "section cites', 'what the report decided for the bowl in Figure 1')."
)
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["skip", "question", "answer_phrase"],
          "properties": {"skip": {"type": "boolean"}, "question": {"type": "string"}, "answer_phrase": {"type": "string"}}}


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def pairs() -> list[dict]:
    rng = random.Random(20261017)
    out = []
    with psycopg.connect(settings.database_url, row_factory=dict_row) as c:
        for prefix, n in PER_DOC.items():
            rows = c.execute("""select c.id::text as id, c.raw_text, c.page_start, c.page_end, c.chunk_type, c.metadata, d.name
                                  from chunks c join documents d on d.id = c.document_id
                                 where c.strategy = 'structural' and d.name ilike %s""", (f"%{prefix}%",)).fetchall()
            by_id = {r["id"]: r for r in rows}
            cands = []
            for r in rows:
                for l in r["metadata"].get("links", []):
                    t = by_id.get(l["id"])
                    if t and l["dir"] in ("out", "shared") and l["kind"] in ("ref", "shared", "key") and len(t["raw_text"]) > 60:
                        cands.append((r, t, l))
            rng.shuffle(cands)
            seen_t = set()
            for r, t, l in cands:
                if t["id"] in seen_t:
                    continue
                seen_t.add(t["id"])
                out.append({"doc": r["name"], "R": r, "T": t, "link": l})
                if sum(1 for p in out if p["doc"] == r["name"]) >= n * 2:   # draw twice as many; some get skipped
                    break
    return out


async def main() -> None:
    import anthropic
    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key, max_retries=4)
    ps = pairs()
    sem = asyncio.Semaphore(6)

    async def one(p):
        msg = (f"Passage R (page {p['R']['page_start']}):\n{p['R']['raw_text'][:2500]}\n\n"
               f"R refers to {p['link']['label']}. Passage T (page {p['T']['page_start']}):\n{p['T']['raw_text'][:2500]}")
        async with sem:
            resp = await client.messages.create(model="claude-sonnet-5-5", max_tokens=400, thinking={"type": "between_tools"},
                                                system=SYSTEM_HARD if HARD else SYSTEM, output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
                                                messages=[{"role": "user", "content": msg}])
        try:
            j = json.loads("".join(b.text for b in resp.content if b.type == "text"))
        except json.JSONDecodeError:
            return None
        a, q = j.get("answer_phrase", ""), j.get("question", "")
        if j.get("skip") or not a or norm(a) not in norm(p["T"]["raw_text"]) or norm(a) in norm(p["R"]["raw_text"]) or norm(a) in norm(q):
            return None
        if HARD:
            # the question may not lean on words only T has: at most one content word from T that R lacks
            words = lambda t: {w for w in re.findall(r"[a-z0-9][a-z0-9\-]+", norm(t)) if w not in STOP and len(w) > 2}
            leak = words(q) & (words(p["T"]["raw_text"]) - words(p["R"]["raw_text"]))
            if len(leak) > 1:
                return None
        return {"doc": p["doc"], "question": q, "must_contain": a, "expected_page": p["T"]["page_start"],
                "link": p["link"]["label"], "link_kind": p["link"]["kind"], "from_page": p["R"]["page_start"]}

    got = [x for x in await asyncio.gather(*(one(p) for p in ps)) if x]
    final = []
    for prefix, n in PER_DOC.items():
        final += [g for g in got if prefix.lower() in g["doc"].lower()][:n]
    final = [g for g in final if not re.search(r"\bwhich page\b", g["question"], re.I)]
    out = OUT_HARD if HARD else OUT
    out.write_text(json.dumps({"generated": "2026-10-17", "model": "claude-sonnet-5-5", "hard": HARD, "questions": final}, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(ps)} pairs, {len(got)} kept, {len(final)} written to {out.relative_to(ROOT)}")
    for g in final:
        print(f"  [{g['link_kind']:6} {g['link']:22}] {g['doc'][:22]:22} p{g['from_page']}->p{g['expected_page']}  {g['question'][:90]}")


if __name__ == "__main__":
    asyncio.run(main())
