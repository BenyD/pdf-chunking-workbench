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
_KEYISH = re.compile(r"^[\(\[]?[0-9]{1,4}[A-Za-z]{0,2}(\s?\(\d{1,2}\))?[\)\]\.,]?$|^[A-Z]{1,4}-?\d{1,5}$|^\d+(\.\d+)+$")
# "109(2)For commission of..." : a key glued to its cell text in one extracted line
_GLUED_KEY = re.compile(r"^(\d{1,4}[A-Z]{0,2}(?:\s?\(\d{1,2}\))?\.?)\s*(?=[A-Za-z(])(.*\S.*)$")


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
        tb.row_pages = [pno] * len(rows)                                  # type: ignore[attr-defined]
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

    def crossed(self, bbox: BBox) -> int:
        return sum(1 for c in self.cuts if bbox[0] < c - 1.5 < bbox[2])

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


def numbered_header_ids(lines: list[Line]) -> set[int]:
    """ids of the lines that form a "(1) (2) (3)" or "1 2 3" column-number row.
    The layout pass keeps these even where a lone digit would be a page number."""
    out: set[int] = set()
    for b in _baseline_buckets(lines):
        toks = [l for l in b if l.text.strip()]
        hits = [t for t in toks if _NUM_HEADER.match(t.text.strip())]
        if len(hits) >= 3 and len(hits) >= len(toks) - 1:
            out |= {id(t) for t in hits}
    return out


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
    # Lines crossing several cuts are prose; a line crossing exactly one is a
    # cell the first pass mis-cut and must stay in so the cut can move.
    fitting = [l for l in lines if model.crossed(l.bbox) <= 1]
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
        # anchor on clean cells only: a centred title that happens to begin inside the column is not a column start
        starts = [l.bbox[0] for l in narrow if model.col_of(l.bbox[0] + 1.0) == i + 1 and not model.crosses(l.bbox)]
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
            x = l.bbox[0] + 1.0 if not model.crosses(l.bbox) else (l.bbox[0] + l.bbox[2]) / 2
            ci = model.col_of(x)
            cells[ci] = (cells[ci] + " " + l.text).strip()
        y0 = min(l.bbox[1] for l in b)
        y1 = max(l.bbox[3] for l in b)
        gap = (y0 - last_y1) if last_y1 is not None else 0.0
        if _is_numbered_header(cells):
            if cur is not None:
                rows.append(([" ".join(c).strip() for c in cur], tuple(cur_box)))
            rows.append((cells, (min(l.bbox[0] for l in b), y0, max(l.bbox[2] for l in b), y1)))
            cur, last_y1 = None, y1
            continue
        big_gap = last_y1 is not None and gap > line_h * 1.4
        # a keyless sub-case ("(2) if the offence be not committed...") fills
        # several cells at once and, in at least one of them, cannot continue
        # the text already there (a second "Ditto", or a new sentence)
        sub_row = cur is not None and sum(1 for c in cells if c) >= 2 and any(
            _breaks_cell(" ".join(cur[i]), cells[i]) for i in range(model.n) if i != key_col)
        if bool(cells[key_col]) or cur is None or big_gap or sub_row:
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


_DITTO = re.compile(r"^(ditto|do)\.?$", re.I)


def _breaks_cell(prev: str, new: str) -> bool:
    """True when `new` cannot be the continuation of the cell text `prev`."""
    if not prev or not new:
        return False
    if _DITTO.match(prev.strip()):
        return True                    # a ditto is a whole cell; nothing continues it
    return prev.rstrip().endswith((".", ";", ":")) and re.match(r"[A-Z(\d]", new.strip()) is not None


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
    centers = _header_token_centers(body)
    own = infer_columns(body, W)
    model = own
    # A page that prints its own "(1) (2) (3)" row says exactly where its columns are;
    # only a page without one borrows the previous page's model.
    if prior is not None and not (centers and own is not None and own.n == len(centers)):
        narrow = [l for l in body if (l.bbox[2] - l.bbox[0]) < 0.5 * W]
        cross_prior = sum(1 for l in narrow if prior.crosses(l.bbox))
        cross_own = sum(1 for l in narrow if own.crosses(l.bbox)) if own else len(narrow)
        fits_prior = narrow and cross_prior <= 0.25 * len(narrow)
        if fits_prior and (own is None or cross_prior <= cross_own):
            model = prior
    if model is None:
        return []
    body = _split_glued_keys(body, model)
    # Header cells are centred over left-aligned columns, so they straddle the
    # boundary; keep a line that crosses exactly one cut when it sits above the
    # first keyed line.
    first_key_y = min((l.bbox[1] for l in body if _KEYISH.match(l.text.strip()) and not model.crosses(l.bbox)), default=None)

    def _fits(l: Line) -> bool:
        if l.bbox[0] < model.left - 10:
            return False
        if not model.crosses(l.bbox):
            return True
        return model.crossed(l.bbox) == 1 and first_key_y is not None and l.bbox[1] < first_key_y

    fitting = [l for l in body if _fits(l)]
    # A centred title inside the table region (the heading of the next part)
    # ends this table; what follows is left to the text pass.
    if first_key_y is not None:
        ys = sorted(l.bbox[1] for l in body)
        def _alone(l: Line) -> bool:
            return sum(1 for y in ys if abs(y - l.bbox[1]) <= 3) == 1
        titles = [l for l in body if l.bbox[1] > first_key_y and model.crossed(l.bbox) >= 2
                  and abs((l.bbox[0] + l.bbox[2]) / 2 - W / 2) < 0.1 * W and _alone(l)]
        if titles:
            cutoff = min(l.bbox[1] for l in titles)
            fitting = [l for l in fitting if l.bbox[3] <= cutoff + 1]
    if len(fitting) < 8 or len(fitting) < 0.5 * len(body):
        return []

    prelim = _group_rows(fitting, model, key_col=0)
    key_col = _pick_key_column([r for r, _ in prelim], model.n)
    rows = _group_rows(fitting, model, key_col=key_col) if key_col != 0 else prelim

    header = [""] * model.n
    leading: list[tuple[list[str], BBox]] = []      # keyless rows before the first keyed row
    data: list[tuple[list[str], BBox]] = []
    number_rows: list[BBox] = []                    # "(1) (2) (3)" rows: part of the table, not text
    for cells, box in rows:
        if _is_numbered_header(cells):
            number_rows.append(box)
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
    # A keyless row with a single cell is the tail of the row above it, pushed
    # down by a gap; glue it back. A keyless row with more cells is a sub-case
    # of the same key ("if the offence be not committed..." under section 59);
    # fill the key down so the row stands on its own when flattened.
    merged: list[tuple[list[str], BBox]] = []
    for cells, box in data:
        filled = [i for i, c in enumerate(cells) if c]
        if merged and not cells[key_col] and len(filled) == 1 and filled[0] != key_col:
            prev_cells, prev_box = merged[-1]
            i = filled[0]
            prev_cells[i] = (prev_cells[i] + " " + cells[i]).strip()
            merged[-1] = (prev_cells, (min(prev_box[0], box[0]), prev_box[1], max(prev_box[2], box[2]), box[3]))
            continue
        merged.append((cells, box))
    data = merged
    last_key = ""
    for cells, _ in data:
        if cells[key_col]:
            last_key = cells[key_col]
        elif last_key:
            cells[key_col] = last_key

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
    # the column-number row just above the first data row belongs to the table
    above = [b for b in number_rows if b[3] <= bbox[1] + 2 and bbox[1] - b[1] < 40]
    if above:
        top = min(b[1] for b in above)
        bbox = (min(bbox[0], min(b[0] for b in above)), top, max(bbox[2], max(b[2] for b in above)), bbox[3])
    tb = TableBlock(page=pno, bbox=bbox, header=header, rows=[r for r, _ in data], bboxes=[(pno, bbox)])
    tb.consumed_lines = {id(l) for l in fitting if any(b[1] - 1 <= l.bbox[1] <= b[3] + 1 and _NUM_HEADER.match(l.text.strip()) for b in number_rows)}  # type: ignore[attr-defined]
    tb.row_bboxes = [b for _, b in data]                    # type: ignore[attr-defined]
    tb.row_pages = [pno] * len(data)                         # type: ignore[attr-defined]
    tb.column_model = model                                  # type: ignore[attr-defined]
    tb.has_header_text = has_header_text                     # type: ignore[attr-defined]
    tb.leading_rows = [c for c, _ in leading]                # type: ignore[attr-defined]
    tb.leading_boxes = [b for _, b in leading]               # type: ignore[attr-defined]
    tb.numbered_header = centers is not None                 # type: ignore[attr-defined]
    tb.key_col = key_col                                     # type: ignore[attr-defined]
    return [tb]


def _split_glued_keys(lines: list[Line], model: ColumnModel) -> list[Line]:
    """PyMuPDF sometimes returns "109(2)For commission of..." as one line that
    runs from the key column into the next. Split it at the first boundary so
    the key starts its row and the text lands in its own column."""
    if not model.cuts:
        return lines
    c0 = model.cuts[0]
    out: list[Line] = []
    for l in lines:
        x0, y0, x1, y1 = l.bbox
        m = _GLUED_KEY.match(l.text.strip()) if x0 < c0 - 1.5 < x1 and model.col_of(x0 + 1.0) == 0 else None
        if not m:
            out.append(l)
            continue
        key, rest = m.group(1), m.group(2)
        kx1 = min(c0 - 1.0, x0 + (x1 - x0) * len(key) / max(1, len(l.text.strip())))
        out.append(Line(key, (x0, y0, kx1, y1), l.size, l.bold))
        out.append(Line(rest, (c0 + 1.0, y0, x1, y1), l.size, l.bold))
    return out


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
                rows = list(cand.rows)
                boxes = list(getattr(cand, "row_bboxes", None) or [])
                key_col = getattr(open_tbl, "key_col", 0)
                extra: list[list[str]] = []
                extra_boxes: list[BBox] = []
                lead_boxes = getattr(cand, "leading_boxes", [])
                for li, lead in enumerate(getattr(cand, "leading_rows", [])):
                    last = (extra or open_tbl.rows)[-1]
                    if sum(1 for c in lead if c) >= 3:
                        # several cells at once: a sub-case row continuing the last key
                        lead = list(lead)
                        if key_col < len(lead) and key_col < len(last) and not lead[key_col]:
                            lead[key_col] = last[key_col]
                        extra.append(lead)
                        if li < len(lead_boxes):
                            extra_boxes.append(lead_boxes[li])
                        continue
                    for i, c in enumerate(lead):
                        if c and i < len(last):
                            last[i] = (last[i] + " " + c).strip()
                if rows and _norm_row(rows[0]) == _norm_row(open_tbl.header):
                    rows, boxes = rows[1:], boxes[1:]
                # A continuation page usually has no header text; if the detector
                # mistook the first data row for a header, put it back.
                if any(cand.header) and _norm_row(cand.header) != _norm_row(open_tbl.header) and not getattr(cand, "has_header_text", False):
                    rows = [cand.header] + rows
                    boxes = [cand.bbox] + boxes
                rows = extra + rows
                boxes = extra_boxes + boxes
                open_tbl.rows.extend(rows)
                rp = getattr(open_tbl, "row_pages", None)
                if rp is not None:
                    rp.extend([p] * len(rows))          # the page each row sits on, in row order
                open_tbl.bboxes.append((p, cand.bbox))
                rb_prev = getattr(open_tbl, "row_bboxes", None)
                if rb_prev is not None and len(boxes) == len(rows):
                    rb_prev.extend(boxes)
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
    # Pages that each print a "(1) (2) (3)" row are the same table when the count
    # matches; the columns themselves drift by up to 5% of the width in gazette
    # typesetting, so the position check is loose.
    both_numbered = getattr(prev, "numbered_header", False) and getattr(nxt, "numbered_header", False)
    if cm_prev and cm_next and not both_numbered and not cm_prev.similar(cm_next, tol=page_width * 0.05):
        return False
    prev_bottom = prev.bboxes[-1][1][3]
    if prev_bottom < 0.60 * page_heights[p_prev]:
        return False
    if nxt.bbox[1] > 0.35 * page_heights[p_next]:
        return False
    return True
