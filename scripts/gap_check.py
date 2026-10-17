#!/usr/bin/env python3
"""Check company SOPs, requirement by requirement, against 21 CFR Part 211, and say why a gap is a gap.

    cd worker
    .venv/bin/python ../scripts/gap_check.py                                  # the sample SOP, sections chosen for it
    .venv/bin/python ../scripts/gap_check.py --sop SOP-QC-014 SOP-PR-021 --batch   # many SOPs, at half price
    .venv/bin/python ../scripts/gap_check.py --sections 211.137 211.166 211.170    # sections given by hand
    .venv/bin/python ../scripts/gap_check.py --scope-only                     # which sections apply, then stop
    .venv/bin/python ../scripts/gap_check.py --library --batch                # every "SOP-..." document as one library
    .venv/bin/python ../scripts/gap_check.py --local                          # no AI at all: local model, rules judge
    .venv/bin/python ../scripts/gap_check.py --local --judge cascade --batch  # rules first, the model only where they are unsure

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
8. --local runs with no AI and no API: the SOP's passages exactly as the rules cut them (strategy 'structural', built
   from the PDF with the worker's own chunker if the SOP was ingested with AI on), vectors from the worker's local
   open-source model, and the rules judge. --judge picks who decides: rules (the default with --local), model (the
   default without it), or cascade, where the rules' sure verdicts stand and only the lines they leave unsure go to
   the model (DECISIONS section 30).
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import html
import json
import math
import re
import sqlite3
import sys
import time
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

import anthropic
import numpy as np
import psycopg

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

from app.config import settings  # noqa: E402
from app.llm import claude, local, voyage  # noqa: E402

XML = ROOT / "scripts" / "regulations" / "21cfr211.xml"
OUT = ROOT / "scripts" / "benchmarks" / "gap-check.json"            # the sample SOP's report
RUNS = ROOT / "scripts" / "benchmarks" / "gap-check"                 # one report per other SOP
WEB_OUT = ROOT / "web" / "src" / "data" / "gap-check.json"           # what the SOP check page shows; --publish only
CACHE = ROOT / "scripts" / "benchmarks" / "gap-cache.sqlite"
PRICE = {"claude-haiku-5-5": (0.10, 0.50), "claude-sonnet-5-5": (2.0, 10.0), "claude-opus-5-5": (4.0, 20.0)}   # $ per million in/out, read 2026-10-15
BATCH_DISCOUNT = 0.5                                                 # Message Batches API: half of every token price
SCOPE_THRESHOLD = 0.65                                               # cosine; see DECISIONS section 24 for how it was set
LIBRARY_THRESHOLD = 0.62                                             # lower for a library: a section touched in passing costs no false gaps (section 25)
LOCAL_SCOPE_THRESHOLD = 0.275                                        # the same two lines for --local, where a score is a lift over
LOCAL_LIBRARY_THRESHOLD = 0.20                                       # the section's usual score, not a cosine (section 30)
LOCAL_MEANING_WEIGHT = 2.0                                           # --local scope: words score + 2 x meaning score

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
        intro: Requirement | None = None                 # an unmarked opening paragraph ("... They shall include:")
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
                    intro = Requirement(num, num, title, raw, title)
                    out.append(intro)
                continue
            for mk in markers:
                lvl = _level(mk, len(stack) and stack[-1][0] or 0)
                while stack and stack[-1][0] >= lvl:
                    stack.pop()
                stack.append((lvl, mk, ""))
            cite = num + "".join(f"({mk})" for _, mk, _ in stack)
            leads = ([intro.text if len(intro.text) < 400 else intro.text[:400] + "..."] if intro else []) + [t for _, _, t in stack[:-1]]
            lead = " > ".join(t for t in leads if t)    # the opening paragraph is the lead-in of (a), (b)... after it
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


@dataclass(frozen=True)
class Vectors:
    """Where the vectors come from, and the passages they go with. api: voyage-4 through its API, on the passages
    stored with AI context lines ('contextual'). local: the worker's own open-source model on this machine's CPU,
    on the passages exactly as the rules cut them ('structural'): no text leaves the machine, nothing is paid per
    SOP, and a passage's vector depends on nothing but its words. The scales differ, so each has its own lines."""
    model: str
    dim: int
    strategy: str
    column: str
    scope_line: float
    library_line: float
    local: bool

    def compute(self, texts: list[str], input_type: str) -> list[list[float]]:
        if self.local:
            return local.embed_passages(texts) if input_type == "document" else [local.embed_query(t) for t in texts]
        return voyage.embed(texts, input_type=input_type)


API = Vectors(settings.embedding_model, settings.embedding_dim, "contextual", "embedding", SCOPE_THRESHOLD, LIBRARY_THRESHOLD, False)
LOCAL = Vectors(settings.local_embedding_model, settings.local_embedding_dim, "structural", "embedding_local",
                LOCAL_SCOPE_THRESHOLD, LOCAL_LIBRARY_THRESHOLD, True)


def ensure_structural(c: psycopg.Connection, doc_id: str, name: str) -> bool:
    """Give a document ingested with AI on the passages pure mode would have stored: the worker's own rules on the
    PDF (no model), and vectors from the local model. Returns True if it had to build them."""
    if c.execute("select 1 from chunks where document_id = %s and strategy = 'structural' limit 1", (doc_id,)).fetchone():
        missing = c.execute("select id::text, content from chunks where document_id = %s and strategy = 'structural' and embedding_local is null",
                            (doc_id,)).fetchall()
        built = False
    else:
        import pymupdf

        from app import db, storage
        from app.chunk.structural import chunk_structural
        from app.parse.layout import parse_document
        path = c.execute("select storage_path from documents where id = %s", (doc_id,)).fetchone()[0]
        drafts = chunk_structural(parse_document(pymupdf.open(stream=storage.download(path), filetype="pdf")), name.rsplit(".", 1)[0])
        for d in drafts:
            d.image_png = None
        db.insert_chunks([d.to_row(doc_id, "structural") for d in drafts])
        missing = [(d.id, d.content) for d in drafts]
        built = True
    if missing:
        vecs = local.embed_passages([t for _, t in missing])
        with c.cursor() as cur:
            cur.executemany("update chunks set embedding_local = %s::vector where id = %s::uuid",
                            [("[" + ",".join(f"{x:.6f}" for x in v) + "]", i) for (i, _), v in zip(missing, vecs)])
    return built


def find_sop(c: psycopg.Connection, name_part: str) -> tuple[str, str]:
    row = c.execute("select id::text, name from documents where name ilike %s and status = 'ready' order by created_at desc limit 1",
                    (f"%{name_part}%",)).fetchone()
    if not row:
        raise SystemExit(f"no ready document matches {name_part!r}")
    return row


def passages(c: psycopg.Connection, doc_id: str, vec: Vectors) -> list[dict]:
    """The SOP's passages as written, front matter left out: a passage whose breadcrumb names no heading is the
    title block ("Version 3   Effective 01-Jul-2026"), which is never evidence for a requirement and changes with
    every revision, so it would make every line look new."""
    rows = c.execute("""select ordinal, raw_text, page_start, chunk_type, coalesce(metadata->>'breadcrumb', '') from chunks
                         where document_id = %s and strategy = %s and chunk_type <> 'table_row' order by ordinal""",
                     (doc_id, vec.strategy)).fetchall()
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


def sop_scope(c: psycopg.Connection, doc_id: str, vec: Vectors) -> tuple[str, str]:
    """The SOP's own scope statement (shown to the model), and every sentence that excludes something (for the rules)."""
    row = c.execute("select raw_text from chunks where document_id = %s and strategy = %s and raw_text ilike %s order by ordinal limit 1",
                    (doc_id, vec.strategy, "%applies to%")).fetchone()
    rows = c.execute("select raw_text from chunks where document_id = %s and strategy = %s and raw_text ~* 'does not apply|not applicable|excluded'",
                     (doc_id, vec.strategy)).fetchall()
    return (row[0] if row else ""), " ".join(r[0] for r in rows).lower()


def meaning_scores(c: psycopg.Connection, doc_id: str, vec: Vectors, reqs: list[Requirement], vectors: list[list[float]]) -> dict[str, float]:
    """Each section's score by meaning: every requirement sentence (embedded as a query) against every passage's
    stored vector, the one search uses; a section scores the mean of its two closest sentences, so one stray
    sentence in a long section does not pull it in."""
    rows = c.execute(f"""select {vec.column}::text from chunks where document_id = %s and strategy = %s and chunk_type <> 'table_row'
                          and {vec.column} is not null""", (doc_id, vec.strategy)).fetchall()
    if not rows:
        return {}
    P = np.array([json.loads(r[0]) for r in rows], dtype=np.float32)
    Q = np.array(vectors, dtype=np.float32)
    P /= np.linalg.norm(P, axis=1, keepdims=True)
    Q /= np.linalg.norm(Q, axis=1, keepdims=True)
    nearest = (P @ Q.T).max(axis=0)                     # each sentence's best passage
    per: dict[str, list[float]] = defaultdict(list)
    for r, v in zip(reqs, nearest):
        per[r.section].append(float(v))
    return {sec: sum(sorted(v, reverse=True)[:2]) / len(v[:2]) for sec, v in per.items()}


def _stems(text: str) -> list[str]:
    return [w[:6] for w in re.findall(r"[a-z][a-z\-]{2,}", text.lower()) if w not in STOP]


@lru_cache(maxsize=1)
def section_words(xml_path: Path = XML) -> tuple[dict[str, float], dict[str, dict[str, float]]]:
    """Each section of the Part as a bag of words: its title (counted three times) and every requirement sentence,
    cut to six-letter stems, weighted by how few sections use the stem (tf-idf over the Part's sections)."""
    bags: dict[str, list[str]] = defaultdict(list)
    for r in units(read_part(xml_path)):
        bags[r.section] += _stems(r.section_title) * 3 + _stems(r.text)
    df = Counter(w for bag in bags.values() for w in set(bag))
    idf = {w: math.log(len(bags) / n) for w, n in df.items()}
    return idf, {sec: _tfidf(bag, idf) for sec, bag in bags.items()}


def _tfidf(words: list[str], idf: dict[str, float]) -> dict[str, float]:
    v = {w: (1 + math.log(n)) * idf[w] for w, n in Counter(w for w in words if w in idf).items()}
    size = math.sqrt(sum(x * x for x in v.values())) or 1.0
    return {w: x / size for w, x in v.items()}


def word_scores(c: psycopg.Connection, doc_id: str, vec: Vectors) -> dict[str, float]:
    """Each section's score by words: the cosine of the whole document's tf-idf vector and the section's."""
    idf, sections = section_words()
    text = " ".join(r[0] for r in c.execute("select raw_text from chunks where document_id = %s and strategy = %s and chunk_type <> 'table_row'",
                                             (doc_id, vec.strategy)))
    d = _tfidf(_stems(text), idf)
    return {sec: sum(d.get(w, 0.0) * x for w, x in v.items()) for sec, v in sections.items()}


_local_raw: dict[str, dict[str, float]] = {}            # document id -> section -> words + meaning, for this run


def local_raw(c: psycopg.Connection, doc_id: str, reqs: list[Requirement], vectors: list[list[float]]) -> dict[str, float]:
    if doc_id not in _local_raw:
        meaning = meaning_scores(c, doc_id, LOCAL, reqs, vectors)
        words = word_scores(c, doc_id, LOCAL) if meaning else {}
        _local_raw[doc_id] = {sec: words[sec] + LOCAL_MEANING_WEIGHT * m for sec, m in meaning.items()}
    return _local_raw[doc_id]


def local_background(c: psycopg.Connection, number: str, reqs: list[Requirement], vectors: list[list[float]]) -> dict[str, float]:
    """Each section's usual score: its mean over every other document stored with local vectors, leaving out
    copies and revisions of the SOP being scored (same SOP number), which would score its own sections high."""
    rows = c.execute("""select d.id::text, d.name from documents d where d.status = 'ready' and exists
                          (select 1 from chunks ch where ch.document_id = d.id and ch.strategy = 'structural' and ch.embedding_local is not null)""").fetchall()
    others = [local_raw(c, i, reqs, vectors) for i, name in rows if sop_number(name) != number]
    others = [o for o in others if o]
    return {sec: float(np.mean([o[sec] for o in others])) for sec in others[0]} if others else {}


def choose_sections(c: psycopg.Connection, doc_id: str, vec: Vectors, reqs: list[Requirement], vectors: list[list[float]],
                    threshold: float) -> list[dict]:
    """Every section of the Part, scored for this SOP and best first.

    api: the meaning score on the stored vectors, whose context line names the passage's topic. The passages' own
    words alone separate 211.137 from 211.22 less well (0.69 and 0.65 on the sample, against 0.68 and 0.62).

    local: the small local model squeezes every section into 0.67 to 0.84 on every SOP, so its scores alone cannot
    tell an SOP's topic from GMP vocabulary in general. The score is the words score plus twice the meaning score,
    minus that section's usual score in the other stored documents: a section is in scope when this SOP is about it
    clearly more than documents in general are (DECISIONS section 30)."""
    titles = {r.section: r.section_title for r in reqs}
    if vec.local:
        name = c.execute("select name from documents where id = %s", (doc_id,)).fetchone()[0]
        raw = local_raw(c, doc_id, reqs, vectors)
        usual = local_background(c, sop_number(name), reqs, vectors)
        scores = {sec: v - usual.get(sec, 0.0) for sec, v in raw.items()}
    else:
        scores = meaning_scores(c, doc_id, vec, reqs, vectors)
    out = [{"section": sec, "title": titles[sec], "score": round(v, 3), "in_scope": v >= threshold} for sec, v in scores.items()]
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

    def embed(self, texts: list[str], input_type: str, vec: Vectors) -> list[list[float]]:
        if settings.fake_embeddings and not vec.local:  # fake vectors are not worth keeping
            return voyage.embed(texts, input_type=input_type)
        keys = [_hash(vec.model, vec.dim, input_type, t) for t in texts]
        have: dict[str, list[float]] = {}
        for i in range(0, len(keys), 500):
            part = keys[i:i + 500]
            for k, blob in self.db.execute(f"select key, vector from vectors where key in ({','.join('?' * len(part))})", part):
                have[k] = np.frombuffer(blob, dtype=np.float32).tolist()
        missing = [i for i, k in enumerate(keys) if k not in have]
        if missing:
            new = vec.compute([texts[i] for i in missing], input_type)
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
                   "radiopharm": "radiopharmaceutical", "investigational": "investigational", "reconstitut": "reconstituted",
                   "sterile": "sterile", "otc": "otc", "penicillin": "penicillin"}
NOT_SOLID_ORAL = ("allergenic", "radioactive", "radiopharm", "reconstitut", "sterile")   # never a tablet or a capsule

# Words the regulation and an SOP use for the same thing: a requirement's term is found in an SOP when any form in
# its group is. Each group is a general GMP word, not a word of one SOP; "essential" groups name a thing or an act
# a requirement cannot be met without, so an SOP that never mentions one does not meet it. ESSENTIAL_FORM narrows
# a group to the forms that ask for the thing ("shall be examined", not "each attribute examined").
SAME: list[tuple[str, bool]] = [
    (r"active ingredients?|active pharmaceutical ingredients?|apis?|drug substances?", True),
    (r"visual\w*", True),
    (r"deteriorat\w*|degrad\w*", True),
    (r"examin\w*|inspect\w*", True),
    (r"investigat\w*", True),
    (r"once a year|annual\w*|yearly|every year|each year|every 12 months|every twelve months", True),
    (r"statistic\w*", True),
    (r"complain\w*", True),
    (r"returned|returns?", True),
    (r"salvag\w*", True),
    (r"reconstitut\w*", True),
    (r"calibrat\w*", True),
    (r"quarantin\w*|segregat\w*|cages?", True),
    (r"reconcil\w*", True),
    (r"microbiolog\w*|microorganisms?|microbial", True),
    (r"pyrogens?|endotoxins?", True),
    (r"calculat\w*", True),
    (r"yields?", True),
    (r"deviat\w*|out.of.specification|discrepanc\w*|differen\w*|(?:does|do) not (?:match|agree)|mismatch\w*", True),
    (r"reject\w*", True),
    (r"expir\w*|shelf.life", False),
    (r"retain\w*|retention|kept|keep\w*|maintain\w*", False),
    (r"stor(?:e|ed|es|age|ing)", False),
    (r"records?|recorded|recording|logs?|logged|registers?|database|documented|entered", False),
    (r"written|protocols?|procedures?|instructions?|programmes?|programs?", False),
    (r"label\w*", False),
    (r"batch\w*|lots?", False),
    (r"tests?|tested|testing|assays?|analys\w*", False),
    (r"quality control unit|quality unit|qa|qc|quality assurance|quality control", False),
    (r"container.closure|market pack\w*|immediate containers?", False),
    (r"components?|raw materials?", False),
    (r"distribut\w*|shipp\w*|dispatch\w*", False),
    (r"clean\w*|saniti\w*", False),
    (r"equipment|machines?|instruments?", False),
    (r"specifications?", False),
    (r"sign\w*|initial\w*", False),
    (r"approv\w*", False),
    (r"sampl\w*", False),
]
_SAME = [(re.compile(rf"\b(?:{rx})\b"), essential) for rx, essential in SAME]
ESSENTIAL_FORM = {r"examin\w*|inspect\w*": r"\b(?:examination|inspection)s?\b(?! and test)|\b(?:be|are|is|been)\s+(?:\w+ly\s+)?(?:examined|inspected)\b"
                                          r"|\bexamined visually\b"}
_FORM = {i: re.compile(ESSENTIAL_FORM[rx]) for i, (rx, _) in enumerate(SAME) if rx in ESSENTIAL_FORM}
GENERIC = {i for i, (rx, _) in enumerate(SAME) if rx.startswith(("expir", "retain", "records?", "written", "stor(", "batch"))}


# The regulation's own filler, which no SOP repeats: "drug product" is "product" in every SOP, and "to assure valid
# estimates" or "designed to assess" ask for nothing an SOP would write down.
FILLER = set("""drug drugs assure ensure determine determined determining determination based related stated designed assess
characteristics necessary perform performed required consists consist essentially meets meet applicable standards valid
estimates""".split())


def _terms(text: str) -> list[str]:
    words = re.findall(r"[a-z][a-z\-]{3,}|\d+(?:\.\d+)?", text.lower())
    seen: list[str] = []
    for w in words:
        if w not in STOP and w not in FILLER and w not in seen:
            seen.append(w)
    return seen


def _has(term: str, text: str) -> bool:
    stem = term[:6] if len(term) > 6 else term
    return re.search(rf"\b{re.escape(stem)}", text) is not None


def obligation(text: str) -> str:
    """The part of a requirement an SOP has to answer: without its purpose ("To assure that ..., "), its exceptions
    ("except those for sterility and pyrogens", "unless visual examination would ..."), and its cross-references
    ("described in § 211.166", "in accordance with § 211.192"), which name other rules rather than ask anything."""
    t = re.sub(r"^To (?:assure|ensure) [^,]+, ", "", text)
    t = re.sub(r"^Except for [^,]+, ", "", t)
    t = re.sub(r",?\s*\b(?:except|unless)\b[^,;.]*", "", t)
    t = re.sub(r"\s*\([^()]*\)", "", t)                    # "(either by medical examination or ...)", "(except routine ...)"
    t = re.sub(r"\(?\b(?:as )?(?:described in|in accordance with|under|required by|of) §§?\s*[\d.()a-z, and]+(?:of this (?:chapter|part|section))?\)?", "", t)
    t = re.sub(r"\b(?:described in )?paragraphs? \([a-z0-9]+\)(?:\s*\(\w+\))*(?: and \(\w+\))? of this section", "", t)
    return re.sub(r"\s+", " ", t).strip()


def concepts(text: str) -> list[tuple[int, str]]:
    """The thesaurus groups a text mentions, with the words it used."""
    low = text.lower()
    return [(i, m.group(0)) for i, (rx, _) in enumerate(_SAME) if (m := rx.search(low))]


def needed(text: str, whole: str) -> list[tuple[int, str]]:
    """The essential groups a requirement asks for, in a form that asks for them. A word offered as one of
    alternatives ("tests, or examinations", "medical examination or supervisory observation") is asked for only
    when the SOP has none of the others."""
    low = text.lower()
    out = []
    for i, said in concepts(text):
        if not _SAME[i][1] or (i in _FORM and not _FORM[i].search(low)):
            continue
        m = _SAME[i][0].search(low)
        before = re.search(r"((?:[\w-]+,?\s+){1,3})or\s+(?:[\w-]+\s+){0,2}$", low[:m.start()])
        after = re.match(r",?\s+(?:[\w-]+\s+){0,2}or\s+((?:[\w-]+\s*){1,3})", low[m.end():])
        others = [w for g in (before, after) if g for w in _terms(g.group(1)) if not _SAME[i][0].search(w)]
        if any(_found(w, whole) for w in others):
            continue
        out.append((i, said))
    return out


def _found(term: str, text: str) -> bool:
    for rx, _ in _SAME:
        if rx.fullmatch(term) or rx.match(term):
            return rx.search(text) is not None
    return _has(term, text)


NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
                "eleven": 11, "twelve": 12, "eighteen": 18, "twenty-four": 24, "thirty": 30, "thirty-six": 36}
UNIT_DAYS = {"day": 1, "week": 7, "month": 30, "year": 365}
_PERIOD = re.compile(r"\b(\d+|" + "|".join(NUMBER_WORDS) + r")\s+(day|week|month|year)s?\s+(?:after|from|following)\s+(?:the\s+)?([a-z ]{3,40})")
ANCHORS = {"expir": "the expiry date", "distribut": "distribution", "receiv": "receipt", "manufactur": "manufacture"}


def periods(text: str) -> list[tuple[int, str, str, str]]:
    """Every "N units after <anchor>" in a text: (days, as written, anchor, the sentence it is in)."""
    out = []
    for sent in re.split(r"(?<=[.;])\s+", text):
        for m in _PERIOD.finditer(sent.lower()):
            n = int(m.group(1)) if m.group(1).isdigit() else NUMBER_WORDS[m.group(1)]
            anchor = next((a for a in ANCHORS if a in m.group(3)), None)
            if anchor:
                out.append((n * UNIT_DAYS[m.group(2)], f"{m.group(1)} {m.group(2)}{'s' if n > 1 else ''}", anchor, sent))
    return out


MET_COVER = 0.7                 # share of a requirement's terms one passage must hold for the rules to call it met
_LIST = re.compile(r"((?:[a-z\-]+ ){0,2}[a-z\-]+(?:, (?:[a-z\-]+ ){0,2}[a-z\-]+)+),? and ((?:[a-z\-]+ ){0,2}[a-z\-]+)")


def listed(text: str) -> list[str]:
    """The items of every "a, b, and c" list in a requirement, by their head word ("reply" in "reply to complainant"):
    each one is asked for, so a passage missing one is not "met" however many other words it shares ("date, time,
    product, and lot number")."""
    out: list[str] = []
    for m in _LIST.finditer(text.lower()):
        for item in m.group(1).split(", ") + [m.group(2)]:
            words = item.split()
            head = next((words[i - 1] for i, w in enumerate(words) if i and w in ("of", "to", "for")), words[-1])
            if head not in STOP and len(head) > 2 and head not in out:
                out.append(head)
    return out


def _v(status: str, reason: str, quote: str = "") -> dict:
    return {"status": status, "quote": quote, "reason": reason}


def rules_judge(req: Requirement, passages: list[dict], sop: dict) -> dict:
    """Decide what can be decided without a model, and say "unsure" about the rest. In order:
    1. not applicable: a sentence that only grants an exemption asks nothing of an SOP that does not claim it; a
       requirement (or the lead-in above it) about a product class the SOP's scope excludes; a requirement only for
       products exempt from expiry dating, when the SOP dates every product.
    2. not met: the requirement needs something (an active ingredient, a visual examination, an investigation, a
       yearly frequency...) that the SOP never mentions anywhere, under any of its usual names.
    3. numbers: a retention period that is shorter in the SOP than in the rule ("six months after the expiry date"
       against "1 year") is partly met; one at least as long counts toward met.
    4. words: the passage closest to holding all of the requirement's terms (forms of a word and the SOP's usual
       names for it count) holds 70% or more: met. Anything else is left unsure, for the model or a person."""
    body = req.text.lower()
    whole = " ".join(p["text"] for p in sop["passages"]).lower()
    exclusions = sop["exclusions"]

    rest = re.sub(r"\b(?:are|is|shall be) exempt(?:ed)? from\b|\bshall not be enforced\b|\b(?:is|are|may be) waived\b", "", body)
    if rest != body and not re.search(r"\b(?:shall|must)\b", rest):
        return _v("not_applicable", "The rule grants an exemption; it asks nothing of an SOP that does not claim it.")
    lead = (req.context + " " + body).lower()
    solid_oral = re.search(r"\btablets?\b|\bcapsules?\b|oral solid", sop["scope"].lower() + " " + whole[:600])
    for key, word in PRODUCT_CLASSES.items():
        if not re.search(rf"\b{key}", lead):
            continue
        if re.search(rf"\b{key}", exclusions):
            return _v("not_applicable", f"The SOP's scope excludes {word} products.")
        if key in NOT_SOLID_ORAL and solid_oral and not re.search(rf"\b{key}", whole):
            return _v("not_applicable", f"The SOP covers tablets and capsules, never {word} products.")
    if re.search(r"exempt (?:from|for) bearing an expiration date", lead) and re.search(
            r"\b(?:every|each|all)\b[^.]{0,60}\bexpir|\bexpir[^.]{0,80}\b(?:every|each|all) (?:product|label|batch)", whole):
        return _v("not_applicable", "Applies only to products exempt from expiry dating; the SOP dates every product.")

    if body.rstrip().endswith(":"):
        return _v("unsure", "A lead-in: the items under it are checked one by one.")
    if re.search(r"\b(?:one|any) of the following\b", req.context.lower()):
        return _v("unsure", "One of several alternatives: the SOP need not do this one.")

    core = obligation(req.text)
    absent = [said for i, said in needed(core, whole) if not _SAME[i][0].search(whole)]
    if absent:
        return _v("not_met", "The SOP never mentions " + ", ".join(dict.fromkeys(absent)) + ".")

    # Retention periods: the SOP's sentence must share the requirement's subject (two words beyond dates and keeping).
    subject = [w for w in _terms(core) if not any(_SAME[i][0].fullmatch(w) for i in GENERIC)
               and w not in {"after", "date", "least", "years", "year", "months", "month", "days", "longer", "whichever"}]
    longer, matched, asked = None, set(), {a for _, _, a, _ in periods(core)}
    for days, said, anchor, _ in periods(core):
        for sd, ssaid, sanchor, sent in periods(whole):
            if sanchor != anchor or len([w for w in subject if _found(w, sent.lower())]) < 2:
                continue
            if sd < days:
                return _v("partly_met", f"The SOP keeps them {ssaid} after {ANCHORS[anchor]}; the rule asks for {said}.", sent.strip())
            longer, matched = (ssaid, sent.strip()), matched | {anchor}
    if longer and "whichever is longer" in body and asked - matched:
        missing = ", ".join(ANCHORS[a] for a in sorted(asked - matched))
        return _v("partly_met", f"The SOP counts only from one event; the rule also counts from {missing}, whichever is longer.", longer[1])

    terms = _terms(core)
    if not terms:
        return _v("unsure", "Nothing distinctive to look for.")
    best, best_missing, best_text = 0.0, terms, ""
    for p in passages:
        t = p["text"].lower()
        missing = [w for w in terms if not _found(w, t)]
        cover = 1 - len(missing) / len(terms)
        if cover > best:
            best, best_missing, best_text = cover, missing, p["text"]
    if longer and best >= 0.5:
        return _v("met", f"The SOP keeps them {longer[0]} after the same event, at least what the rule asks.", longer[1])
    if best >= MET_COVER:
        lacking = [w for w in listed(core) if not _found(w, best_text.lower())]
        if lacking:
            return _v("unsure", "The closest passage has most of it but not: " + ", ".join(lacking) + ".")
        sent = max(re.split(r"(?<=[.;])\s+", best_text), key=lambda x: sum(_found(w, x.lower()) for w in terms))
        if re.search(r"\b(?:is|are|be|was|were) not\b|\bnever\b|\bnot (?:tested|done|performed|kept|recorded|required|used|made)\b", sent.lower()):
            return _v("unsure", "The SOP's sentence on this says what is not done.", sent.strip())
        return _v("met", f"One passage holds {round(best * 100)}% of the requirement's terms.", best_text[:300])
    return _v("unsure", f"The closest passage holds {round(best * 100)}% of the terms; missing: " + ", ".join(best_missing[:5]) + ".")


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
    rules: dict                         # the rules judge's verdict: status, quote, reason
    params: dict
    evidence: str
    judge: str
    key: str
    verdict: dict | None = None
    source: str = ""                    # rules | cache | shared (same evidence as a line judged for another SOP this run) | model | failed
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


JUDGES = ("rules", "cascade", "model")


def by_rules(x: Line, judge: str) -> bool:
    """Let the rules decide the line if the judge says so. rules: every line takes the rules' verdict, "unsure"
    included, which leaves it for a person. cascade: the rules' sure verdicts stand and only the lines they are
    unsure of go to the model. model: the model judges every line (the rules' verdict is kept beside it)."""
    if judge == "rules" or (judge == "cascade" and x.rules["status"] != "unsure"):
        x.verdict, x.source = x.rules, "rules"
        return True
    return False


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
             vec: Vectors, threshold: float, rank: bool) -> dict:
    """One SOP's passages, their own-words vectors, its scope line and, if asked, its section ranking."""
    if vec.local and ensure_structural(c, doc_id, doc_name):
        print(f"{doc_name}: cut by the worker's rules and embedded by the local model (it was ingested with AI on)")
    sop = passages(c, doc_id, vec)
    P = np.array(cache.embed([p["text"] for p in sop], "document", vec), dtype=np.float32)   # by text: a revision re-embeds only what changed
    P /= np.linalg.norm(P, axis=1, keepdims=True)
    scope, exclusions = sop_scope(c, doc_id, vec)
    return {"doc_id": doc_id, "name": doc_name, "stem": doc_name.rsplit(".", 1)[0], "passages": sop, "P": P,
            "scope": scope, "exclusions": exclusions,
            "ranking": choose_sections(c, doc_id, vec, reqs, vectors, threshold) if rank else []}


def make_line(s: dict, r: Requirement, v: list[float], kw: np.ndarray, model: str) -> Line:
    """One requirement judged on one SOP: its three closest passages and the request that would judge them. The key
    holds nothing about which SOP this is, so the same words anywhere get the same verdict."""
    found = closest(s["passages"], s["P"], v, kw)
    params = judge_params(r, found, s["scope"], model)
    evidence = _hash(sorted(p["text"] for p in found), s["scope"])
    judge = _hash({name: val for name, val in params.items() if name != "messages"}, JUDGE_PROMPT, r.cite, r.context, r.paragraph, r.text)
    return Line(s["stem"], r, found, rules_judge(r, found, s), params, evidence, judge, _hash(r.cite, evidence, judge))


def prepare(c: psycopg.Connection, cache: Cache, name_part: str, reqs: list[Requirement], vectors: list[list[float]],
            sections: list[str] | None, vec: Vectors, model: str, threshold: float) -> dict:
    """Scope one SOP and find the evidence for each of its lines. No model is called here."""
    s = load_sop(c, cache, *find_sop(c, name_part), reqs, vectors, vec, threshold, rank=not sections)
    chosen = list(sections) if sections else [x["section"] for x in s["ranking"] if x["in_scope"]]
    mine = [(r, v) for r, v in zip(reqs, vectors) if r.section in chosen]
    K = keyword_scores(c, [f"{r.section_title}. {r.text}" for r, _ in mine], [p["text"] for p in s["passages"]])
    lines = [make_line(s, r, v, kw, model) for (r, v), kw in zip(mine, K)]
    return {"doc_id": s["doc_id"], "name": s["name"], "stem": s["stem"], "sections": chosen, "ranking": s["ranking"], "lines": lines}


def right(status: str, expected: str, by_rules: bool) -> bool:
    """A verdict as the SOP was written. The rules may say "not met" where "partly met" was expected: either way the
    line is shown as a gap, and the rules cannot weigh how far an SOP goes."""
    return status == expected or (by_rules and expected == "partly_met" and status == "not_met")


def score(rows: list[dict], key: str) -> dict:
    """How a judge did on the lines with a known answer: decided (not "unsure"), right, and left for a person."""
    graded = [x for x in rows if x["expected"] and x[key]]
    decided = [x for x in graded if x[key]["status"] != "unsure"]
    ok = [x for x in decided if right(x[key]["status"], x["expected"], key == "rules" or x["verdict_from"] == "rules")]
    return {"graded": len(graded), "decided": len(decided), "right": len(ok), "unsure": len(graded) - len(decided)}


def report(s: dict, model: str, threshold: float, given: bool, vec: Vectors = API, judge: str = "model") -> dict:
    expected = EXPECTED if s["stem"] == SAMPLE else {}
    lines: list[Line] = s["lines"]
    rows = [{"cite": x.req.cite, "section_title": x.req.section_title, "context": x.req.context, "text": x.req.text,
             "passages": [{"page": p["page"], "text": p["text"][:600]} for p in x.passages],
             "rules": x.rules, "model": x.verdict if x.source != "rules" else None, "verdict": x.verdict,
             "expected": expected.get(x.req.cite), "verdict_from": x.source} for x in lines]
    bought = [x for x in lines if x.mode]
    new = [x for x in lines if x.source in ("model", "failed")]
    full = sum(x.dollars for x in bought)
    scope: dict = {"how": "given" if given else "measured", "vectors": vec.model, "threshold": threshold, "ranking": s["ranking"][:12]}
    if not given and s["stem"] == SAMPLE:
        picked = set(s["sections"])
        scope["graded"] = {"expected": sorted(SAMPLE_SECTIONS), "found": sorted(SAMPLE_SECTIONS & picked),
                           "missed": sorted(SAMPLE_SECTIONS - picked), "extra": sorted(picked - SAMPLE_SECTIONS)}
    return {
        "sop": s["stem"], "regulation": "21 CFR Part 211", "regulation_as_of": "2026-10-13",
        "sections": s["sections"], "scope": scope, "requirements": len(rows), "judge": judge,
        "rules_score": score(rows, "rules"), "model_score": score(rows, "model"), "verdict_score": score(rows, "verdict"),
        "decided_by_rules": sum(1 for x in lines if x.source == "rules" and x.rules["status"] != "unsure"),
        "left_for_review": sum(1 for x in lines if x.verdict["status"] == "unsure"),
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


def write(rep: dict, model: str, publish: bool, local_run: bool = False) -> Path:
    if rep["sop"] != SAMPLE or local_run:       # a run on the local model is kept apart from the page's data
        stem = "gap-check" if rep["sop"] == SAMPLE else re.sub(r"[^a-z0-9]+", "-", rep["sop"].lower()).strip("-")
        path = (OUT.parent if rep["sop"] == SAMPLE else RUNS) / (stem + ("-local" if local_run else "") + ".json")
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
LIBRARY_LOCAL_OUT = ROOT / "scripts" / "benchmarks" / "gap-library-local.json"
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
                    vectors: list[list[float]], sections: list[str] | None, vec: Vectors, model: str, threshold: float) -> dict:
    """Every member's section ranking, the library's sections and their owners, and for each requirement the SOPs
    to ask, owner first. No model is called here.

    A section is the library's when some SOP scores it at the line; its owner is the SOP that scores it highest.
    A requirement is asked of its owner, then of at most LIBRARY_ALSO other SOPs whose closest passage to it scores
    at least the owner's (minus LIBRARY_MARGIN), closest first: the judge only ever sees an SOP's three closest
    passages, so an SOP with nothing nearer than the owner's evidence would not be found to meet it either."""
    sops = [load_sop(c, cache, doc_id, name, reqs, vectors, vec, threshold, rank=True) for doc_id, name in members]
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


def judge_library(cache: Cache, groups: list[dict], batch: bool, no_cache: bool, judge: str = "model") -> int:
    """Ask in rounds: every requirement's owner first, then, for those not met, the next SOP, until each is met,
    ruled out by its owner's scope, or out of SOPs to ask. A verdict already in the cache costs nothing and counts
    in any round, so a library whose SOPs were checked one by one is checked as a library for free. Returns the
    number of rounds that called the model."""
    every = {x.key: x for g in groups for x in g["candidates"]}
    known = {} if no_cache else cache.verdicts(sorted(every))
    done: dict[str, Line] = {}                          # key -> the line whose verdict this run holds

    def take(x: Line) -> bool:
        if by_rules(x, judge):
            return True
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


def library_report(lib: dict, model: str, threshold: float, left_out: list[str], rounds: int, given: bool,
                   vec: Vectors = API, judge: str = "model") -> dict:
    members, groups, owners = lib["members"], lib["groups"], lib["owners"]
    sample_in = any(s["stem"] == SAMPLE for s in members)
    rows = []
    for g in groups:
        r, by = g["req"], g["by"]
        # owned: some SOP is clearly about the section (scores it at one SOP's own line); touched: the library only
        # comes near it, so a gap there may mean the library lacks an SOP for it rather than that the owner is short.
        tier = "owned" if owners[r.section]["score"] >= vec.scope_line else "touched"
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
        if o["score"] < vec.scope_line:
            mine = [x for x in rows if x["section"] == o["section"]]
            touched.append({"section": o["section"], "title": o["title"], "closest": members[o["owner"]]["stem"], "score": o["score"],
                            "requirements": len(mine), **{st: sum(1 for x in mine if x["status"] == st)
                                                          for st in ("met", "partly_met", "not_met", "not_applicable", "unsure")}})
    graded = [x for x in rows if x["expected"]]
    return {
        "library": [s["stem"] for s in members], "left_out": left_out, "regulation": "21 CFR Part 211", "regulation_as_of": "2026-10-13",
        "judge": judge, "decided_by_rules": sum(1 for x in seen.values() if x.source == "rules" and x.rules["status"] != "unsure"),
        "scope": {"how": "given" if given else "measured", "vectors": vec.model, "threshold": threshold, "owned_from": vec.scope_line,
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


def run_library(names: list[str] | None, prefix: str, sections: list[str] | None, vec: Vectors, judge: str, model: str, threshold: float,
                batch: bool, no_cache: bool, scope_only: bool, cache_path: Path, out: Path) -> None:
    cache = Cache(cache_path)
    reqs = units(read_part())
    vectors = cache.embed([f"{r.section_title}. {r.text}" for r in reqs], "query", vec)
    with _conn() as c:
        members, left_out = library_members(c, names, prefix)
        lib = prepare_library(c, cache, members, reqs, vectors, sections, vec, model, threshold)
    stems = [s["stem"] for s in lib["members"]]
    print(f"library of {len(stems)} SOPs" + (f" ({len(left_out)} older or duplicate copies left out: {'; '.join(left_out)})" if left_out else ""))
    print(f"{len(lib['owners'])} sections at {threshold}, {len(lib['groups'])} requirements, "
          f"{sum(len(g['candidates']) for g in lib['groups'])} SOP lines that could be asked")
    for o in sorted(lib["owners"].values(), key=lambda o: -o["score"]):
        also = [f"{n[:10]} {v:.3f}" for n, v in o["in_scope_of"] if n != stems[o["owner"]]]
        print(f"  {o['section']:8} {o['score']:.3f}  owner {stems[o['owner']][:40]:40}" + (f"  also in scope of {', '.join(also)}" if also else ""))
    if scope_only:
        return
    rounds = judge_library(cache, lib["groups"], batch, no_cache, judge)
    rep = library_report(lib, model, threshold, left_out, rounds, given=bool(sections), vec=vec, judge=judge)
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
              f"(closest SOP under {vec.scope_line}): the library may have no SOP for them")
        for t in rep["touched_sections"]:
            print(f"  {t['title'][:52]:52} closest {t['closest'][:10]} {t['score']:.3f}: "
                  f"{t['not_met']} not met, {t['partly_met']} partly, {t['met']} met, {t['not_applicable']} n/a of {t['requirements']}")
    if rep["sample_score"]["graded"]:
        s = rep["sample_score"]
        print(f"sample: {s['right']} of {s['graded']} as expected; {s['gaps_shown']} of its {s['gaps_expected']} known gaps still shown")
    u, t = rep["model_usage"], rep["this_run"]
    print(f"library: {u['calls']} verdicts in {u['rounds']} rounds, {u['in']:,} in / {u['out']:,} out tokens, ${u['dollars']:.4f} as bought"
          f" ({u['batch_calls']} through the batch API); checked one by one at the same line: {u['lines_one_by_one']} lines")
    print(f"this run: {t['calls']} model calls, {t['from_cache']} from the cache, {rep['decided_by_rules']} decided by the rules, ${t['dollars']:.4f}")
    print(f"wrote {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}")


async def run(names: list[str], sections: list[str] | None, vec: Vectors, judge: str, model: str, threshold: float,
              batch: bool, no_cache: bool, publish: bool, scope_only: bool, cache_path: Path = CACHE) -> None:
    cache = Cache(cache_path)
    reqs = units(read_part())
    queries = [f"{r.section_title}. {r.text}" for r in reqs]
    vectors = cache.embed(queries, "query", vec)        # every sentence of the Part, embedded once for all SOPs
    with _conn() as c:
        if scope_only:
            for n in names:
                doc_id, doc_name = find_sop(c, n)
                if vec.local:
                    ensure_structural(c, doc_id, doc_name)
                print_ranking(doc_name.rsplit(".", 1)[0], choose_sections(c, doc_id, vec, reqs, vectors, threshold))
            return
        sops = [prepare(c, cache, n, reqs, vectors, sections, vec, model, threshold) for n in names]

    lines = [x for s in sops for x in s["lines"]]
    ask = [x for x in lines if not by_rules(x, judge)]
    known = {} if no_cache else cache.verdicts(sorted({x.key for x in ask}))
    first: dict[str, Line] = {}
    for x in ask:
        if x.key in known:
            k = known[x.key]
            x.verdict, x.source, x.tokens, x.dollars, x.mode = k["verdict"], "cache", (k["in"], k["out"]), k["dollars"], k["mode"]
        elif x.key in first:
            x.source = "shared"
        else:
            first[x.key] = x
    todo = list(first.values())
    print(f"{len(sops)} SOPs, {len(lines)} lines: {sum(x.source == 'rules' for x in lines)} decided by the rules, "
          f"{sum(x.source == 'cache' for x in lines)} from the cache, "
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
        rep = report(s, model, threshold, given=bool(sections), vec=vec, judge=judge)
        path = write(rep, model, publish and not vec.local, vec.local)
        if s["ranking"]:
            print_ranking(s["stem"], s["ranking"])
        if "graded" in rep["scope"]:
            g = rep["scope"]["graded"]
            print(f"  scope: found {len(g['found'])} of {len(g['expected'])} expected sections, missed {g['missed'] or 'none'}, extra {g['extra'] or 'none'}")
        print(f"\n{'citation':24} {'expected':15} {'rules':15} {'verdict':15} verdict from")
        for x in rep["rows"]:
            print(f"{x['cite']:24} {str(x['expected']):15} {x['rules']['status']:15} {x['verdict']['status']:15} {x['verdict_from']}")
        if rep["rules_score"]["graded"]:
            print("rules:", rep["rules_score"], "\nverdict:", rep["verdict_score"])
        u, t = rep["model_usage"], rep["this_run"]
        print(f"this SOP: {u['calls']} verdicts, {u['in']:,} in / {u['out']:,} out tokens, ${u['dollars']:.4f} as bought"
              f" ({u['batch_calls']} through the batch API)")
        print(f"this run: {t['calls']} model calls, {t['from_cache']} from the cache, {t['shared']} shared with another SOP, ${t['dollars']:.4f}")
        print(f"wrote {path.relative_to(ROOT)}" + (f" and {WEB_OUT.relative_to(ROOT)}" if publish and path == OUT else ""))
        summary.append((s["stem"], len(s["sections"]), rep["requirements"], rep["decided_by_rules"], u["calls"],
                        t["from_cache"] + t["shared"], t["calls"], rep["left_for_review"], t["dollars"], u["dollars"]))

    if len(summary) > 1:
        print(f"\n{'SOP':52} {'sections':>8} {'lines':>6} {'rules':>6} {'model':>6} {'reused':>6} {'asked':>6} {'unsure':>6} {'paid now':>9} {'per SOP':>9}")
        for stem, *n, paid, per in summary:
            print(f"{stem[:52]:52} " + " ".join(f"{x:>{w}}" for x, w in zip(n, (8, 6, 6, 6, 6, 6, 6))) + f" {paid:9.4f} {per:9.4f}")
        print(f"{'total':52} {'':8} " + " ".join(f"{sum(r[i] for r in summary):6}" for i in range(2, 8)) + f" {sum(r[8] for r in summary):9.4f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sop", nargs="+", help=f"name fragments; each picks the newest ready document it matches (default: {SAMPLE})")
    ap.add_argument("--library", nargs="?", const="SOP-", metavar="PREFIX",
                    help="judge the SOPs as one company's library: a requirement is a gap only when none of them meets it, "
                         "and each gap is named against the SOP that should own it. The library is the --sop list, or else "
                         "every ready document whose name starts with PREFIX (default SOP-), newest version of each")
    ap.add_argument("--sections", nargs="+", help="check these sections instead of choosing them for each SOP")
    ap.add_argument("--threshold", type=float, help=f"how close a section must come to be in scope (default {SCOPE_THRESHOLD}, or "
                                                    f"{LIBRARY_THRESHOLD} with --library; {LOCAL_SCOPE_THRESHOLD} and {LOCAL_LIBRARY_THRESHOLD} with --local)")
    ap.add_argument("--local", action="store_true", help="no AI and no API: the passages as the rules cut them, vectors from the local "
                                                         "open-source model, and the rules judge unless --judge says otherwise")
    ap.add_argument("--judge", choices=JUDGES, help="who decides each line: rules (no model; the default with --local), model "
                                                    "(every line; the default otherwise), or cascade (the model only where the rules are unsure)")
    ap.add_argument("--cache", type=Path, default=CACHE, help="the verdict cache to read and fill")
    ap.add_argument("--out", type=Path, help=f"where --library writes its report (default {LIBRARY_OUT.relative_to(ROOT)}, "
                                             f"or {LIBRARY_LOCAL_OUT.name} beside it with --local)")
    ap.add_argument("--scope-only", action="store_true", help="print which sections apply to each SOP and stop")
    ap.add_argument("--batch", action="store_true", help="send the model calls through the Message Batches API: half price, minutes to hours")
    ap.add_argument("--no-cache", action="store_true", help="judge every line again (the new verdicts replace the cached ones)")
    ap.add_argument("--publish", action="store_true", help=f"also write the sample's report to {WEB_OUT.relative_to(ROOT)}, which the SOP check page shows")
    ap.add_argument("--model", default="claude-haiku-5-5", choices=list(PRICE))
    ap.add_argument("--list", action="store_true", help="print the requirements of the sections (all of them without --sections) and stop")
    a = ap.parse_args()
    if a.list:
        for r in units(read_part()):
            if not a.sections or r.section in a.sections:
                print(f"{r.cite:26} {r.text[:110]}")
        raise SystemExit(0)
    vec = LOCAL if a.local else API
    judge = a.judge or ("rules" if a.local else "model")
    if a.library is not None:
        run_library(a.sop, a.library, a.sections, vec, judge, a.model, a.threshold or vec.library_line, a.batch, a.no_cache,
                    a.scope_only, a.cache, a.out or (LIBRARY_LOCAL_OUT if a.local else LIBRARY_OUT))
    else:
        asyncio.run(run(a.sop or [SAMPLE], a.sections, vec, judge, a.model, a.threshold or vec.scope_line, a.batch, a.no_cache,
                        a.publish, a.scope_only, a.cache))
