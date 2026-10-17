"""The document's own references, turned into links between passages: where an answer is somewhere else.

A passage often says where the rest of the story is: "see Table 2", "shown in Figure 1", "[see Warnings and
Precautions (5.1)]", "See section 163", "See Step 9", or it names a unit, batch or invoice that another passage,
pages away, records the result for. Search finds the passage whose words match the question; the answer can
sit in the one it points at. These links are built by rules, no model, and followed at search time
(RegulaRAG resolves cross-references the same way; heavy LLM-built knowledge graphs cost far more and are not
reliably better for lookups like these).

Three kinds of link, each stored on both ends in metadata["links"]:
  ref     an explicit reference in the passage's own text to a figure, table, section, step, note or annex,
          resolved to the first passage of that target in the same document
  key     a figure's labels and the key rows that explain them (made in legend.py)
  shared  a rare identifier (a unit, batch, lot, sample, station or invoice number, or a code mixing letters
          and digits such as B-220 or CAPA-0091) that appears in at most four passages
"""
from __future__ import annotations

import re
from collections import defaultdict

from .model import ChunkDraft

MAX_LINKS = 8

# where a target is anchored: in a passage's path (breadcrumb), its caption, its figure number, or its first line
_SEC_HEAD = re.compile(r"^(?:section\s+|§\s*)?(\d{1,3}(?:\.\d{1,3}){0,3})\.?\s+\S")
_ANNEX_HEAD = re.compile(r"^(?:annex|appendix)\s+([A-Z0-9]{1,3})\b", re.I)
_SCHED_HEAD = re.compile(r"^(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+schedule\b", re.I)
_TABLE_CAP = re.compile(r"^\s*table\s+([A-Z]?\d+(?:\.\d+)?[A-Za-z]?)\b", re.I)
_STEP_HEAD = re.compile(r"^\s*step\s+(\d{1,2})\b", re.I)
_NOTE_HEAD = re.compile(r"^\s*note\s+(\d{1,2})\b", re.I)

# how a passage refers to a target
_REFS = [
    ("figure", re.compile(r"\b(?:fig(?:ure)?s?\.?|photo|plate|diagram)\s+\(?([A-Z]?\d{1,3}[A-Za-z]?|[A-Z])\)?(?![\w.])", re.I)),
    ("table", re.compile(r"\btables?\s+([A-Z]?\d{1,3}(?:\.\d+)?[A-Za-z]?)\b", re.I)),
    ("section", re.compile(r"\b(?:sections?|sec\.|§)\s*(\d{1,3}(?:\.\d{1,3}){0,3})(?:\(\w{1,4}\))*", re.I)),
    ("section", re.compile(r"\[see [^\]]{2,80}?\((\d{1,2}(?:\.\d{1,2}){0,2})\)")),        # FDA labels: [see Warnings and Precautions (5.1)]
    ("annex", re.compile(r"\b(?:annex|appendix)\s+([A-Z0-9]{1,3})\b", re.I)),
    ("schedule", re.compile(r"\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+schedule\b", re.I)),
    ("step", re.compile(r"\bsteps?\s+(\d{1,2})\b", re.I)),
    ("note", re.compile(r"\bnotes?\s+(\d{1,2})\b", re.I)),
]
_LABEL = {"figure": "Figure", "table": "Table", "section": "Section", "annex": "Annex", "schedule": "Schedule", "step": "Step", "note": "Note"}

# rare identifiers: a code mixing letters and digits, or a number named as a unit, batch, lot ...
_CODE = re.compile(r"\b(?=[A-Z0-9/.\-]*[A-Z])(?=[A-Z0-9/.\-]*\d{2})[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)+\b")
_NAMED_NO = re.compile(r"\b(unit|batch|lot|sample|station|serial|invoice|item|capa|deviation)\s*(?:no\.?|number|#)?\s*[:.]?\s*([A-Z]{0,4}[-/]?\d{2,}[A-Z0-9/\-]*)\b", re.I)


def _anchors(c: ChunkDraft) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for seg in (c.context or "").split(" > ")[1:]:
        seg = seg.strip()
        if m := _SEC_HEAD.match(seg):
            out.append(("section", m.group(1)))
        if m := _ANNEX_HEAD.match(seg):
            out.append(("annex", m.group(1).upper()))
        if m := _SCHED_HEAD.match(seg):
            out.append(("schedule", m.group(1).lower()))
    cap = c.metadata.get("caption") or ""
    if c.chunk_type in ("table", "table_row") and (m := _TABLE_CAP.match(cap)):
        out.append(("table", m.group(1).upper()))
    if c.chunk_type == "figure" and c.metadata.get("figure_number"):
        out.append(("figure", str(c.metadata["figure_number"]).upper()))
    first = c.raw_text.lstrip()[:40]
    if m := _STEP_HEAD.match(first):
        out.append(("step", m.group(1)))
    if m := _NOTE_HEAD.match(first):
        out.append(("note", m.group(1)))
    return out


# a table of contents: several "4. Title ... 12" entries in one passage. It names sections but is not them.
_TOC_ENTRY = re.compile(r"(?:^|\s)\d{1,3}(?:\.\d{1,3})*\.?\s+[A-Z][^.\n]{2,70}?\s\.{0,40}\s?\d{1,3}(?=\s|$)")


def _is_toc(c: ChunkDraft) -> bool:
    return len(_TOC_ENTRY.findall(c.raw_text)) >= 3 or c.raw_text.lower().lstrip().startswith(("contents", "table of contents"))


def _identifiers(text: str) -> set[str]:
    ids = {m.group(0).upper() for m in _CODE.finditer(text)}
    ids |= {f"{m.group(1).lower()} {m.group(2).upper()}" for m in _NAMED_NO.finditer(text)}
    return ids


def _add(c: ChunkDraft, target: ChunkDraft, kind: str, label: str, direction: str) -> None:
    links = c.metadata.setdefault("links", [])
    if target.id == c.id or any(l["id"] == target.id for l in links) or len(links) >= MAX_LINKS:
        return
    links.append({"id": target.id, "kind": kind, "label": label, "dir": direction,
                  "page": target.page_start, "type": target.chunk_type})


def link_all(chunks: list[ChunkDraft]) -> int:
    """Rebuild the reference and identifier links among one document's passages. Returns how many were made.
    Key links made by legend.py are kept."""
    for c in chunks:
        c.metadata["links"] = [l for l in c.metadata.get("links", []) if l.get("kind") == "key"]
    # targets: the first passage carrying each anchor (a section's head, a table's first part)
    targets: dict[tuple[str, str], ChunkDraft] = {}
    for c in chunks:
        if c.chunk_type == "table_row" or _is_toc(c):
            continue
        for a in _anchors(c):
            targets.setdefault(a, c)
    made = 0
    for c in chunks:
        if c.chunk_type == "table_row" or _is_toc(c):
            continue                                    # a row's text repeats its table's; a contents page only lists
        own = set(_anchors(c))
        seen: set[tuple[str, str]] = set()
        for kind, pat in _REFS:
            for m in pat.finditer(c.raw_text):
                val = m.group(1)
                key = (kind, val.lower() if kind == "schedule" else val.upper())
                if key in seen or key in own:
                    continue
                seen.add(key)
                t = targets.get(key)
                if not t or t.id == c.id:
                    continue
                label = f"{_LABEL[kind]} {val}" if kind != "schedule" else f"{val.title()} Schedule"
                _add(c, t, "ref", label, "out")
                _add(t, c, "ref", label, "in")
                made += 1
    # shared identifiers: rare ones only, so a code on every page links nothing
    where: dict[str, list[ChunkDraft]] = defaultdict(list)
    for c in chunks:
        for ident in _identifiers(c.raw_text):
            where[ident].append(c)
    for ident, cs in where.items():
        # a table part and its own rows count once
        groups = {c.parent_id or c.id for c in cs}
        if not (2 <= len(groups) <= 4):
            continue
        label = ident if " " not in ident else ident.split(" ", 1)[0].title() + " " + ident.split(" ", 1)[1]
        for a in cs:
            for b in cs:
                if a is not b and (a.parent_id or a.id) != (b.parent_id or b.id):
                    _add(a, b, "shared", label, "shared")
                    made += 1
    return made
