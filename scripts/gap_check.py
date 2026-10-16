#!/usr/bin/env python3
"""Check company SOPs, requirement by requirement, against 21 CFR Part 211, and say why a gap is a gap.

    cd worker
    .venv/bin/python ../scripts/gap_check.py                                  # the sample SOP, sections chosen for it
    .venv/bin/python ../scripts/gap_check.py --sop SOP-QC-014 SOP-PR-021 --batch   # many SOPs, at half price
    .venv/bin/python ../scripts/gap_check.py --sections 211.137 211.166 211.170    # sections given by hand
    .venv/bin/python ../scripts/gap_check.py --scope-only                     # which sections apply, then stop
    .venv/bin/python ../scripts/gap_check.py --library --batch                # every "SOP-..." document as one library

1. The regulation is read from the official eCFR XML (scripts/regulations/21cfr211.xml, fetched from
   https://www.ecfr.gov/api/versioner/v1/full/<date>/title-21.xml?part=211). Every paragraph carries its
   own marker, (a), (1), (i), (A), so each sentence that imposes something becomes one requirement with its
   exact citation, e.g. 211.170(b)(1), and the lead-in of its parents as context ("The written program shall
   be followed and shall include: (2) Storage conditions for samples retained for testing").
2. Which sections apply to an SOP is measured, not given: every requirement sentence of the Part is embedded
   once, each is compared with every passage of the SOP, and a section is in scope when its two best sentences
   come within SCOPE_THRESHOLD of some passage. Whole sections embedded as one text were tried first and could
   not tell expiry dating from warehousing (DECISIONS section 24).
3. Each requirement is compared with every passage of the SOP, by meaning and by keywords, on the SOP's own
   words only, and the three closest are its evidence. (Not the app's search as it is: that one also ranks by
   the context lines written at ingest, which change with every upload, so a revised SOP would get different
   evidence for lines it never touched.)
4. Two judges, side by side:
   rules  no model. A requirement aimed at products the SOP's scope excludes is "not applicable"; most of its
          distinctive terms present in one passage is "met"; almost none present is "not met", and the reason
          names the terms that are missing. Everything in between is left "unsure".
   model  a small model reads the requirement and the three passages and returns met, partly met, not met or
          not applicable, a quote from the SOP, and one sentence saying why.
5. A verdict is kept in scripts/benchmarks/gap-cache.sqlite under (citation, hash of the SOP words the model
   saw, hash of the model and prompt). A revised SOP, or another site's copy of the same template, only goes
   to the model for the lines whose passages changed. --batch sends the rest through the Message Batches API
   at half price; a run that dies while a batch is out picks the batch up again the next time.
6. The sample SOP is scored against the gaps it was written with (EXPECTED below), and the model cost is
   measured per SOP, so the bill for thousands of SOPs is arithmetic, not a guess.
7. --library checks a company's SOPs as one set. A section is the library's when any SOP scores it at the line
   (0.62 here, against 0.65 for one SOP alone) and belongs to the SOP that scores it highest. Each requirement is
   asked of that owner first and, only if the owner does not meet it, of up to two SOPs whose passages come
   closer to it; it is a gap only when none of them meets it, and it is reported once, against the owner. The
   lines asked are the same lines the per-SOP mode builds, so they share its cache. Gaps in sections no SOP scores
   at one SOP's own line are listed apart, by section: the library only touches those, and may lack an SOP for them.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import html
import json
import re
import sqlite3
import sys
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import anthropic
import numpy as np
import psycopg

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

from app.config import settings  # noqa: E402
from app.llm import claude, voyage  # noqa: E402

XML = ROOT / "scripts" / "regulations" / "21cfr211.xml"
OUT = ROOT / "scripts" / "benchmarks" / "gap-check.json"            # the sample SOP's report
RUNS = ROOT / "scripts" / "benchmarks" / "gap-check"                 # one report per other SOP
WEB_OUT = ROOT / "web" / "src" / "data" / "gap-check.json"           # what the SOP check page shows; --publish only
CACHE = ROOT / "scripts" / "benchmarks" / "gap-cache.sqlite"
PRICE = {"claude-haiku-5-5": (0.10, 0.50), "claude-sonnet-5-5": (2.0, 10.0), "claude-opus-5-5": (4.0, 20.0)}   # $ per million in/out, read 2026-10-15
BATCH_DISCOUNT = 0.5                                                 # Message Batches API: half of every token price
SCOPE_THRESHOLD = 0.65                                               # cosine; see DECISIONS section 24 for how it was set

SAMPLE = "SOP-QC-014 Stability and reserve samples (synthetic)"
SAMPLE_SECTIONS = {"211.137", "211.166", "211.170"}                 # what the sample SOP was written against

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
            if not markers:                              # an unmarked paragraph continues the one before it,
                if out and out[-1].section == num:
                    out[-1].text += " " + raw
                else:                                    # or is the whole section (211.192 has no (a) at all)
                    out.append(Requirement(num, num, title, raw, title))
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
# 2. the SOP: its passages, which sections apply, and the three passages each requirement is judged on
# ---------------------------------------------------------------------------

def _conn():
    return psycopg.connect(settings.database_url, autocommit=True)


def find_sop(c: psycopg.Connection, name_part: str) -> tuple[str, str]:
    row = c.execute("select id::text, name from documents where name ilike %s and status = 'ready' order by created_at desc limit 1",
                    (f"%{name_part}%",)).fetchone()
    if not row:
        raise SystemExit(f"no ready document matches {name_part!r}")
    return row


def passages(c: psycopg.Connection, doc_id: str, strategy: str) -> list[dict]:
    """The SOP's passages as written, front matter left out: a passage whose breadcrumb names no heading is the
    title block ("Version 3   Effective 01-Jul-2026"), which is never evidence for a requirement and changes with
    every revision, so it would make every line look new."""
    rows = c.execute("""select ordinal, raw_text, page_start, chunk_type, coalesce(metadata->>'breadcrumb', '') from chunks
                         where document_id = %s and strategy = %s and chunk_type <> 'table_row' order by ordinal""",
                     (doc_id, strategy)).fetchall()
    out = [{"ordinal": o, "text": t, "page": pg, "type": ty, "front": " > " not in crumb} for o, t, pg, ty, crumb in rows]
    return [p for p in out if not p["front"]] or out


KEYWORDS = """with p as (select i, to_tsvector('english', t) as v from unnest(%s::text[]) with ordinality as x(t, i)),
                   q as (select j, coalesce((select to_tsquery('english', string_agg(quote_literal(lexeme), ' | '))
                                               from unnest(to_tsvector('english', t))),
                                            websearch_to_tsquery('english', t)) as q
                           from unnest(%s::text[]) with ordinality as y(t, j))
              select ts_rank_cd(p.v, q.q, 1) from q, p order by q.j, p.i"""
KEYWORD_WEIGHT = 0.3            # cosine + 0.3 x keyword rank; see DECISIONS section 24


def keyword_scores(c: psycopg.Connection, queries: list[str], texts: list[str]) -> np.ndarray:
    """The app's keyword rank (any word of the requirement, by cover density), on each passage's own words."""
    if not queries or not texts:
        return np.zeros((len(queries), len(texts)))
    rows = c.execute(KEYWORDS, (texts, queries)).fetchall()
    return np.array([r[0] for r in rows], dtype=np.float32).reshape(len(queries), len(texts))


def closest(sop: list[dict], sop_vectors: np.ndarray, query_vector: list[float], keywords: np.ndarray, k: int = 3) -> list[dict]:
    """The k passages closest to a requirement: meaning and keywords, both measured on the SOP's own words only.
    The app's search also ranks by the context line written for each passage at ingest; those are rewritten at
    every ingest, so its second and third passages swap between two uploads of the same text. Here a passage's
    score depends on nothing but its own words, and the scores are added rather than fused by rank, so an
    unchanged passage scores the same in every revision and at every site and a line's evidence changes only
    when the SOP's words do."""
    q = np.asarray(query_vector, dtype=np.float32)
    score = sop_vectors @ (q / np.linalg.norm(q)) + KEYWORD_WEIGHT * keywords
    best = sorted(range(len(sop)), key=lambda i: (-round(float(score[i]), 6), sop[i]["ordinal"]))[:k]
    return [sop[i] for i in sorted(best, key=lambda i: sop[i]["ordinal"])]      # shown in the SOP's own order


def sop_scope(c: psycopg.Connection, doc_id: str, strategy: str) -> tuple[str, str]:
    """The SOP's own scope statement (shown to the model), and every sentence that excludes something (for the rules)."""
    row = c.execute("select raw_text from chunks where document_id = %s and strategy = %s and raw_text ilike %s order by ordinal limit 1",
                    (doc_id, strategy, "%applies to%")).fetchone()
    rows = c.execute("select raw_text from chunks where document_id = %s and strategy = %s and raw_text ~* 'does not apply|not applicable|excluded'",
                     (doc_id, strategy)).fetchall()
    return (row[0] if row else ""), " ".join(r[0] for r in rows).lower()


def choose_sections(c: psycopg.Connection, doc_id: str, strategy: str, reqs: list[Requirement], vectors: list[list[float]],
                    threshold: float) -> list[dict]:
    """Every section of the Part, scored for this SOP and best first. Each requirement sentence (embedded as a
    query) is compared with every passage's stored vector, the one the app searches by, whose context line names
    the passage's topic; a section scores the mean of its two closest sentences, so one stray sentence in a long
    section does not pull it in. The passages' own words alone separate 211.137 from 211.22 less well (0.69 and
    0.65 on the sample, against 0.68 and 0.62)."""
    rows = c.execute("""select embedding::text from chunks where document_id = %s and strategy = %s and chunk_type <> 'table_row'
                         and embedding is not null""", (doc_id, strategy)).fetchall()
    if not rows:
        return []
    P = np.array([json.loads(r[0]) for r in rows], dtype=np.float32)
    Q = np.array(vectors, dtype=np.float32)
    P /= np.linalg.norm(P, axis=1, keepdims=True)
    Q /= np.linalg.norm(Q, axis=1, keepdims=True)
    nearest = (P @ Q.T).max(axis=0)                     # each sentence's best passage
    per: dict[str, list[float]] = defaultdict(list)
    titles: dict[str, str] = {}
    for r, v in zip(reqs, nearest):
        per[r.section].append(float(v))
        titles[r.section] = r.section_title
    out = []
    for sec, v in per.items():
        v.sort(reverse=True)
        score = sum(v[:2]) / len(v[:2])
        out.append({"section": sec, "title": titles[sec], "score": round(score, 3), "in_scope": score >= threshold})
    return sorted(out, key=lambda x: -x["score"])


# ---------------------------------------------------------------------------
# 3. the cache: verdicts by evidence, vectors by text, batches still out
# ---------------------------------------------------------------------------

def _hash(*parts: object) -> str:
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


class Cache:
    """One SQLite file. A verdict is stored under (citation, evidence, judge): evidence hashes the SOP words the
    model is shown (the three passages, in any order, and the scope line), judge hashes the model, the prompt and
    the requirement's wording, so a new model, prompt or regulation text never gets an old verdict. Requirement
    vectors are stored by their text, since every SOP is checked against the same sentences."""

    def __init__(self, path: Path = CACHE):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.executescript("""
            create table if not exists verdicts (key text primary key, cite text, evidence text, judge text, verdict text,
                tokens_in integer, tokens_out integer, dollars real, mode text, made_at text);
            create table if not exists vectors (key text primary key, vector blob);
            create table if not exists pending (key text primary key, batch_id text, cite text, evidence text, judge text,
                model text, made_at text);
        """)

    def verdicts(self, keys: list[str]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for i in range(0, len(keys), 500):
            part = keys[i:i + 500]
            for k, v, ti, to, d, m in self.db.execute(
                    f"select key, verdict, tokens_in, tokens_out, dollars, mode from verdicts where key in ({','.join('?' * len(part))})", part):
                out[k] = {"verdict": json.loads(v), "in": ti, "out": to, "dollars": d, "mode": m}
        return out

    def put_verdict(self, key: str, cite: str, evidence: str, judge: str, verdict: dict, tin: int, tout: int, dollars: float, mode: str) -> None:
        self.db.execute("insert or replace into verdicts values (?,?,?,?,?,?,?,?,?,?)",
                        (key, cite, evidence, judge, json.dumps(verdict, ensure_ascii=False), tin, tout, dollars, mode,
                         datetime.now(timezone.utc).isoformat(timespec="seconds")))
        self.db.commit()

    def embed(self, texts: list[str], input_type: str) -> list[list[float]]:
        if settings.fake_embeddings:                    # fake vectors are not worth keeping
            return voyage.embed(texts, input_type=input_type)
        keys = [_hash(settings.embedding_model, settings.embedding_dim, input_type, t) for t in texts]
        have: dict[str, list[float]] = {}
        for i in range(0, len(keys), 500):
            part = keys[i:i + 500]
            for k, blob in self.db.execute(f"select key, vector from vectors where key in ({','.join('?' * len(part))})", part):
                have[k] = np.frombuffer(blob, dtype=np.float32).tolist()
        missing = [i for i, k in enumerate(keys) if k not in have]
        if missing:
            new = voyage.embed([texts[i] for i in missing], input_type=input_type)
            for i, v in zip(missing, new):
                have[keys[i]] = v
                self.db.execute("insert or replace into vectors values (?, ?)", (keys[i], np.asarray(v, dtype=np.float32).tobytes()))
            self.db.commit()
        return [have[k] for k in keys]

    def pending(self) -> dict[str, dict]:
        return {k: {"batch_id": b, "cite": c, "evidence": e, "judge": j, "model": m}
                for k, b, c, e, j, m in self.db.execute("select key, batch_id, cite, evidence, judge, model from pending")}

    def add_pending(self, batch_id: str, lines: list["Line"], model: str) -> None:
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.db.executemany("insert or replace into pending values (?,?,?,?,?,?,?)",
                            [(x.key, batch_id, x.req.cite, x.evidence, x.judge, model, now) for x in lines])
        self.db.commit()

    def drop_pending(self, key: str) -> None:
        self.db.execute("delete from pending where key = ?", (key,))
        self.db.commit()


# ---------------------------------------------------------------------------
# 4a. the rules judge: no model
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
# 4b. the model judge
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


JUDGE_PROMPT = "Requirement {cite} ({context}):{para}\nCheck only this: {text}\n\nSOP scope: {scope}\n\nSOP passages:\n{passages}"
MAX_TOKENS = 400
UNREAD = {"status": "unsure", "quote": "", "reason": "The model's reply could not be read."}


def judge_params(req: Requirement, passages: list[dict], scope: str, model: str) -> dict:
    """One Messages API request, the same whether it is sent now or inside a batch."""
    para = f"\nThe whole paragraph, for context only: {req.paragraph}\n" if req.paragraph else ""
    msg = JUDGE_PROMPT.format(cite=req.cite, context=req.context, para=para, text=req.text, scope=scope or "not stated",
                              passages="\n\n".join(f"[page {p['page']}] {p['text']}" for p in passages))
    params: dict = {"model": model, "max_tokens": MAX_TOKENS, "system": JUDGE_SYSTEM,
                    "output_config": {"format": {"type": "json_schema", "schema": JUDGE_SCHEMA}},
                    "messages": [{"role": "user", "content": msg}]}
    # No thinking: Haiku takes "disabled"; Sonnet 5.5 asks for "between_tools" to mean the same; Opus 5.5 cannot turn
    # it off, so it thinks as little as it can.
    if "haiku" in model:
        params["thinking"] = {"type": "disabled"}
    elif "sonnet" in model:
        params["thinking"] = {"type": "between_tools"}
    else:
        params["output_config"]["effort"] = "low"
    return params


def read_verdict(message) -> dict | None:
    if message.stop_reason == "refusal":
        return None
    try:
        v = json.loads("".join(b.text for b in message.content if b.type == "text"))
    except json.JSONDecodeError:
        return None
    return v if v.get("status") in JUDGE_SCHEMA["properties"]["status"]["enum"] else None


def dollars(model: str, tokens_in: int, tokens_out: int, mode: str) -> float:
    p_in, p_out = PRICE[model]
    return (tokens_in * p_in + tokens_out * p_out) / 1e6 * (BATCH_DISCOUNT if mode == "batch" else 1.0)


@dataclass
class Line:
    """One requirement of one SOP, the evidence it is judged on, and where its verdict came from."""
    sop: str
    req: Requirement
    passages: list[dict]
    rules: tuple[str, str]
    params: dict
    evidence: str
    judge: str
    key: str
    verdict: dict | None = None
    source: str = ""                    # cache | shared (same evidence as a line judged for another SOP this run) | model | failed
    tokens: tuple[int, int] = (0, 0)
    dollars: float = 0.0                # what this verdict cost when it was bought
    mode: str = ""                      # standard | batch


def settle(cache: Cache, x: Line, verdict: dict | None, tokens_in: int, tokens_out: int, mode: str) -> None:
    x.tokens, x.mode = (tokens_in, tokens_out), mode
    x.dollars = dollars(x.params["model"], tokens_in, tokens_out, mode)
    if verdict is None:                 # paid for, but not kept: the next run asks again
        x.verdict, x.source = UNREAD, "failed"
        return
    x.verdict, x.source = verdict, "model"
    cache.put_verdict(x.key, x.req.cite, x.evidence, x.judge, verdict, tokens_in, tokens_out, x.dollars, mode)


async def judge_live(cache: Cache, todo: list[Line]) -> None:
    sem = asyncio.Semaphore(6)

    async def one(x: Line) -> None:
        async with sem:
            try:
                resp = await claude.client().messages.create(**x.params)
            except anthropic.APIError as e:
                print(f"  {x.sop} {x.req.cite}: {type(e).__name__}: {e}", file=sys.stderr)
                x.verdict, x.source = UNREAD, "failed"
                return
        settle(cache, x, read_verdict(resp), resp.usage.input_tokens, resp.usage.output_tokens, "standard")

    await asyncio.gather(*(one(x) for x in todo))


def judge_in_batches(cache: Cache, todo: list[Line], poll: float = 20.0) -> float:
    """Send the lines as one Message Batch (custom_id is the cache key), wait, and keep what comes back. A line
    already out in a batch from an earlier run that died is not sent again: that batch is waited for instead.
    Returns the seconds spent waiting."""
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key, max_retries=4, timeout=120.0)
    out = cache.pending()
    new = [x for x in todo if x.key not in out]
    batches = {out[x.key]["batch_id"] for x in todo if x.key in out}
    if new:
        b = client.messages.batches.create(requests=[{"custom_id": x.key, "params": x.params} for x in new])
        cache.add_pending(b.id, new, new[0].params["model"])
        batches.add(b.id)
        print(f"batch {b.id}: {len(new)} requests sent")
    by_key = {x.key: x for x in todo}
    pend = cache.pending()
    t0 = time.monotonic()
    for bid in sorted(batches):
        while (b := client.messages.batches.retrieve(bid)).processing_status != "ended":
            n = b.request_counts
            print(f"  batch {bid}: {n.processing} processing, {n.succeeded} done ({time.monotonic() - t0:.0f} s)", flush=True)
            time.sleep(poll)
        for r in client.messages.batches.results(bid):
            x, p = by_key.get(r.custom_id), pend.get(r.custom_id)
            if r.result.type == "succeeded":
                msg = r.result.message
                v, tin, tout = read_verdict(msg), msg.usage.input_tokens, msg.usage.output_tokens
                if x:
                    settle(cache, x, v, tin, tout, "batch")
                elif p and v:           # a line of an earlier run's batch that this run does not need: keep it anyway
                    cache.put_verdict(r.custom_id, p["cite"], p["evidence"], p["judge"], v, tin, tout,
                                      dollars(p["model"], tin, tout, "batch"), "batch")
            elif x:                     # errored, canceled or expired: not kept, so the next run sends it again
                x.verdict, x.source = {"status": "unsure", "quote": "", "reason": f"The batch request {r.result.type}."}, "failed"
            cache.drop_pending(r.custom_id)
    waited = time.monotonic() - t0
    print(f"batches ended after {waited:.0f} s of waiting")
    return waited


# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------

def load_sop(c: psycopg.Connection, cache: Cache, doc_id: str, doc_name: str, reqs: list[Requirement], vectors: list[list[float]],
             strategy: str, threshold: float, rank: bool) -> dict:
    """One SOP's passages, their own-words vectors, its scope line and, if asked, its section ranking."""
    sop = passages(c, doc_id, strategy)
    P = np.array(cache.embed([p["text"] for p in sop], "document"), dtype=np.float32)   # by text: a revision re-embeds only what changed
    P /= np.linalg.norm(P, axis=1, keepdims=True)
    scope, exclusions = sop_scope(c, doc_id, strategy)
    return {"doc_id": doc_id, "name": doc_name, "stem": doc_name.rsplit(".", 1)[0], "passages": sop, "P": P,
            "scope": scope, "exclusions": exclusions,
            "ranking": choose_sections(c, doc_id, strategy, reqs, vectors, threshold) if rank else []}


def make_line(s: dict, r: Requirement, v: list[float], kw: np.ndarray, model: str) -> Line:
    """One requirement judged on one SOP: its three closest passages and the request that would judge them. The key
    holds nothing about which SOP this is, so the same words anywhere get the same verdict."""
    found = closest(s["passages"], s["P"], v, kw)
    params = judge_params(r, found, s["scope"], model)
    evidence = _hash(sorted(p["text"] for p in found), s["scope"])
    judge = _hash({name: val for name, val in params.items() if name != "messages"}, JUDGE_PROMPT, r.cite, r.context, r.paragraph, r.text)
    return Line(s["stem"], r, found, rules_judge(r, found, s["exclusions"]), params, evidence, judge, _hash(r.cite, evidence, judge))


def prepare(c: psycopg.Connection, cache: Cache, name_part: str, reqs: list[Requirement], vectors: list[list[float]],
            sections: list[str] | None, strategy: str, model: str, threshold: float) -> dict:
    """Scope one SOP and find the evidence for each of its lines. No model is called here."""
    s = load_sop(c, cache, *find_sop(c, name_part), reqs, vectors, strategy, threshold, rank=not sections)
    chosen = list(sections) if sections else [x["section"] for x in s["ranking"] if x["in_scope"]]
    mine = [(r, v) for r, v in zip(reqs, vectors) if r.section in chosen]
    K = keyword_scores(c, [f"{r.section_title}. {r.text}" for r, _ in mine], [p["text"] for p in s["passages"]])
    lines = [make_line(s, r, v, kw, model) for (r, v), kw in zip(mine, K)]
    return {"doc_id": s["doc_id"], "name": s["name"], "stem": s["stem"], "sections": chosen, "ranking": s["ranking"], "lines": lines}


def score(rows: list[dict], key: str) -> dict:
    graded = [x for x in rows if x["expected"]]
    decided = [x for x in graded if x[key]["status"] != "unsure"]
    right = [x for x in decided if x[key]["status"] == x["expected"]
             or (x["expected"] == "partly_met" and x[key]["status"] in ("partly_met", "not_met") and key == "rules")]
    return {"graded": len(graded), "decided": len(decided), "right": len(right), "unsure": len(graded) - len(decided)}


def report(s: dict, model: str, threshold: float, given: bool) -> dict:
    expected = EXPECTED if s["stem"] == SAMPLE else {}
    lines: list[Line] = s["lines"]
    rows = [{"cite": x.req.cite, "section_title": x.req.section_title, "context": x.req.context, "text": x.req.text,
             "passages": [{"page": p["page"], "text": p["text"][:600]} for p in x.passages],
             "rules": {"status": x.rules[0], "reason": x.rules[1]}, "model": x.verdict, "expected": expected.get(x.req.cite),
             "verdict_from": x.source} for x in lines]
    bought = [x for x in lines if x.mode]
    new = [x for x in lines if x.source in ("model", "failed")]
    full = sum(x.dollars for x in bought)
    scope: dict = {"how": "given" if given else "measured", "threshold": threshold, "ranking": s["ranking"][:12]}
    if not given and s["stem"] == SAMPLE:
        picked = set(s["sections"])
        scope["graded"] = {"expected": sorted(SAMPLE_SECTIONS), "found": sorted(SAMPLE_SECTIONS & picked),
                           "missed": sorted(SAMPLE_SECTIONS - picked), "extra": sorted(picked - SAMPLE_SECTIONS)}
    return {
        "sop": s["stem"], "regulation": "21 CFR Part 211", "regulation_as_of": "2026-10-13",
        "sections": s["sections"], "scope": scope, "requirements": len(rows),
        "rules_score": score(rows, "rules"), "model_score": score(rows, "model"),
        # What judging this SOP took, whenever each verdict was bought; this_run is what this run paid.
        "model_usage": {"model": model, "calls": len(bought), "in": sum(x.tokens[0] for x in bought), "out": sum(x.tokens[1] for x in bought),
                        "dollars": round(full, 5), "dollars_per_requirement": round(full / max(1, len(bought)), 6),
                        "batch_calls": sum(1 for x in bought if x.mode == "batch")},
        "this_run": {"calls": len(new), "from_cache": sum(1 for x in lines if x.source == "cache"),
                     "shared": sum(1 for x in lines if x.source == "shared"),
                     "in": sum(x.tokens[0] for x in new), "out": sum(x.tokens[1] for x in new),
                     "dollars": round(sum(x.dollars for x in new), 5)},
        "rows": rows,
    }


def write(rep: dict, model: str, publish: bool) -> Path:
    if rep["sop"] != SAMPLE:
        path = RUNS / (re.sub(r"[^a-z0-9]+", "-", rep["sop"].lower()).strip("-") + ".json")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rep, indent=2, ensure_ascii=False) + "\n")
        return path
    # The sample keeps the score of every model run so far, so the page can compare them; the rows are this run's.
    models: dict[str, dict] = {}
    if OUT.exists():
        try:
            models = {m["model"]: m for m in json.loads(OUT.read_text()).get("models", [])}
        except (json.JSONDecodeError, KeyError):
            models = {}
    u = rep["model_usage"]
    models[model] = {"model": model, **rep["model_score"], "dollars": u["dollars"], "calls": u["calls"], "batch_calls": u["batch_calls"]}
    rep["models"] = sorted(models.values(), key=lambda m: m["dollars"])
    for path in (OUT, WEB_OUT) if publish else (OUT,):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rep, indent=2, ensure_ascii=False) + "\n")
    return OUT


def print_ranking(stem: str, ranking: list[dict], top: int = 8) -> None:
    picked = [s for s in ranking if s["in_scope"]]
    print(f"\n{stem}: {len(picked)} of {len(ranking)} sections in scope")
    for s in ranking[:max(top, len(picked) + 2)]:
        print(f"  {'*' if s['in_scope'] else ' '} {s['score']:.3f}  {s['title'][:70]}")


# ---------------------------------------------------------------------------
# 5. a company's library: a gap only when no SOP in it meets the requirement
# ---------------------------------------------------------------------------

LIBRARY_OUT = ROOT / "scripts" / "benchmarks" / "gap-library.json"
LIBRARY_THRESHOLD = 0.62        # lower than one SOP's line: a section touched in passing no longer costs false gaps (DECISIONS section 25)
LIBRARY_ALSO = 2                # other SOPs asked about a requirement, at most, after its owner
LIBRARY_MARGIN = 0.0            # ... and only those whose closest passage scores at least the owner's, minus this
SETTLED = ("met",)


def sop_number(name: str) -> str:
    """"SOP-QC-014 Stability and reserve samples, revision B" -> "SOP-QC-014": what versions and copies share."""
    return re.split(r"[\s:,]", name, maxsplit=1)[0].upper()


def library_members(c: psycopg.Connection, names: list[str] | None, prefix: str) -> tuple[list[tuple[str, str]], list[str]]:
    """The SOPs named, or every ready document whose name starts with the prefix. A library holds one version of
    each SOP: when several documents share a number (a revision, another site's copy), the newest is kept and the
    others are listed as left out, since an old revision would meet what the current one dropped."""
    if names:
        found = list(dict.fromkeys(find_sop(c, n) for n in names))
        numbers = [sop_number(n) for _, n in found]
        for num in sorted({x for x in numbers if numbers.count(x) > 1}):
            print(f"note: {num} is in the library {numbers.count(num)} times; each copy counts as meeting what it meets")
        return found, []
    rows = c.execute("select id::text, name from documents where name ilike %s and status = 'ready' order by created_at desc",
                     (prefix.replace("%", r"\%").replace("_", r"\_") + "%",)).fetchall()
    keep: dict[str, tuple[str, str]] = {}
    left: list[str] = []
    for doc_id, name in rows:
        if sop_number(name) in keep:
            left.append(name.rsplit(".", 1)[0])
        else:
            keep[sop_number(name)] = (doc_id, name)
    if not keep:
        raise SystemExit(f"no ready document starts with {prefix!r}")
    return sorted(keep.values(), key=lambda x: x[1]), left


def library_status(asked: list[Line], owner: Line) -> tuple[str, Line]:
    """Met if any SOP asked meets it. Otherwise not applicable if the owner's scope rules it out (another SOP's
    scope says nothing about the company's other products), then partly met if any SOP goes part of the way, and
    a gap with the owner's reason if none does."""
    by = {st: [x for x in asked if x.verdict and x.verdict["status"] == st] for st in ("met", "partly_met", "unsure")}
    if by["met"]:
        return "met", by["met"][0]
    if owner.verdict and owner.verdict["status"] == "not_applicable":
        return "not_applicable", owner
    if by["partly_met"]:
        return "partly_met", by["partly_met"][0]
    if by["unsure"]:
        return "unsure", by["unsure"][0]
    return "not_met", owner


def prepare_library(c: psycopg.Connection, cache: Cache, members: list[tuple[str, str]], reqs: list[Requirement],
                    vectors: list[list[float]], sections: list[str] | None, strategy: str, model: str, threshold: float) -> dict:
    """Every member's section ranking, the library's sections and their owners, and for each requirement the SOPs
    to ask, owner first. No model is called here.

    A section is the library's when some SOP scores it at the line; its owner is the SOP that scores it highest.
    A requirement is asked of its owner, then of at most LIBRARY_ALSO other SOPs whose closest passage to it scores
    at least the owner's (minus LIBRARY_MARGIN), closest first: the judge only ever sees an SOP's three closest
    passages, so an SOP with nothing nearer than the owner's evidence would not be found to meet it either."""
    sops = [load_sop(c, cache, doc_id, name, reqs, vectors, strategy, threshold, rank=True) for doc_id, name in members]
    owners: dict[str, dict] = {}
    for i, s in enumerate(sops):
        for pos, x in enumerate(s["ranking"], 1):
            if (sections and x["section"] not in sections) or (not sections and not x["in_scope"]):
                continue
            o = owners.get(x["section"])
            if o is None or (x["score"], -pos) > (o["score"], -o["position"]):
                owners[x["section"]] = {"section": x["section"], "title": x["title"], "owner": i, "score": x["score"], "position": pos}
    for sec, o in owners.items():
        o["in_scope_of"] = [(s["stem"], x["score"]) for s in sops for x in s["ranking"] if x["section"] == sec and x["score"] >= threshold]
    mine = [(r, v) for r, v in zip(reqs, vectors) if r.section in owners]
    if not mine:
        return {"members": sops, "owners": owners, "groups": []}
    queries = [f"{r.section_title}. {r.text}" for r, _ in mine]
    Q = np.array([v for _, v in mine], dtype=np.float32)
    Q /= np.linalg.norm(Q, axis=1, keepdims=True)
    K = [keyword_scores(c, queries, [p["text"] for p in s["passages"]]) for s in sops]
    near = np.stack([(Q @ s["P"].T + KEYWORD_WEIGHT * k).max(axis=1) for s, k in zip(sops, K)], axis=1)  # requirement x SOP
    groups = []
    for j, (r, v) in enumerate(mine):
        o = owners[r.section]["owner"]
        others = sorted((i for i in range(len(sops)) if i != o and near[j, i] >= near[j, o] - LIBRARY_MARGIN), key=lambda i: -near[j, i])
        order = [o] + others[:LIBRARY_ALSO]
        groups.append({"req": r, "owner": sops[o]["stem"], "near": {sops[i]["stem"]: round(float(near[j, i]), 3) for i in order},
                       "candidates": [make_line(sops[i], r, v, K[i][j], model) for i in order]})
    return {"members": sops, "owners": owners, "groups": groups}


def judge_library(cache: Cache, groups: list[dict], batch: bool, no_cache: bool) -> int:
    """Ask in rounds: every requirement's owner first, then, for those not met, the next SOP, until each is met,
    ruled out by its owner's scope, or out of SOPs to ask. A verdict already in the cache costs nothing and counts
    in any round, so a library whose SOPs were checked one by one is checked as a library for free. Returns the
    number of rounds that called the model."""
    every = {x.key: x for g in groups for x in g["candidates"]}
    known = {} if no_cache else cache.verdicts(sorted(every))
    done: dict[str, Line] = {}                          # key -> the line whose verdict this run holds

    def take(x: Line) -> bool:
        if x.key in done:
            y = done[x.key]
            x.verdict, x.tokens, x.dollars, x.mode, x.source = y.verdict, y.tokens, y.dollars, y.mode, y.source if y is x else "shared"
            return True
        if x.key in known:
            k = known[x.key]
            x.verdict, x.source, x.tokens, x.dollars, x.mode = k["verdict"], "cache", (k["in"], k["out"]), k["dollars"], k["mode"]
            done[x.key] = x
            return True
        return False

    rounds = 0
    while True:
        todo: dict[str, Line] = {}
        for g in groups:
            owner, asked = g["candidates"][0], []
            for x in g["candidates"]:
                if not take(x):
                    if x.key not in todo:
                        todo[x.key] = x
                    break
                asked.append(x)
                if x.verdict["status"] in SETTLED or (x is owner and x.verdict["status"] == "not_applicable"):
                    break
        if not todo:
            break
        rounds += 1
        print(f"round {rounds}: {len(todo)} lines to judge" + (" in a batch" if batch else ""))
        if batch:
            judge_in_batches(cache, list(todo.values()))
        else:
            asyncio.run(judge_live(cache, list(todo.values())))
        for x in todo.values():
            done[x.key] = x
    for g in groups:
        g["asked"] = [x for x in g["candidates"] if x.verdict]
        g["status"], g["by"] = library_status(g["asked"], g["candidates"][0])
    return rounds


def library_report(lib: dict, model: str, threshold: float, left_out: list[str], rounds: int, given: bool) -> dict:
    members, groups, owners = lib["members"], lib["groups"], lib["owners"]
    sample_in = any(s["stem"] == SAMPLE for s in members)
    rows = []
    for g in groups:
        r, by = g["req"], g["by"]
        # owned: some SOP is clearly about the section (scores it at one SOP's own line); touched: the library only
        # comes near it, so a gap there may mean the library lacks an SOP for it rather than that the owner is short.
        tier = "owned" if owners[r.section]["score"] >= SCOPE_THRESHOLD else "touched"
        rows.append({"cite": r.cite, "section": r.section, "section_title": r.section_title, "text": r.text,
                     "owner": g["owner"], "owner_score": owners[r.section]["score"], "tier": tier, "status": g["status"], "by": by.sop,
                     "reason": by.verdict["reason"] if by.verdict else "", "quote": by.verdict["quote"] if by.verdict else "",
                     "asked": [{"sop": x.sop, "near": g["near"][x.sop], "status": x.verdict["status"], "reason": x.verdict["reason"],
                                "verdict_from": x.source} for x in g["asked"]],
                     "expected": EXPECTED.get(r.cite) if sample_in else None})
    seen: dict[str, Line] = {}
    for g in groups:
        for x in g["asked"]:
            seen.setdefault(x.key, x)
    bought = [x for x in seen.values() if x.mode]
    new = [x for x in seen.values() if x.source in ("model", "failed")]
    # What checking each member on its own at the same line would ask: every requirement of every section in its scope.
    size = defaultdict(int)
    for g in groups:
        size[g["req"].section] += 1
    one_by_one = sum(size[x["section"]] for s in members for x in s["ranking"]
                     if (x["section"] in owners if given else x["in_scope"]))
    gaps = [x for x in rows if x["status"] in ("not_met", "partly_met")]
    by_owner = {s["stem"]: {"sections": sorted(sec for sec, o in owners.items() if members[o["owner"]]["stem"] == s["stem"]),
                            "gaps": [x["cite"] for x in gaps if x["owner"] == s["stem"] and x["tier"] == "owned"],
                            "gaps_touched": [x["cite"] for x in gaps if x["owner"] == s["stem"] and x["tier"] == "touched"]}
                for s in members}
    touched = []
    for o in sorted(owners.values(), key=lambda o: -o["score"]):
        if o["score"] < SCOPE_THRESHOLD:
            mine = [x for x in rows if x["section"] == o["section"]]
            touched.append({"section": o["section"], "title": o["title"], "closest": members[o["owner"]]["stem"], "score": o["score"],
                            "requirements": len(mine), **{st: sum(1 for x in mine if x["status"] == st)
                                                          for st in ("met", "partly_met", "not_met", "not_applicable", "unsure")}})
    graded = [x for x in rows if x["expected"]]
    return {
        "library": [s["stem"] for s in members], "left_out": left_out, "regulation": "21 CFR Part 211", "regulation_as_of": "2026-10-13",
        "scope": {"how": "given" if given else "measured", "threshold": threshold, "owned_from": SCOPE_THRESHOLD,
                  "also": LIBRARY_ALSO, "margin": LIBRARY_MARGIN},
        "sections": [{"section": o["section"], "title": o["title"], "owner": members[o["owner"]]["stem"], "score": o["score"],
                      "in_scope_of": o["in_scope_of"]} for o in sorted(owners.values(), key=lambda o: -o["score"])],
        "requirements": len(rows), "gaps": sum(1 for x in gaps if x["tier"] == "owned"),
        "gaps_touched": sum(1 for x in gaps if x["tier"] == "touched"), "touched_sections": touched,
        "status": {st: sum(1 for x in rows if x["status"] == st) for st in ("met", "partly_met", "not_met", "not_applicable", "unsure")},
        "by_owner": by_owner,
        "sample_score": {"graded": len(graded), "right": sum(1 for x in graded if x["status"] == x["expected"]),
                         "gaps_expected": sum(1 for x in graded if x["expected"] in ("not_met", "partly_met")),
                         "gaps_shown": sum(1 for x in graded if x["expected"] in ("not_met", "partly_met") and x["status"] in ("not_met", "partly_met"))},
        "model_usage": {"model": model, "calls": len(bought), "in": sum(x.tokens[0] for x in bought), "out": sum(x.tokens[1] for x in bought),
                        "dollars": round(sum(x.dollars for x in bought), 5), "batch_calls": sum(1 for x in bought if x.mode == "batch"),
                        "rounds": rounds, "lines_one_by_one": one_by_one},
        "this_run": {"calls": len(new), "from_cache": sum(1 for x in seen.values() if x.source == "cache"),
                     "in": sum(x.tokens[0] for x in new), "out": sum(x.tokens[1] for x in new), "dollars": round(sum(x.dollars for x in new), 5)},
        "rows": rows,
    }


def run_library(names: list[str] | None, prefix: str, sections: list[str] | None, strategy: str, model: str, threshold: float,
                batch: bool, no_cache: bool, scope_only: bool, cache_path: Path, out: Path) -> None:
    cache = Cache(cache_path)
    reqs = units(read_part())
    vectors = cache.embed([f"{r.section_title}. {r.text}" for r in reqs], "query")
    with _conn() as c:
        members, left_out = library_members(c, names, prefix)
        lib = prepare_library(c, cache, members, reqs, vectors, sections, strategy, model, threshold)
    stems = [s["stem"] for s in lib["members"]]
    print(f"library of {len(stems)} SOPs" + (f" ({len(left_out)} older or duplicate copies left out: {'; '.join(left_out)})" if left_out else ""))
    print(f"{len(lib['owners'])} sections at {threshold}, {len(lib['groups'])} requirements, "
          f"{sum(len(g['candidates']) for g in lib['groups'])} SOP lines that could be asked")
    for o in sorted(lib["owners"].values(), key=lambda o: -o["score"]):
        also = [f"{n[:10]} {v:.3f}" for n, v in o["in_scope_of"] if n != stems[o["owner"]]]
        print(f"  {o['section']:8} {o['score']:.3f}  owner {stems[o['owner']][:40]:40}" + (f"  also in scope of {', '.join(also)}" if also else ""))
    if scope_only:
        return
    rounds = judge_library(cache, lib["groups"], batch, no_cache)
    rep = library_report(lib, model, threshold, left_out, rounds, given=bool(sections))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rep, indent=2, ensure_ascii=False) + "\n")

    print(f"\n{'citation':24} {'owner':11} {'library':15} {'by':11} {'expected':15} asked")
    for x in rep["rows"]:
        asked = ", ".join(f"{a['sop'][:10]} {a['status']}" for a in x["asked"])
        print(f"{x['cite']:24} {x['owner'][:11]:11} {x['status']:15} {x['by'][:11]:11} {str(x['expected']):15} {asked}"
              + ("  (touched)" if x["tier"] == "touched" else ""))
    print(f"\n{rep['requirements']} requirements: " + ", ".join(f"{k} {v}" for k, v in rep["status"].items() if v))
    print(f"{rep['gaps']} gaps in sections an SOP is about, by owner:")
    for stem, o in rep["by_owner"].items():
        print(f"  {stem[:56]:56} owns {len(o['sections'])} sections, {len(o['gaps'])} gaps")
    if rep["touched_sections"]:
        print(f"{rep['gaps_touched']} more in {len(rep['touched_sections'])} sections no SOP is clearly about "
              f"(closest SOP under {SCOPE_THRESHOLD}): the library may have no SOP for them")
        for t in rep["touched_sections"]:
            print(f"  {t['title'][:52]:52} closest {t['closest'][:10]} {t['score']:.3f}: "
                  f"{t['not_met']} not met, {t['partly_met']} partly, {t['met']} met, {t['not_applicable']} n/a of {t['requirements']}")
    if rep["sample_score"]["graded"]:
        s = rep["sample_score"]
        print(f"sample: {s['right']} of {s['graded']} as expected; {s['gaps_shown']} of its {s['gaps_expected']} known gaps still shown")
    u, t = rep["model_usage"], rep["this_run"]
    print(f"library: {u['calls']} verdicts in {u['rounds']} rounds, {u['in']:,} in / {u['out']:,} out tokens, ${u['dollars']:.4f} as bought"
          f" ({u['batch_calls']} through the batch API); checked one by one at the same line: {u['lines_one_by_one']} lines")
    print(f"this run: {t['calls']} model calls, {t['from_cache']} from the cache, ${t['dollars']:.4f}")
    print(f"wrote {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}")


async def run(names: list[str], sections: list[str] | None, strategy: str, model: str, threshold: float,
              batch: bool, no_cache: bool, publish: bool, scope_only: bool, cache_path: Path = CACHE) -> None:
    cache = Cache(cache_path)
    reqs = units(read_part())
    queries = [f"{r.section_title}. {r.text}" for r in reqs]
    vectors = cache.embed(queries, "query")             # every sentence of the Part, embedded once for all SOPs
    with _conn() as c:
        if scope_only:
            for n in names:
                doc_id, doc_name = find_sop(c, n)
                print_ranking(doc_name.rsplit(".", 1)[0], choose_sections(c, doc_id, strategy, reqs, vectors, threshold))
            return
        sops = [prepare(c, cache, n, reqs, vectors, sections, strategy, model, threshold) for n in names]

    lines = [x for s in sops for x in s["lines"]]
    known = {} if no_cache else cache.verdicts(sorted({x.key for x in lines}))
    first: dict[str, Line] = {}
    for x in lines:
        if x.key in known:
            k = known[x.key]
            x.verdict, x.source, x.tokens, x.dollars, x.mode = k["verdict"], "cache", (k["in"], k["out"]), k["dollars"], k["mode"]
        elif x.key in first:
            x.source = "shared"
        else:
            first[x.key] = x
    todo = list(first.values())
    print(f"{len(sops)} SOPs, {len(lines)} lines: {sum(x.source == 'cache' for x in lines)} from the cache, "
          f"{sum(x.source == 'shared' for x in lines)} sharing their evidence with another line, {len(todo)} to judge"
          + (" in a batch" if batch and todo else ""))
    if todo:
        if batch:
            judge_in_batches(cache, todo)
        else:
            await judge_live(cache, todo)
    for x in lines:
        if x.source == "shared":
            y = first[x.key]
            x.verdict, x.tokens, x.dollars, x.mode = y.verdict, y.tokens, y.dollars, y.mode

    summary = []
    for s in sops:
        rep = report(s, model, threshold, given=bool(sections))
        path = write(rep, model, publish)
        if s["ranking"]:
            print_ranking(s["stem"], s["ranking"])
        if "graded" in rep["scope"]:
            g = rep["scope"]["graded"]
            print(f"  scope: found {len(g['found'])} of {len(g['expected'])} expected sections, missed {g['missed'] or 'none'}, extra {g['extra'] or 'none'}")
        print(f"\n{'citation':24} {'expected':15} {'rules':15} {'model':15} verdict from")
        for x in rep["rows"]:
            print(f"{x['cite']:24} {str(x['expected']):15} {x['rules']['status']:15} {x['model']['status']:15} {x['verdict_from']}")
        if rep["rules_score"]["graded"]:
            print("rules:", rep["rules_score"], "\nmodel:", rep["model_score"])
        u, t = rep["model_usage"], rep["this_run"]
        print(f"this SOP: {u['calls']} verdicts, {u['in']:,} in / {u['out']:,} out tokens, ${u['dollars']:.4f} as bought"
              f" ({u['batch_calls']} through the batch API)")
        print(f"this run: {t['calls']} model calls, {t['from_cache']} from the cache, {t['shared']} shared with another SOP, ${t['dollars']:.4f}")
        print(f"wrote {path.relative_to(ROOT)}" + (f" and {WEB_OUT.relative_to(ROOT)}" if publish and path == OUT else ""))
        summary.append((s["stem"], len(s["sections"]), u["calls"], t["from_cache"] + t["shared"], t["calls"], t["dollars"], u["dollars"]))

    if len(summary) > 1:
        print(f"\n{'SOP':60} {'sections':>8} {'lines':>6} {'reused':>6} {'asked':>6} {'paid now':>9} {'per SOP':>9}")
        for stem, nsec, nl, reused, asked, paid, per in summary:
            print(f"{stem[:60]:60} {nsec:8} {nl:6} {reused:6} {asked:6} {paid:9.4f} {per:9.4f}")
        print(f"{'total':60} {'':8} {sum(r[2] for r in summary):6} {sum(r[3] for r in summary):6} {sum(r[4] for r in summary):6}"
              f" {sum(r[5] for r in summary):9.4f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sop", nargs="+", help=f"name fragments; each picks the newest ready document it matches (default: {SAMPLE})")
    ap.add_argument("--library", nargs="?", const="SOP-", metavar="PREFIX",
                    help="judge the SOPs as one company's library: a requirement is a gap only when none of them meets it, "
                         "and each gap is named against the SOP that should own it. The library is the --sop list, or else "
                         "every ready document whose name starts with PREFIX (default SOP-), newest version of each")
    ap.add_argument("--sections", nargs="+", help="check these sections instead of choosing them for each SOP")
    ap.add_argument("--threshold", type=float, help=f"how close a section must come to be in scope "
                                                    f"(default {SCOPE_THRESHOLD}, or {LIBRARY_THRESHOLD} with --library)")
    ap.add_argument("--cache", type=Path, default=CACHE, help="the verdict cache to read and fill")
    ap.add_argument("--out", type=Path, default=LIBRARY_OUT, help="where --library writes its report")
    ap.add_argument("--scope-only", action="store_true", help="print which sections apply to each SOP and stop")
    ap.add_argument("--batch", action="store_true", help="send the model calls through the Message Batches API: half price, minutes to hours")
    ap.add_argument("--no-cache", action="store_true", help="judge every line again (the new verdicts replace the cached ones)")
    ap.add_argument("--publish", action="store_true", help=f"also write the sample's report to {WEB_OUT.relative_to(ROOT)}, which the SOP check page shows")
    ap.add_argument("--strategy", default="contextual", help="which chunks of the SOP to search")
    ap.add_argument("--model", default="claude-haiku-5-5", choices=list(PRICE))
    ap.add_argument("--list", action="store_true", help="print the requirements of the sections (all of them without --sections) and stop")
    a = ap.parse_args()
    if a.list:
        for r in units(read_part()):
            if not a.sections or r.section in a.sections:
                print(f"{r.cite:26} {r.text[:110]}")
        raise SystemExit(0)
    if a.library is not None:
        run_library(a.sop, a.library, a.sections, a.strategy, a.model, a.threshold or LIBRARY_THRESHOLD, a.batch, a.no_cache,
                    a.scope_only, a.cache, a.out)
    else:
        asyncio.run(run(a.sop or [SAMPLE], a.sections, a.strategy, a.model, a.threshold or SCOPE_THRESHOLD, a.batch, a.no_cache,
                        a.publish, a.scope_only, a.cache))
