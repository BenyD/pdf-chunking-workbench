"""Table detection that does not depend on one document's quirks.

Two detectors, both deterministic:

1. Ruled tables  - PyMuPDF's line-based finder. Works whenever cell borders are
                   drawn (invoices, reports, lab sheets). Handles merged cells.
2. Aligned tables - For tables typeset without rules (statutes, schedules, many
                   government PDFs). Columns are inferred from where text lines
                   START: left edges cluster tightly inside a column and the
                   gaps between clusters are the column boundaries. A numbered
                   header row like "(1) (2) (3)" or "1 2 3" is used as an extra
                   cue when present, but is not required.

Rows: a new row begins when the KEY column (the leftmost column whose values
are mostly short tokens such as numbers or codes) gets a value, or when the
vertical gap to the previous line is clearly larger than a line height.
Wrapped cells are therefore kept together.

Continuation across pages: the next page is treated as the same table when its
inferred column boundaries match within tolerance and nothing but a running
header sits above it. Repeated header rows are dropped; the header is attached
to every emitted part so no row is ever separated from its column names.

Everything here works page by page and yields rows incrementally, so a table
spanning hundreds of pages never has to live in memory as a single string.
"""
from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field

import pymupdf

from .model import BBox, Line, TableBlock

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

_NUM_HEADER = re.compile(r"^\(?(\d{1,2}|[ivxIVX]{1,4})\)?\.?$")
_KEYISH = re.compile(r"^[\(\[]?[0-9]{1,4}[A-Za-z]?[\)\]\.]?$|^[A-Z]{1,4}-?\d{1,5}$|^\d+(\.\d+)+$")


def clean(cell: str | None) -> str:
    return re.sub(r"\s+", " ", (cell or "")).strip()


def to_markdown(header: list[str], rows: list[list[str]]) -> str:
    cols = len(header)
    out = ["| " + " | ".join(h or f"col{i+1}" for i, h in enumerate(header)) + " |",
           "|" + "---|" * cols]
    for r in rows:
        r = (r + [""] * cols)[:cols]
        out.append("| " + " | ".join(c.replace("|", "/") for c in r) + " |")
    return "\n".join(out)


def row_to_text(header: list[str], row: list[str]) -> str:
    """Flatten one row into "Header: value" pairs. This is what makes a row
    findable by a natural-language question."""
    parts = []
    for i, v in enumerate(row):
        v = clean(v)
        if not v:
            continue
        h = clean(header[i]) if i < len(header) and clean(header[i]) else f"col{i+1}"
        parts.append(f"{h}: {v}")
    return ". ".join(parts) + ("." if parts else "")


# ---------------------------------------------------------------------------
# 1. ruled tables
# ---------------------------------------------------------------------------

def find_ruled_tables(page: pymupdf.Page) -> list[TableBlock]:
    out: list[TableBlock] = []
    try:
        tabs = page.find_tables(strategy="lines")
    except Exception:
        return out
    page_area = page.rect.get_area()
    for t in tabs.tables:
        if t.row_count < 2 or t.col_count < 2:
            continue
        rect = pymupdf.Rect(t.bbox)
        if rect.get_area() < 0.01 * page_area:
            continue
        data = [[clean(c) for c in row] for row in t.extract()]
        if t.header is not None and t.header.names and any(clean(n) for n in t.header.names):
            header = [clean(n) for n in t.header.names]
            rows = data if t.header.external else data[1:]
        else:
            header = data[0]
            rows = data[1:]
        rows = [r for r in rows if any(r)]
        if not rows:
            continue
        # Reject "tables" that are really a boxed paragraph: 1 non-empty cell per row
        if statistics.mean(sum(1 for c in r if c) for r in rows) < 1.5:
            continue
        pno = page.number + 1
        bbox = (rect.x0, rect.y0, rect.x1, rect.y1)
        tb = TableBlock(page=pno, bbox=bbox, header=header, rows=rows, bboxes=[(pno, bbox)])
        row_objs = list(t.rows)
        if t.header is not None and not t.header.external and row_objs:
            row_objs = row_objs[1:]
        tb.row_bboxes = [tuple(r.bbox) for r in row_objs][: len(rows)]   # type: ignore[attr-defined]
        tb.has_header_text = any(header)                                  # type: ignore[attr-defined]
        out.append(tb)
    return out


# ---------------------------------------------------------------------------
# 2. aligned (ruling-free) tables
# ---------------------------------------------------------------------------

@dataclass
class ColumnModel:
    """Column boundaries in points: cut i separates column i from i+1."""
    cuts: list[float]
    left: float
    right: float

    @property
    def n(self) -> int:
        return len(self.cuts) + 1

    def col_of(self, x: float) -> int:
        for i, c in enumerate(self.cuts):
            if x < c:
                return i
        return len(self.cuts)

    def crosses(self, bbox: BBox) -> bool:
        return any(bbox[0] < c - 1.5 < bbox[2] for c in self.cuts)

    def similar(self, other: "ColumnModel", tol: float) -> bool:
        if self.n != other.n:
            return False
        return all(abs(a - b) <= tol for a, b in zip(self.cuts, other.cuts))


def _baseline_buckets(lines: list[Line]) -> list[list[Line]]:
    """Group lines that share a baseline (same visual row)."""
    if not lines:
        return []
    line_h = statistics.median(l.bbox[3] - l.bbox[1] for l in lines)
    buckets: list[list[Line]] = []
    for l in sorted(lines, key=lambda l: (l.bbox[1], l.bbox[0])):
        if buckets and abs(l.bbox[1] - buckets[-1][0].bbox[1]) <= line_h * 0.5:
            buckets[-1].append(l)
        else:
            buckets.append([l])
    return buckets


def _header_token_centers(lines: list[Line]) -> list[float] | None:
    """A row made only of (1) (2) (3)... or 1 2 3... gives column centres."""
    for b in _baseline_buckets(lines):
        toks = [l for l in b if l.text.strip()]
        hits = [t for t in toks if _NUM_HEADER.match(t.text.strip())]
        # allow one stray token (a page number printed on the same baseline)
        if len(hits) >= 3 and len(hits) >= len(toks) - 1:
            return sorted((t.bbox[0] + t.bbox[2]) / 2 for t in hits)
    return None


def infer_columns(lines: list[Line], page_width: float, min_gap: float = 5.0) -> ColumnModel | None:
    """Vertical whitespace gutters = column boundaries.

    Project every (narrow) line onto the x axis; x positions that almost no
    line covers are gutters. Lines wider than half the page are prose or
    titles and are ignored. Two passes: the second recomputes gutters from
    the lines that fit the first model, which removes prose paragraphs that
    happen to be narrower than half the page.
    """
    model = _infer_once(lines, page_width, min_gap)
    if model is None:
        return None
    fitting = [l for l in lines if not model.crosses(l.bbox)]
    refined = _infer_once(fitting, page_width, min_gap)
    return refined or model


def _infer_once(lines: list[Line], page_width: float, min_gap: float) -> ColumnModel | None:
    narrow = [l for l in lines if (l.bbox[2] - l.bbox[0]) < 0.5 * page_width]
    if len(narrow) < 8:
        return None
    x_min = int(min(l.bbox[0] for l in narrow))
    x_max = int(max(l.bbox[2] for l in narrow)) + 1
    cov = [0] * (x_max - x_min + 1)
    for l in narrow:
        a, b = int(l.bbox[0]) - x_min, int(l.bbox[2]) - x_min
        for i in range(max(0, a), min(len(cov) - 1, b) + 1):
            cov[i] += 1
    def _gutters(tol: int) -> list[tuple[float, float]]:
        out: list[tuple[float, float]] = []
        i = 0
        while i < len(cov):
            if cov[i] <= tol:
                j = i
                while j < len(cov) and cov[j] <= tol:
                    j += 1
                if 0 < i and j < len(cov) and (j - i) >= min_gap:
                    out.append((x_min + i, x_min + j))
                i = j
            else:
                i += 1
        return out

    # strict first (no line may cross a gutter); relax only if that finds too few
    gutters = _gutters(0)
    if len(gutters) < 2:
        gutters = _gutters(max(1, int(0.03 * len(narrow))))

    centers = _header_token_centers(lines)
    cuts: list[float] = []
    if centers and len(centers) >= 3:
        for a, b in zip(centers, centers[1:]):
            between = [g for g in gutters if a < (g[0] + g[1]) / 2 < b]
            if between:
                g = max(between, key=lambda g: g[1] - g[0])
                cuts.append((g[0] + g[1]) / 2)
            else:
                # no clean gutter: take the x with the least coverage between the two centres
                lo, hi = int(a) - x_min, int(b) - x_min
                lo, hi = max(0, lo), min(len(cov) - 1, hi)
                if hi - lo < 4:
                    cuts.append((a + b) / 2)
                else:
                    best = min(range(lo + 2, hi - 1), key=lambda i: (cov[i], -i))
                    cuts.append(float(x_min + best))
    else:
        cuts = [(g[0] + g[1]) / 2 for g in gutters]
    if len(cuts) < 2:
        return None
    # Snap each cut to just left of where the next column's text starts. Column
    # starts are stable (left aligned); column ends are not (wrapped text).
    model = ColumnModel(cuts=cuts, left=float(x_min), right=float(x_max))
    snapped: list[float] = []
    for i, c in enumerate(model.cuts):
        starts = [l.bbox[0] for l in narrow if model.col_of(l.bbox[0] + 1.0) == i + 1]
        new = min(starts) - 1.0 if starts else c
        if snapped and new <= snapped[-1] + 2:
            new = c
        snapped.append(new)
    return ColumnModel(cuts=snapped, left=float(x_min), right=float(x_max))


def _is_numbered_header(cells: list[str]) -> bool:
    filled = [c for c in cells if c]
    return len(filled) >= 3 and all(_NUM_HEADER.match(c) for c in filled)


def _group_rows(lines: list[Line], model: ColumnModel, key_col: int) -> list[tuple[list[str], BBox]]:
    """Baseline buckets -> rows of cells. A new row starts when the key column
    is filled or the vertical gap is clearly larger than a line height."""
    rows: list[tuple[list[str], BBox]] = []
    cur: list[list[str]] | None = None
    cur_box: list[float] = []
    last_y1 = None
    line_h = statistics.median(l.bbox[3] - l.bbox[1] for l in lines) if lines else 10
    for b in _baseline_buckets(lines):
        cells = [""] * model.n
        for l in sorted(b, key=lambda l: l.bbox[0]):
            ci = model.col_of(l.bbox[0] + 1.0)
            cells[ci] = (cells[ci] + " " + l.text).strip()
        y0 = min(l.bbox[1] for l in b)
        y1 = max(l.bbox[3] for l in b)
        big_gap = last_y1 is not None and (y0 - last_y1) > line_h * 1.4
        if bool(cells[key_col]) or cur is None or big_gap:
            if cur is not None:
                rows.append(([" ".join(c).strip() for c in cur], tuple(cur_box)))
            cur = [[c] if c else [] for c in cells]
            cur_box = [min(l.bbox[0] for l in b), y0, max(l.bbox[2] for l in b), y1]
        else:
            for i, c in enumerate(cells):
                if c:
                    cur[i].append(c)
            cur_box[0] = min(cur_box[0], min(l.bbox[0] for l in b))
            cur_box[2] = max(cur_box[2], max(l.bbox[2] for l in b))
            cur_box[3] = y1
        last_y1 = y1
    if cur is not None:
        rows.append(([" ".join(c).strip() for c in cur], tuple(cur_box)))
    return rows


def _pick_key_column(rows: list[list[str]], n: int) -> int:
    best, best_score = 0, -1.0
    for ci in range(n):
        vals = [r[ci] for r in rows if r[ci]]
        if len(vals) < max(3, 0.3 * len(rows)):
            continue
        score = sum(1 for v in vals if _KEYISH.match(v)) / len(vals) - ci * 0.05
        if score > best_score:
            best, best_score = ci, score
    return best


def _looks_like_header(cells: list[str]) -> bool:
    filled = [c for c in cells if c]
    if len(filled) < 2:
        return False
    return all(len(c) <= 60 and not re.search(r"\d{3,}", c) for c in filled)


def resolve_ditto(rows: list[list[str]]) -> list[list[str]]:
    """Legal and accounting tables write "Ditto"/"Do." for "same as above".
    Resolve it so a row stands on its own when flattened to text."""
    out: list[list[str]] = []
    for r in rows:
        nr = list(r)
        for i, c in enumerate(nr):
            if re.fullmatch(r"(ditto|do)\.?", c.strip().lower()) and out:
                for prev in reversed(out):
                    if i < len(prev) and prev[i] and not re.fullmatch(r"(ditto|do)\.?", prev[i].strip().lower()):
                        nr[i] = prev[i]
                        break
        out.append(nr)
    return out


def find_aligned_tables(page: pymupdf.Page, lines: list[Line], exclude: list[BBox],
                        prior: "ColumnModel | None" = None) -> list[TableBlock]:
    """At most one ruling-free table region per page: the lines that fit a
    >=3-column whitespace model without crossing a column boundary.

    `prior` is the column model of a table that ended at the bottom of the
    previous page. Columns persist across pages, so if this page's lines fit
    that model it is reused instead of being re-inferred; that is what keeps a
    300-page table in one piece."""
    W = page.rect.width
    body = [l for l in lines if not any(_inside(l.bbox, e) for e in exclude)]
    if len(body) < 8:
        return []
    own = infer_columns(body, W)
    model = own
    if prior is not None:
        narrow = [l for l in body if (l.bbox[2] - l.bbox[0]) < 0.5 * W]
        cross_prior = sum(1 for l in narrow if prior.crosses(l.bbox))
        cross_own = sum(1 for l in narrow if own.crosses(l.bbox)) if own else len(narrow)
        fits_prior = narrow and cross_prior <= 0.25 * len(narrow)
        if fits_prior and (own is None or cross_prior <= cross_own):
            model = prior
    if model is None:
        return []
    fitting = [l for l in body if not model.crosses(l.bbox) and l.bbox[0] >= model.left - 10]
    if len(fitting) < 8 or len(fitting) < 0.5 * len(body):
        return []

    prelim = _group_rows(fitting, model, key_col=0)
    key_col = _pick_key_column([r for r, _ in prelim], model.n)
    rows = _group_rows(fitting, model, key_col=key_col) if key_col != 0 else prelim

    header = [""] * model.n
    leading: list[tuple[list[str], BBox]] = []      # keyless rows before the first keyed row
    data: list[tuple[list[str], BBox]] = []
    for cells, box in rows:
        if not data and _is_numbered_header(cells):
            continue
        keyed = bool(cells[key_col]) and _KEYISH.match(cells[key_col]) is not None
        if not data and not keyed:
            leading.append((cells, box))
            continue
        data.append((cells, box))
    if len(data) < 2:
        return []
    if statistics.mean(sum(1 for c in r if c) for r, _ in data) < 2.0:
        return []

    has_header_text = False
    leading = [(c, b) for c, b in leading if sum(1 for x in c if x) >= 2]   # drop titles like "I." or "Part A"
    if leading and all(_looks_like_header(c) for c, _ in leading):
        for ci in range(model.n):
            header[ci] = clean(" ".join(c[ci] for c, _ in leading if c[ci]))
            header[ci] = re.sub(r"^[IVXLC]+\.\s*", "", header[ci])   # part numerals like "I." are not names
        has_header_text = any(header)
        leading = []

    pno = page.number + 1
    bbox = (min(b[0] for _, b in data), min(b[1] for _, b in data), max(b[2] for _, b in data), max(b[3] for _, b in data))
    tb = TableBlock(page=pno, bbox=bbox, header=header, rows=[r for r, _ in data], bboxes=[(pno, bbox)])
    tb.row_bboxes = [b for _, b in data]                    # type: ignore[attr-defined]
    tb.column_model = model                                  # type: ignore[attr-defined]
    tb.has_header_text = has_header_text                     # type: ignore[attr-defined]
    tb.leading_rows = [c for c, _ in leading]                # type: ignore[attr-defined]
    return [tb]


def _inside(b: BBox, e: BBox) -> bool:
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    return e[0] <= cx <= e[2] and e[1] <= cy <= e[3]


# ---------------------------------------------------------------------------
# 3. continuation across pages
# ---------------------------------------------------------------------------

def _norm_row(r: list[str]) -> str:
    return "|".join(re.sub(r"[^a-z0-9]", "", c.lower()) for c in r)


def merge_continuations(tables_by_page: dict[int, list[TableBlock]], page_heights: dict[int, float], page_width: float) -> None:
    """Mutates in place: a table at the top of page p+1 that matches the open
    table at the bottom of page p is appended to it and removed from p+1.
    Chains across any number of pages."""
    open_tbl: TableBlock | None = None
    for p in sorted(tables_by_page):
        tbls = tables_by_page[p]
        if open_tbl is not None and tbls:
            cand = tbls[0]
            if _continues(open_tbl, cand, page_heights, page_width):
                rows = cand.rows
                for lead in getattr(cand, "leading_rows", []):
                    last = open_tbl.rows[-1]
                    for i, c in enumerate(lead):
                        if c and i < len(last):
                            last[i] = (last[i] + " " + c).strip()
                if rows and _norm_row(rows[0]) == _norm_row(open_tbl.header):
                    rows = rows[1:]
                # A continuation page usually has no header text; if the detector
                # mistook the first data row for a header, put it back.
                if any(cand.header) and _norm_row(cand.header) != _norm_row(open_tbl.header) and not getattr(cand, "has_header_text", False):
                    rows = [cand.header] + rows
                open_tbl.rows.extend(rows)
                open_tbl.bboxes.append((p, cand.bbox))
                rb_prev = getattr(open_tbl, "row_bboxes", None)
                rb_next = getattr(cand, "row_bboxes", None)
                if rb_prev is not None and rb_next is not None:
                    rb_prev.extend(rb_next[-len(rows):] if rows else [])
                tbls = tbls[1:]
                tables_by_page[p] = tbls
                if not tbls:
                    continue           # open_tbl stays open for p+1
        # the last table on this page is the one that may continue onto p+1
        open_tbl = tbls[-1] if tbls else None


def _continues(prev: TableBlock, nxt: TableBlock, page_heights: dict[int, float], page_width: float) -> bool:
    p_prev = prev.bboxes[-1][0]
    p_next = nxt.page
    if p_next != p_prev + 1:
        return False
    if len(prev.header) != len(nxt.header):
        return False
    cm_prev = getattr(prev, "column_model", None)
    cm_next = getattr(nxt, "column_model", None)
    if cm_prev and cm_next and not cm_prev.similar(cm_next, tol=page_width * 0.03):
        return False
    prev_bottom = prev.bboxes[-1][1][3]
    if prev_bottom < 0.70 * page_heights[p_prev]:
        return False
    if nxt.bbox[1] > 0.30 * page_heights[p_next]:
        return False
    return True
