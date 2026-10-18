"""Document -> PageLayout list.

Pass 1 reads every page's text lines to learn document-wide facts: the body
font size, where the body column sits, and which lines repeat on most pages
(running headers, footers, page numbers).
Pass 2 builds typed blocks per page: text, headings, tables, figures; OCRs
scanned pages; attaches margin notes to the sections they title.
Pass 3 merges tables that continue across pages.
"""
from __future__ import annotations

import re
import statistics
from collections import Counter
from typing import Callable

import pymupdf

from ..config import settings
from .figures import detect_figures
from .model import BBox, Line, PageLayout, TableBlock, TextBlock
from .ocr import looks_garbled, looks_scanned, ocr_page
from .tables import find_aligned_tables, find_ruled_tables, merge_continuations, numbered_header_ids

SECTION_START = re.compile(r"^\s*(?:(?P<pre>[A-Z][A-Za-z ,\-]{2,60}?)\s+)?(?P<num>\d{1,3}[A-Z]{0,2})\.\s*(?=[A-Z(“\"])")
CHAPTER = re.compile(r"^\s*(CHAPTER|PART|BOOK|TITLE|ARTICLE)\s+[IVXLC\d]+\b|^\s*THE\s+\w+\s+SCHEDULE\b|^\s*SCHEDULE\s+[IVXLC\d]+\b", re.I)
TOC_MARK = re.compile(r"ARRANGEMENT\s+OF\s+(CLAUSES|SECTIONS)|TABLE\s+OF\s+CONTENTS|^CONTENTS$", re.I)
PAGE_NO = re.compile(r"^\(?[ivxlcIVXLC]{1,6}\)?$|^\d{1,4}$|^(page\s*)?\d{1,4}(\s*(of|/)\s*\d{1,4})?$", re.I)


def extract_lines(page: pymupdf.Page) -> tuple[list[Line], list[tuple[BBox, list[Line]]]]:
    """All text lines and the raw blocks (paragraph groups) PyMuPDF gives us."""
    lines: list[Line] = []
    blocks: list[tuple[BBox, list[Line]]] = []
    d = page.get_text("dict")
    for b in d["blocks"]:
        if b["type"] != 0:
            continue
        bl: list[Line] = []
        for l in b["lines"]:
            spans = [s for s in l["spans"] if s["text"].strip()]
            if not spans:
                continue
            text = "".join(s["text"] for s in spans).strip()
            size = max(s["size"] for s in spans)
            bold = any((s["flags"] & 16) or "bold" in s["font"].lower() for s in spans)
            ln = Line(text, tuple(l["bbox"]), round(size, 1), bold)
            bl.append(ln)
            lines.append(ln)
        if bl:
            blocks.append((tuple(b["bbox"]), bl))
    return lines, blocks


def _norm(t: str) -> str:
    return re.sub(r"\d+", "#", re.sub(r"\s+", " ", t.lower())).strip()


class DocStats:
    def __init__(self, pages: list[tuple[list[Line], float, float]]):
        sizes: Counter = Counter()
        for lines, _, _ in pages:
            for l in lines:
                sizes[l.size] += len(l.text)
        self.body_size = sizes.most_common(1)[0][0] if sizes else 10.0
        body_lines = [l for lines, _, _ in pages for l in lines if abs(l.size - self.body_size) < 0.6 and len(l.text) > 40]
        x0s = sorted(l.bbox[0] for l in body_lines) or [0.0]
        x1s = sorted(l.bbox[2] for l in body_lines) or [1e9]
        self.body_left = x0s[len(x0s) // 10]
        self.body_right = x1s[-1 - len(x1s) // 10]
        # repeated lines in header/footer zones (running headers and footers).
        # Bare numbers and "(1) (2) (3)" rows are left out: folios have their
        # own rule and column numbers are table content.
        n = len(pages)
        zone: Counter = Counter()
        for lines, w, h in pages:
            seen = set()
            nh = numbered_header_ids(lines)
            for l in lines:
                if id(l) in nh or PAGE_NO.match(l.text):
                    continue
                if l.bbox[1] < 0.09 * h or l.bbox[3] > 0.92 * h:
                    seen.add(_norm(l.text))
            zone.update(seen)
        self.repeated = {t for t, c in zone.items() if c >= max(3, 0.3 * n)}
        self.page_count = n
        # the same over a wider band, for the boxed headers SOPs print on every page (document number, revision,
        # title, "Page 3 of 15"), which can reach a quarter of the way down
        wide: Counter = Counter()
        for lines, w, h in pages:
            wide.update({_norm(l.text) for l in lines if l.bbox[1] < 0.25 * h or l.bbox[3] > 0.85 * h})
        self.repeated_wide = {t for t, c in wide.items() if c >= max(3, 0.3 * n)}

    def is_running_box(self, bbox: BBox, lines: list[Line], h: float) -> bool:
        """A ruled box repeated at the top or bottom of most pages: a document-control header, not a table.
        At least 60% of the lines inside it recur on 30% of the pages or more."""
        if self.page_count < 3 or not (bbox[3] < 0.30 * h or bbox[1] > 0.80 * h):
            return False
        inside = [l for l in lines if l.bbox[0] >= bbox[0] - 2 and l.bbox[2] <= bbox[2] + 2
                  and l.bbox[1] >= bbox[1] - 2 and l.bbox[3] <= bbox[3] + 2]
        return bool(inside) and sum(_norm(l.text) in self.repeated_wide for l in inside) >= 0.6 * len(inside)

    def is_boilerplate(self, l: Line, h: float, edge: bool = False, mates: list[Line] = ()) -> bool:
        """Running headers, footers and page numbers. `edge` marks the top-most
        or bottom-most baseline of the page; `mates` are the other lines on the
        line's baseline.

        A bare number is a folio when it sits on the page's outermost baseline
        (wherever that is: gazettes print it at 86% of the height), or in the
        header/footer zone with nothing but running-header text beside it. A
        number beside table text ("57" under the column numbers) is a key.
        A repeated text is a running header only on a short baseline: a table
        row that happens to start in the zone has many cells beside it."""
        in_zone = l.bbox[1] < 0.09 * h or l.bbox[3] > 0.92 * h
        if PAGE_NO.match(l.text) is not None:
            return edge or (in_zone and all(_norm(m.text) in self.repeated for m in mates))
        return in_zone and len(mates) <= 2 and _norm(l.text) in self.repeated

    def is_margin_note(self, l: Line) -> bool:
        return l.size < self.body_size * 0.92 and (l.bbox[0] < self.body_left - 15 or l.bbox[0] > self.body_right + 4)


def parse_document(doc: pymupdf.Document, progress: Callable[[int, int], None] | None = None) -> list[PageLayout]:
    # ---- pass 1
    raw: list[tuple[list[Line], list[tuple[BBox, list[Line]]]]] = []
    for page in doc:
        raw.append(extract_lines(page))
    stats = DocStats([(lines, p.rect.width, p.rect.height) for (lines, _), p in zip(raw, doc)])

    # ---- pass 2
    layouts: list[PageLayout] = []
    tables_by_page: dict[int, list[TableBlock]] = {}
    per_page_blocks: dict[int, list] = {}
    heights: dict[int, float] = {}
    prior_model = None   # column model of an aligned table that reached the previous page's bottom
    for idx, page in enumerate(doc):
        pno = idx + 1
        W, H = page.rect.width, page.rect.height
        heights[pno] = H
        lines, blocks = raw[idx]
        scanned = ocr_applied = False
        if looks_scanned(page, lines):
            scanned = ocr_applied = True
            lines, blocks = ocr_page(page)
            blocks = [((b.bbox), b.lines) for b in blocks]
        elif looks_garbled(lines):
            # a text layer exists but is a legacy font's glyph codes; read the page as an image instead
            ocr_applied = True
            lines, blocks = ocr_page(page, lang=settings.ocr_lang_garbled)
            blocks = [((b.bbox), b.lines) for b in blocks]

        is_toc = any(TOC_MARK.search(l.text) for l in lines[:12]) or _looks_like_toc(lines)
        keep = numbered_header_ids(lines)          # "(1) (2) (3)" column rows are not page numbers
        edge = _edge_line_ids(lines)
        drop = _line_number_ids(lines, stats)      # gazette line numbering in the margin
        mates = _baseline_mates(lines)
        body_lines = [l for l in lines if id(l) not in drop
                      and (id(l) in keep or not stats.is_boilerplate(l, H, edge=id(l) in edge, mates=mates[id(l)]))]
        # Margin notes only exist on pages set in the body font. A page that is
        # mostly smaller text (a schedule, an appendix table) has no margin column.
        small = sum(1 for l in body_lines if l.size < stats.body_size * 0.92)
        if body_lines and small / len(body_lines) > 0.5:
            margin = []
        else:
            normal = [l for l in body_lines if l.size >= stats.body_size * 0.92]
            margin = [l for l in body_lines if stats.is_margin_note(l)
                      and any(n.bbox[1] - 6 <= l.bbox[1] <= n.bbox[3] + 6 for n in normal)]
        content = [l for l in body_lines if l not in margin]

        # ruled-table and figure detection read the PDF's own text and drawings, which
        # an OCR'd page does not trust; the whitespace table detector runs on the OCR lines
        tables = find_ruled_tables(page) if not ocr_applied else []
        running = [t for t in tables if stats.is_running_box(t.bbox, lines, H)]
        tables = [t for t in tables if t not in running]
        excl = [t.bbox for t in tables] + [t.bbox for t in running]      # a running header box is left out, text and all
        figures = detect_figures(page, content, excl) if not ocr_applied else []
        excl += [f.bbox for f in figures]
        if not tables and not is_toc:
            tables = find_aligned_tables(page, content, excl, prior=prior_model)
            excl += [t.bbox for t in tables]
        for tb in tables:
            _attach_table_caption(tb, content)
        tables_by_page[pno] = tables
        prior_model = None
        if tables and getattr(tables[-1], "column_model", None) is not None and tables[-1].bbox[3] > 0.60 * H:
            prior_model = tables[-1].column_model  # type: ignore[attr-defined]

        consumed: set[int] = set()
        for f in figures:
            consumed |= getattr(f, "consumed_lines", set())
        for tb in tables:
            consumed |= getattr(tb, "consumed_lines", set())
        text_blocks: list[TextBlock] = []
        for bbox, bl in blocks:
            bl = [l for l in bl if l in content and id(l) not in consumed]
            if not bl:
                continue
            if _in_any(bbox, excl):
                continue
            tb = TextBlock(page=pno, bbox=_union([l.bbox for l in bl]), lines=bl)
            _classify_heading(tb, stats, W, is_toc)
            text_blocks.append(tb)
        _attach_margin_notes(text_blocks, margin)

        per_page_blocks[pno] = text_blocks + figures
        layouts.append(PageLayout(number=pno, width=W, height=H, blocks=[], lines=lines, is_scanned=scanned, ocr_applied=ocr_applied))
        if progress and (pno % 10 == 0 or pno == len(doc)):
            progress(pno, len(doc))

    # ---- pass 3
    merge_continuations(tables_by_page, heights, doc[0].rect.width)
    for lay in layouts:
        blocks = per_page_blocks[lay.number] + tables_by_page.get(lay.number, [])
        blocks.sort(key=lambda b: (round(b.bbox[1] / 4), b.bbox[0]))
        lay.blocks = blocks
    return layouts


def _edge_line_ids(lines: list[Line]) -> set[int]:
    """The top-most and bottom-most lines of a page (within a couple of points)."""
    if not lines:
        return set()
    top = min(l.bbox[1] for l in lines)
    bottom = max(l.bbox[3] for l in lines)
    return {id(l) for l in lines if l.bbox[1] <= top + 2 or l.bbox[3] >= bottom - 2}


_INT = re.compile(r"^\d{1,4}$")


def _line_number_ids(lines: list[Line], stats: "DocStats") -> set[int]:
    """Gazettes print 5, 10, 15... in the margin every five lines. Those numbers
    are not content and, left in, read as the key column of a three-column
    table made of prose."""
    cands = [l for l in lines if _INT.match(l.text.strip()) and l.size < stats.body_size * 0.92
             and (l.bbox[2] <= stats.body_left - 3 or l.bbox[0] >= stats.body_right + 3)]
    if len(cands) < 3:
        return set()
    cands.sort(key=lambda l: l.bbox[1])
    vals = [int(l.text.strip()) for l in cands]
    steps = {b - a for a, b in zip(vals, vals[1:])}
    if len(steps) == 1 and steps.pop() in (1, 5, 10) and vals[0] <= 10:
        return {id(l) for l in cands}
    return set()


def _baseline_mates(lines: list[Line]) -> dict[int, list[Line]]:
    """For each line, the other lines that share its baseline."""
    by_y = sorted(lines, key=lambda l: l.bbox[1])
    out: dict[int, list[Line]] = {}
    for i, l in enumerate(by_y):
        m: list[Line] = []
        j = i - 1
        while j >= 0 and l.bbox[1] - by_y[j].bbox[1] <= 3:
            m.append(by_y[j]); j -= 1
        j = i + 1
        while j < len(by_y) and by_y[j].bbox[1] - l.bbox[1] <= 3:
            m.append(by_y[j]); j += 1
        out[id(l)] = m
    return out


def _looks_like_toc(lines: list[Line]) -> bool:
    if len(lines) < 12:
        return False
    nums = sum(1 for l in lines if re.fullmatch(r"\d{1,3}[A-Z]?\.", l.text.strip()))
    return nums >= 0.3 * len(lines)


def _in_any(bbox: BBox, rects: list[BBox]) -> bool:
    cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    for r in rects:
        if r[0] - 2 <= cx <= r[2] + 2 and r[1] - 2 <= cy <= r[3] + 2:
            return True
    return False


def _union(boxes: list[BBox]) -> BBox:
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


_WORDISH = re.compile(r"^[A-Za-z][A-Za-z'’\-]*[.,;:]?$")


_AMOUNT = re.compile(r"(?:rs\.?|inr|₹|\$|€|£|usd|eur|gbp)\s*[\d,]+(?:\.\d+)?\s*$|\d[\d,]*\.\d{2}\s*$", re.I)


def _labelled_value(text: str) -> bool:
    """A line that carries a value is data, not a title, however bold or large it is set:
    "Grand Total: Rs. 500.64", "Invoice No: SP/2026/04452", "Total 1,234.00"."""
    head, sep, tail = text.partition(":")
    if sep and len(head.strip()) <= 40 and re.search(r"\d", tail):
        return True
    return bool(_AMOUNT.search(text))


def _wordish_ratio(text: str) -> float:
    toks = [t for t in re.split(r"\s+", text) if t]
    if not toks:
        return 0.0
    good = 0
    for t in toks:
        if _WORDISH.match(t) and (len(t) <= 3 or re.search(r"[aeiouyAEIOUY]", t)):
            good += 1
        elif re.fullmatch(r"[IVXLC]+\.?|\d+(\.\d+)*\.?|[—–-]|\(?[A-Za-z0-9]{1,3}\)|[A-Z]\.|[&/]", t):
            good += 1
    return good / len(toks)


def _classify_heading(tb: TextBlock, stats: DocStats, W: float, is_toc: bool) -> None:
    first = tb.lines[0]
    text = tb.text
    short = len(text) <= 110 and len(tb.lines) <= 2
    if is_toc:
        return
    if short and (_wordish_ratio(text) < 0.8 or re.search(r"[\[\]/;@~^`|\\]", text)):
        return   # mis-decoded fonts, dingbats, transliterated scripts
    if short and _labelled_value(text):
        return   # a bold total or a key: value line is a fact to keep in the text, not a section title
    if CHAPTER.match(first.text) and short:
        tb.heading_level, tb.heading_only, tb.heading_title = 1, True, text
        return
    if short and text.isupper() and len(text) >= 4 and first.size >= stats.body_size * 0.95 and first.bbox[0] > 0.25 * W:
        # centred all-caps line: chapter/schedule title
        tb.heading_level, tb.heading_only, tb.heading_title = 1, True, text
        return
    if short and first.size >= stats.body_size * 1.15:
        tb.heading_level = 1 if first.size >= stats.body_size * 1.4 else 2
        tb.heading_only, tb.heading_title = True, text
        return
    m = SECTION_START.match(first.text)
    pre_line = None
    if not m and len(tb.lines) >= 2 and len(first.text) <= 60 and not first.text.endswith("."):
        m2 = SECTION_START.match(tb.lines[1].text)
        if m2 and not m2.group("pre"):
            m, pre_line = m2, first.text.strip()
    if m and m.group("pre") and re.match(r"^(fig(ure)?|table|image|photo(graph)?|plate|diagram|exhibit|chart|illustration|box|step|note)s?$", m.group("pre").strip(), re.I):
        m = None
    if m and (pre_line or len(first.text) > len(m.group(0)) + 2):
        src = tb.lines[1].text if pre_line else first.text
        tb.heading_level, tb.heading_only = 2, False
        tb.heading_title = f"{m.group('num')}. " + src[m.end():][:90].rstrip(" ,;:—–-")
        tb.section_number = m.group("num")  # type: ignore[attr-defined]
        pre = pre_line or (m.group("pre").strip() if m.group("pre") else None)
        if pre:
            tb.pre_heading = pre  # type: ignore[attr-defined]
        return
    if len(tb.lines) == 1 and first.bold and len(text) <= 90 and not text.endswith(".") and first.size >= stats.body_size * 0.98:
        tb.heading_level, tb.heading_only, tb.heading_title = 3, True, text
        return


def _attach_margin_notes(blocks: list[TextBlock], margin: list[Line]) -> None:
    """Gazette-style acts print the section title in the margin beside the
    section. Every margin line between one section start and the next belongs
    to that section, whatever the spacing."""
    sections = sorted((b for b in blocks if getattr(b, "section_number", None)), key=lambda b: b.bbox[1])
    if not sections or not margin:
        return
    margin = sorted(margin, key=lambda l: (l.bbox[1], l.bbox[0]))
    for i, sec in enumerate(sections):
        top = sec.bbox[1] - 14
        bottom = sections[i + 1].bbox[1] - 14 if i + 1 < len(sections) else float("inf")
        note = [l.text for l in margin if top <= l.bbox[1] < bottom and not re.fullmatch(r"[\d\s.]+", l.text)]
        if note:
            title = re.sub(r"\s+", " ", " ".join(note)).strip().rstrip(".")
            sec.heading_title = f"{sec.section_number}. {title}"  # type: ignore[attr-defined]


_TABLE_CAPTION = re.compile(r"^\s*(table|tbl\.?|schedule)\s*[A-Za-z]?\d+(\.\d+)?\b", re.I)


def _attach_table_caption(tb: TableBlock, lines: list[Line]) -> None:
    """A line starting with "Table N" within a few points above or below the
    table is its caption. Those lines are consumed so they do not also become a
    text chunk."""
    x0, y0, x1, y1 = tb.bbox
    cands = [l for l in lines if (y1 - 2 <= l.bbox[1] <= y1 + 40 or y0 - 40 <= l.bbox[3] <= y0 + 2)
             and min(l.bbox[2], x1) - max(l.bbox[0], x0) > 10 and _TABLE_CAPTION.match(l.text)]
    if not cands:
        return
    cap = min(cands, key=lambda l: min(abs(l.bbox[1] - y1), abs(l.bbox[3] - y0)))
    used = [cap]
    # continuation lines of the caption paragraph
    for l in sorted(lines, key=lambda l: l.bbox[1]):
        if l is cap:
            continue
        if 0 <= l.bbox[1] - used[-1].bbox[3] <= 6 and abs(l.bbox[0] - cap.bbox[0]) < 20 and not _TABLE_CAPTION.match(l.text):
            used.append(l)
    tb.caption = " ".join(l.text for l in used).strip()
    tb.consumed_lines = getattr(tb, "consumed_lines", set()) | set(id(l) for l in used)  # type: ignore[attr-defined]
