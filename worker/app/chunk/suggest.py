"""Question suggestions for the search page, made from the document's own structure, with no model.

The chunker has already found each document's headings, the captions of its tables and figures and its tables'
first codes. A suggestion is a plain question built from one of them, so it can never claim what the document
does not say, and an uploaded document gets suggestions the moment it is read:

  heading   "What does the section on reserve samples say?"
  figure    "What does Figure 4 (Turret assembly, front view) show?"
  table     "What does Table 1 (Defect register for batch QC-2026-114) list?"
  lookup    "What is the entry for F-14321?"   (a big table: its first code)

Eight at most, no repeats, the three kinds mixed and spread across the document's pages.
"""
from __future__ import annotations

import re

from .model import ChunkDraft

MAX = 8
GENERIC = {"purpose", "scope", "introduction", "contents", "table of contents", "references", "definitions", "note",
           "notes", "background", "summary", "overview", "annexure", "appendix", "thank you", "questions", "review",
           "responsibilities", "records", "general", "abstract", "preface", "foreword", "index", "glossary",
           "attachments", "sections in this document", "document history", "conclusion", "technical information"}
# a heading's own numbering: "6.", "2.3.1", "IV.", "CHAPTER I —": only a number or a numeral followed by its
# delimiter, never a letter of the word itself ("Conclusion" must keep its C)
_NUM = re.compile(r"^\s*(?:(?:chapter|part|section|annex|appendix)\s+(?:[0-9IVXLC]+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:[—–:.-]\s*)?"
                  r"|\d+(?:\.\d+)*(?:[.)]\s*|\s+)|[IVXLC]+[.)]\s+)", re.I)
_STOP_END = {"with", "of", "and", "the", "for", "in", "to", "a", "an", "or", "on", "by", "as", "at", "from",
             "is", "are", "was", "be", "been", "must", "may", "shall", "will", "can", "there", "that", "which"}
_SENTENCE_START = ("the following", "additionally", "a ", "an ", "this ", "these ", "it ", "if ", "when ", "where ")
_TRAIL = re.compile(r"\s+\d{1,3}$")                     # a contents page's page number: "Introduction 1"
_CODE = re.compile(r"^[A-Z]{1,5}[-/]?\d{3,}[A-Z0-9/-]*$")
_CAPTION = re.compile(r"^(figure|fig\.?|table)\s+([A-Z]?\d+(?:\.\d+)*[A-Za-z]?)\s*(.*)$", re.I)


def _clean_heading(seg: str) -> str | None:
    s = seg.strip()
    if not s or s[0] in "•–-·*(" or s.startswith(("Table", "Figure", "Fig.", "Published on")) or "row " in s[:5]:
        return None
    s = _NUM.sub("", s)
    s = _TRAIL.sub("", s).strip(" .:;—–-*")
    letters = sum(ch.isalpha() for ch in s)
    if letters < 6 or len(s) > 70 or s.lower() in GENERIC or not (s[0].isupper() or s[0].isdigit()):
        return None                                       # too short, generic, or starts mid-sentence
    if s.split()[-1].lower() in _STOP_END or len(s.split()) > 10 or s.lower().startswith(_SENTENCE_START):
        return None                                       # a title that wrapped, or the start of a paragraph
    if s.isupper():
        if len(s.split()) > 3:
            return None                                   # a banner ("MINISTRY OF LAW AND JUSTICE"), not a section
        if len(s) > 4:
            s = s.capitalize()
    if re.search(r"\b(page|sheet)\b", s, re.I) and re.search(r"\d", s):
        return None
    return s


def _short(t: str, n: int = 60) -> str:
    t = re.sub(r"\s+", " ", t).strip(" .:;")
    return t if len(t) <= n else t[:n].rsplit(" ", 1)[0].rstrip(",;:") + "…"


def from_structure(chunks: list[ChunkDraft], title: str = "") -> list[str]:
    """Up to MAX questions from the document's headings, captions and first codes, spread over its pages."""
    heads: list[tuple[int, str]] = []
    seen_h: set[str] = set()
    figs: list[tuple[int, str]] = []
    tabs: list[tuple[int, str]] = []
    looks: list[tuple[int, str]] = []
    doc_title = re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()
    for c in chunks:
        if c.chunk_type in ("table_row",):
            continue
        segs = (c.context or "").split(" > ")[1:]
        if c.chunk_type in ("text", "table", "figure"):
            for seg in segs[-2:]:
                h = _clean_heading(seg)
                if h and h.lower() not in seen_h and re.sub(r"[^a-z0-9]+", " ", h.lower()).strip() != doc_title:
                    seen_h.add(h.lower())
                    heads.append((c.page_start, h))
        cap = (c.metadata or {}).get("caption") or ""
        m = _CAPTION.match(cap.strip())
        if m and c.chunk_type in ("figure", "table"):
            kind, num = m.group(1).lower(), m.group(2)
            rest = re.sub(r"^[\s.\-–—:)]+(?:\d+[.\-–—:)]+\s*)?", "", m.group(3))   # "-5.– Apparatus 4" -> "Apparatus 4"
            rest = _short(rest) if rest[:1].isupper() else ""        # a caption that is a sentence ("shows ...") adds nothing
            label = ("Figure " if kind.startswith("fig") else "Table ") + num
            (figs if kind.startswith("fig") else tabs).append(
                (c.page_start, f"What does {label}" + (f" ({rest})" if len(rest) > 3 else "") + (" show?" if kind.startswith("fig") else " list?")))
        if c.chunk_type == "table" and (c.metadata or {}).get("row_count", 0) >= 20:
            cells = [x for x in (c.raw_text.split("\n")[2].split("|") if c.raw_text.count("\n") >= 2 else []) if x.strip()]
            if cells and _CODE.match(cells[0].strip()):
                looks.append((c.page_start, f"What is the entry for {cells[0].strip()}?"))

    def spread(items: list[tuple[int, str]], n: int) -> list[tuple[int, str]]:
        if len(items) <= n:
            return items
        step = len(items) / n
        return [items[int(i * step)] for i in range(n)]

    if len(heads) >= 4 and heads[0][0] <= 1:
        heads = heads[1:]                                  # the first heading of a document is its title
    picked: list[tuple[int, str]] = []
    picked += spread(figs, 2)
    picked += spread(tabs, 2)
    picked += looks[:1]
    picked += [(p, f"What does the section on {h} say?") for p, h in spread(heads, MAX - len(picked))]
    out, seen = [], set()
    for _, q in sorted(picked, key=lambda x: x[0]):
        k = re.sub(r"[^a-z0-9]+", " ", q.lower()).strip()
        if k not in seen:
            seen.add(k)
            out.append(q)
    return out[:MAX]
