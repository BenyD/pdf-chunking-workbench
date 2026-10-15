#!/usr/bin/env python3
"""Check a company SOP, requirement by requirement, against 21 CFR Part 211, and say why a gap is a gap.

    cd worker
    .venv/bin/python ../scripts/gap_check.py --sop "SOP-QC-014" --sections 211.137 211.166 211.170

1. The regulation is read from the official eCFR XML (scripts/regulations/21cfr211.xml, fetched from
   https://www.ecfr.gov/api/versioner/v1/full/<date>/title-21.xml?part=211). Every paragraph carries its
   own marker, (a), (1), (i), (A), so each sentence that imposes something becomes one requirement with its
   exact citation, e.g. 211.170(b)(1), and the lead-in of its parents as context ("The written program shall
   be followed and shall include: (2) Storage conditions for samples retained for testing").
2. Each requirement is searched for in the SOP with the app's own search (keywords and meaning, fused),
   which returns the three closest SOP passages.
3. Two judges, side by side:
   rules  no model. A requirement aimed at products the SOP's scope excludes is "not applicable"; most of its
          distinctive terms present in one passage is "met"; almost none present is "not met", and the reason
          names the terms that are missing. Everything in between is left "unsure".
   model  a small model reads the requirement and the three passages and returns met, partly met, not met or
          not applicable, a quote from the SOP, and one sentence saying why.
4. Both are scored against the gaps the sample SOP was written with (EXPECTED below), and the model cost is
   measured, so the bill for thousands of SOPs is arithmetic, not a guess.
"""
from __future__ import annotations

import argparse
import asyncio
import html
import json
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

from app.config import settings  # noqa: E402
from app.llm import claude, voyage  # noqa: E402

XML = ROOT / "scripts" / "regulations" / "21cfr211.xml"
OUT = ROOT / "scripts" / "benchmarks" / "gap-check.json"
WEB_OUT = ROOT / "web" / "src" / "data" / "gap-check.json"
PRICE = {"claude-haiku-5-5": (0.10, 0.50), "claude-sonnet-5-5": (2.0, 10.0), "claude-opus-5-5": (4.0, 20.0)}   # $ per million in/out, read 2026-10-15

# What the sample SOP (samples/generate/make_samples.py, SOP_SECTIONS) was written to do. Citations not listed
# are lead-ins with nothing to check.
EXPECTED = {
    "211.137(a)": "met", "211.137(b)": "met", "211.137(c)": "not_applicable", "211.137(d)": "met",
    "211.137(e)": "not_applicable", "211.137(f)": "not_applicable",
    "211.137(g), sentence 1": "not_applicable", "211.137(g), sentence 2": "not_applicable", "211.137(h)": "not_applicable",
    "211.166(a), sentence 1": "met", "211.166(a), sentence 2": "met", "211.166(a), sentence 3": "met",
    "211.166(a)(1)": "met", "211.166(a)(2)": "met", "211.166(a)(3)": "met", "211.166(a)(4)": "met", "211.166(a)(5)": "not_applicable",
    "211.166(b), sentence 1": "met",
    "211.166(b), sentence 2": "partly_met",     # tentative expiry from accelerated data, without saying full studies are running
    "211.166(b), sentence 3": "not_met",        # never says the study continues until the tentative date is verified
    "211.166(c)(1)": "not_applicable", "211.166(c)(2)": "not_applicable", "211.166(d)": "not_applicable",
    "211.170(a), sentence 1": "not_met",        # no reserve samples of active ingredients at all
    "211.170(a), sentence 2": "not_met",
    "211.170(a)(1)": "not_met", "211.170(a)(2)": "not_applicable", "211.170(a)(2)(i)": "not_applicable",
    "211.170(a)(2)(ii)": "not_applicable", "211.170(a)(3)": "not_applicable",
    "211.170(b), sentence 1": "met", "211.170(b), sentence 2": "met", "211.170(b), sentence 3": "met",
    "211.170(b), sentence 4": "not_met",        # no yearly visual examination
    "211.170(b), sentence 5": "not_met",        # so no investigation of deterioration found by it
    "211.170(b), sentence 6": "not_met",        # nor a record of the examination
    "211.170(b)(1)": "partly_met",              # six months after expiry, where the rule says one year (a shorter period)
    "211.170(b)(2)": "not_applicable", "211.170(b)(2)(i)": "not_applicable", "211.170(b)(2)(ii)": "not_applicable",
    "211.170(b)(3)": "not_applicable",
}

# ---------------------------------------------------------------------------
# 1. the regulation, one requirement per citation
# ---------------------------------------------------------------------------

ROMAN = {"i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"}
_MARK = re.compile(r"^\s*\(([0-9]+|[a-z]{1,4}|[A-Z])\)\s*")
_SENT = re.compile(r"(?<=[.;])\s+(?=[A-Z(])")
_OBLIGES = re.compile(r"\b(shall|must|is required|are required|exempt|may)\b", re.I)


@dataclass
class Requirement:
    cite: str
    section: str
    section_title: str
    text: str                       # the paragraph's own words
    context: str                    # section title and the lead-ins of its parents
    sentences: list[str] = field(default_factory=list)
    paragraph: str = ""             # the whole paragraph a sentence came from, so it is never judged out of context


def _level(marker: str, depth: int) -> int:
    if marker.isdigit():
        return 2
    if marker.isupper():
        return 4
    if marker in ROMAN and depth >= 2:          # (i) after a numbered paragraph is roman; after (h) it is a letter
        return 3
    return 1


def read_part(xml_path: Path = XML) -> list[Requirement]:
    root = ET.fromstring(xml_path.read_text())
    out: list[Requirement] = []
    for sec in root.iter("DIV8"):
        num = sec.get("N")
        title = html.unescape("".join(sec.find("HEAD").itertext())).replace("§", "").strip()
        stack: list[tuple[int, str, str]] = []          # (level, marker, lead-in text)
        for p in sec.findall("P"):
            raw = html.unescape("".join(p.itertext())).strip()
            markers, rest = [], raw
            while (m := _MARK.match(rest)):
                markers.append(m.group(1))
                rest = rest[m.end():]
            if not markers:                              # an unmarked paragraph continues the one before it
                if out and out[-1].section == num:
                    out[-1].text += " " + raw
                continue
            for mk in markers:
                lvl = _level(mk, len(stack) and stack[-1][0] or 0)
                while stack and stack[-1][0] >= lvl:
                    stack.pop()
                stack.append((lvl, mk, ""))
            cite = num + "".join(f"({mk})" for _, mk, _ in stack)
            lead = " > ".join(t for _, _, t in stack[:-1] if t)
            stack[-1] = (stack[-1][0], stack[-1][1], rest if len(rest) < 400 else rest[:400] + "...")
            out.append(Requirement(cite, num, title, rest, f"{title}" + (f" > {lead}" if lead else "")))
    for r in out:
        r.sentences = split_sentences(r.text)
    return out


_ABBREV = re.compile(r"(?:\b(?:[A-Z]\.){1,3}|\b(?:No|Nos|Fig|Sec|Secs|e\.g|i\.e|etc|Inc|Co|vs)\.)$")


def split_sentences(text: str) -> list[str]:
    """Sentences, without breaking after U.S., No., e.g. and the like."""
    out: list[str] = []
    for piece in _SENT.split(text):
        piece = piece.strip()
        if not piece:
            continue
        if out and _ABBREV.search(out[-1]):
            out[-1] += " " + piece
        else:
            out.append(piece)
    return out


def units(reqs: list[Requirement]) -> list[Requirement]:
    """Line by line. Each sentence of a paragraph that obliges, permits or exempts anything is checked on its own
    and cited by its sentence ("211.170(b), sentence 4"), including the declarative ones ("The reserve sample
    consists of at least twice the quantity..."). A list item with no verb of its own ("(2) Storage conditions
    for samples retained for testing;") is checked because its parent's lead-in ("... shall include:") obliges
    it. A sentence that only introduces the items under it ("The retention time is as follows:") is left out."""
    out: list[Requirement] = []
    for r in reqs:
        if not (_OBLIGES.search(r.text) or _OBLIGES.search(r.context)):
            continue
        keep = [(i, s) for i, s in enumerate(r.sentences, 1) if not re.search(r"(as follows|retained for):\s*$", s)
                or len(r.sentences) == 1 and _OBLIGES.search(s) and not s.endswith("as follows:")]
        many = len(keep) > 1
        for i, s in keep:
            out.append(Requirement(f"{r.cite}, sentence {i}" if many else r.cite, r.section, r.section_title, s, r.context,
                                   paragraph=r.text if many else ""))
    return out


# ---------------------------------------------------------------------------
# 2. search the SOP
# ---------------------------------------------------------------------------

def _conn():
    return psycopg.connect(settings.database_url, autocommit=True)


def find_sop(name_part: str) -> tuple[str, str]:
    with _conn() as c:
        row = c.execute("select id::text, name from documents where name ilike %s and status = 'ready' order by created_at desc limit 1",
                        (f"%{name_part}%",)).fetchone()
    if not row:
        raise SystemExit(f"no ready document matches {name_part!r}")
    return row


def search(doc_id: str, query: str, emb: list[float], strategy: str, k: int = 3) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            """select raw_text, page_start, chunk_type from hybrid_search(%s, %s::vector, %s, %s::uuid, %s)
                where chunk_type <> 'table_row'""",
            (query, "[" + ",".join(f"{x:.6f}" for x in emb) + "]", strategy, doc_id, k),
        ).fetchall()
    return [{"text": r[0], "page": r[1], "type": r[2]} for r in rows]


def sop_scope_exclusions(doc_id: str, strategy: str) -> str:
    with _conn() as c:
        rows = c.execute("select raw_text from chunks where document_id = %s and strategy = %s and raw_text ~* 'does not apply|not applicable|excluded'",
                         (doc_id, strategy)).fetchall()
    return " ".join(r[0] for r in rows).lower()


# ---------------------------------------------------------------------------
# 3a. the rules judge: no model
# ---------------------------------------------------------------------------

STOP = set("""a an and are as at be been by for from has have in is it its of on or such that the their there these this those to
was were which with within shall must may each any all other than not under into upon used use when where whether would should
written procedure procedures section paragraph part chapter described accordance appropriate appropriately following follows
including include includes established adequate requirements requirement""".split())
PRODUCT_CLASSES = {"homeopathic": "homeopathic", "allergenic": "allergenic", "radioactive": "radioactive",
                   "investigational": "investigational", "reconstitut": "reconstituted", "sterile": "sterile",
                   "otc": "otc"}


def _terms(text: str) -> list[str]:
    words = re.findall(r"[a-z][a-z\-]{3,}|\d+(?:\.\d+)?", text.lower())
    seen: list[str] = []
    for w in words:
        if w not in STOP and w not in seen:
            seen.append(w)
    return seen


def _has(term: str, text: str) -> bool:
    stem = term[:6] if len(term) > 6 else term
    return re.search(rf"\b{re.escape(stem)}", text) is not None


def rules_judge(req: Requirement, passages: list[dict], exclusions: str) -> tuple[str, str]:
    body = req.text.lower()
    for key, word in PRODUCT_CLASSES.items():
        if re.search(rf"\b{key}", body) and re.search(rf"\b{key}", exclusions):
            return "not_applicable", f"The SOP's scope excludes {word} products."
    terms = _terms(req.text)
    if not terms:
        return "unsure", "Nothing distinctive to look for."
    best, best_missing = 0.0, terms
    for p in passages:
        t = p["text"].lower()
        missing = [w for w in terms if not _has(w, t)]
        cover = 1 - len(missing) / len(terms)
        if cover > best:
            best, best_missing = cover, missing
    if best >= 0.7:
        return "met", f"One passage holds {round(best * 100)}% of the requirement's terms."
    if best <= 0.25:
        return "not_met", "No SOP passage mentions " + ", ".join(best_missing[:6]) + "."
    return "unsure", f"The closest passage holds {round(best * 100)}% of the terms; missing: " + ", ".join(best_missing[:5]) + "."


# ---------------------------------------------------------------------------
# 3b. the model judge
# ---------------------------------------------------------------------------

JUDGE_SYSTEM = (
    "You check a company's standard operating procedure (SOP) against one requirement of US FDA 21 CFR Part 211. "
    "Use only the SOP passages given; do not assume anything they do not say. Decide: "
    "met (the SOP clearly does what the requirement asks), partly_met (some of it is there, or it is there but weaker, "
    "e.g. a shorter period or fewer samples than required), not_met (the SOP does not address it), or not_applicable "
    "(the requirement is for products or situations the SOP's stated scope excludes, or it only applies under a condition "
    "the SOP rules out, such as products exempt from expiry dating when the SOP dates every product). Quote the SOP words you relied on, "
    "exactly, or leave the quote empty. Give the reason in one plain sentence a QA reviewer would write."
)
JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["met", "partly_met", "not_met", "not_applicable"]},
        "quote": {"type": "string"},
        "reason": {"type": "string"},
    },
    "required": ["status", "quote", "reason"],
    "additionalProperties": False,
}


async def model_judge(req: Requirement, passages: list[dict], scope: str, usage: dict, model: str) -> dict:
    para = f"\nThe whole paragraph, for context only: {req.paragraph}\n" if req.paragraph else ""
    msg = (f"Requirement {req.cite} ({req.context}):{para}\nCheck only this: {req.text}\n\nSOP scope: {scope or 'not stated'}\n\nSOP passages:\n"
           + "\n\n".join(f"[page {p['page']}] {p['text']}" for p in passages))
    resp = await claude.client().messages.create(
        # No thinking on either: Haiku takes "disabled"; Sonnet 5.5 asks for "between_tools" to mean the same here.
        model=model, max_tokens=400, thinking={"type": "disabled" if "haiku" in model else "between_tools"}, system=JUDGE_SYSTEM,
        output_config={"format": {"type": "json_schema", "schema": JUDGE_SCHEMA}},
        messages=[{"role": "user", "content": msg}],
    )
    usage["in"] += resp.usage.input_tokens
    usage["out"] += resp.usage.output_tokens
    usage["calls"] += 1
    try:
        return json.loads("".join(b.text for b in resp.content if b.type == "text"))
    except json.JSONDecodeError:
        return {"status": "unsure", "quote": "", "reason": "The model's reply could not be read."}


# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------

async def run(sop: str, sections: list[str], strategy: str, model: str) -> None:
    doc_id, doc_name = find_sop(sop)
    reqs = units([r for r in read_part() if r.section in sections])
    print(f"{doc_name}: {len(reqs)} requirements in {', '.join(sections)}")
    queries = [f"{r.section_title}. {r.text}" for r in reqs]
    embs = voyage.embed(queries, input_type="query")
    exclusions = sop_scope_exclusions(doc_id, strategy)
    with _conn() as c:
        scope_row = c.execute("select raw_text from chunks where document_id = %s and strategy = %s and raw_text ilike %s limit 1",
                              (doc_id, strategy, "%applies to%")).fetchone()
    scope = scope_row[0] if scope_row else ""

    usage = {"in": 0, "out": 0, "calls": 0}
    sem = asyncio.Semaphore(6)
    rows: list[dict] = []

    async def one(r: Requirement, q: str, e: list[float]) -> dict:
        passages = search(doc_id, q, e, strategy)
        rs, rr = rules_judge(r, passages, exclusions)
        async with sem:
            m = await model_judge(r, passages, scope, usage, model)
        return {"cite": r.cite, "section_title": r.section_title, "context": r.context, "text": r.text,
                "passages": [{"page": p["page"], "text": p["text"][:600]} for p in passages],
                "rules": {"status": rs, "reason": rr}, "model": m, "expected": EXPECTED.get(r.cite)}

    rows = await asyncio.gather(*(one(r, q, e) for r, q, e in zip(reqs, queries, embs)))

    graded = [x for x in rows if x["expected"]]
    def score(key: str) -> dict:
        decided = [x for x in graded if x[key]["status"] != "unsure"]
        right = [x for x in decided if x[key]["status"] == x["expected"]
                 or (x["expected"] == "partly_met" and x[key]["status"] in ("partly_met", "not_met") and key == "rules")]
        return {"graded": len(graded), "decided": len(decided), "right": len(right),
                "unsure": len(graded) - len(decided)}
    cost = (usage["in"] * PRICE[model][0] + usage["out"] * PRICE[model][1]) / 1e6
    report = {
        "sop": doc_name.rsplit(".", 1)[0], "regulation": "21 CFR Part 211", "regulation_as_of": "2026-10-13",
        "sections": sections, "requirements": len(rows), "rules_score": score("rules"), "model_score": score("model"),
        "model_usage": {**usage, "model": model, "dollars": round(cost, 5), "dollars_per_requirement": round(cost / max(1, usage["calls"]), 6)},
        "rows": rows,
    }
    # Keep the score of every model run so far, so the page can compare them; the rows are this run's.
    models: dict[str, dict] = {}
    if OUT.exists():
        try:
            models = {m["model"]: m for m in json.loads(OUT.read_text()).get("models", [])}
        except (json.JSONDecodeError, KeyError):
            models = {}
    models[model] = {"model": model, **report["model_score"], "dollars": report["model_usage"]["dollars"], "calls": usage["calls"]}
    report["models"] = sorted(models.values(), key=lambda m: m["dollars"])
    for path in (OUT, WEB_OUT):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")

    print(f"\n{'citation':20} {'expected':15} {'rules':15} {'model':15}")
    for x in rows:
        print(f"{x['cite']:20} {str(x['expected']):15} {x['rules']['status']:15} {x['model']['status']:15}")
    print("\nrules:", report["rules_score"], "\nmodel:", report["model_score"])
    print(f"model: {usage['calls']} calls, {usage['in']:,} in / {usage['out']:,} out tokens, ${cost:.4f}")
    print(f"wrote {OUT.relative_to(ROOT)} and {WEB_OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sop", default="SOP-QC-014")
    ap.add_argument("--sections", nargs="+", default=["211.137", "211.166", "211.170"])
    ap.add_argument("--strategy", default="contextual", help="which chunks of the SOP to search")
    ap.add_argument("--model", default="claude-haiku-5-5", choices=["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"])
    ap.add_argument("--list", action="store_true", help="print the requirements of the sections and stop")
    a = ap.parse_args()
    if a.list:
        for r in read_part():
            if r.section in a.sections:
                print(f"{r.cite:22} {r.text[:110]}")
        raise SystemExit(0)
    asyncio.run(run(a.sop, a.sections, a.strategy, a.model))
