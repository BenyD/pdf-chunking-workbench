"""Strategy 2: structure-aware chunking. Deterministic, no model calls.

Rules, in order of what they protect:
  * A chunk never crosses a heading. The breadcrumb (document > chapter >
    section) is prepended as context so the chunk explains itself.
  * A table is one chunk. If it is too big, it is split by rows and the header
    is repeated in every part. Every row is ALSO emitted as its own chunk,
    flattened to "Header: value" pairs, with the table part as its parent.
  * A figure is one chunk made of its caption, the text found on it, the
    sentences elsewhere in the document that refer to it, and the key to its
    bare labels (A, B, 1, 2) when that key is a table or list elsewhere.
  * Prose inside a section is packed paragraph by paragraph up to the token
    budget; an oversized paragraph is cut at sentence boundaries.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..config import settings
from ..parse.model import FigureBlock, PageLayout, TableBlock, TextBlock, frac, union
from ..parse.tables import resolve_ditto, row_to_text, to_markdown
from .legend import bind_all
from .references import link_all
from .model import ChunkDraft, link_sequence
from .tokens import count

_SENT = re.compile(r"(?<=[.;:!?])\s+(?=[A-Z(“\"\d])")


@dataclass
class _Crumbs:
    doc_title: str
    stack: list[tuple[int, str]] = field(default_factory=list)

    def push(self, level: int, title: str, merge_same_level: bool = False) -> None:
        if merge_same_level and self.stack and self.stack[-1][0] == level:
            self.stack[-1] = (level, f"{self.stack[-1][1]} — {title}")
            return
        while self.stack and self.stack[-1][0] >= level:
            self.stack.pop()
        self.stack.append((level, title))

    def text(self) -> str:
        return " > ".join([self.doc_title] + [t for _, t in self.stack])

    def section(self) -> str | None:
        return self.stack[-1][1] if self.stack else None


def chunk_structural(layouts: list[PageLayout], doc_title: str, max_tokens: int | None = None) -> list[ChunkDraft]:
    max_tokens = max_tokens or settings.chunk_max_tokens
    dims = {l.number: (l.width, l.height) for l in layouts}
    crumbs = _Crumbs(doc_title)
    chunks: list[ChunkDraft] = []
    buffer: list[TextBlock] = []
    last_was_heading_only = False
    all_text_blocks = [b for lay in layouts for b in lay.blocks if isinstance(b, TextBlock)]

    def flush(final: bool = False) -> None:
        nonlocal buffer
        # A stray "5" or "A" (a number or letter cut off from its heading) is no passage on its own, and a short
        # vector like that sits close to every question. It joins the text that comes next.
        if buffer and not final and sum(ch.isalnum() for b in buffer for ch in (b.text or "")) < 3:
            return
        if buffer:
            chunks.extend(_pack_text(buffer, crumbs.text(), max_tokens, dims))
            buffer = []

    for lay in layouts:
        for block in lay.blocks:
            if isinstance(block, TextBlock):
                if block.heading_level:
                    flush()
                    pre = getattr(block, "pre_heading", None)
                    if pre:
                        crumbs.push(3 if block.heading_level >= 2 else block.heading_level, pre)
                        crumbs.push(block.heading_level + 1 if block.heading_level >= 2 else 2, block.heading_title)
                    else:
                        crumbs.push(block.heading_level, block.heading_title,
                                    merge_same_level=(block.heading_level == 1 and last_was_heading_only))
                    last_was_heading_only = block.heading_only
                    if block.heading_only:
                        continue
                else:
                    last_was_heading_only = False
                buffer.append(block)
            elif isinstance(block, TableBlock):
                flush()
                last_was_heading_only = False
                chunks.extend(_table_chunks(block, crumbs, dims))
            elif isinstance(block, FigureBlock):
                flush()
                last_was_heading_only = False
                chunks.append(_figure_chunk(block, crumbs.text(), dims, all_text_blocks))
    flush(final=True)
    bind_all(chunks)          # a figure's bare labels (A, B, 1, 2) tied to the key that explains them, wherever it is
    link_sequence(chunks)
    link_all(chunks)          # "see Table 2", "(5.1)", "unit 117": links to where the rest of the answer is
    return chunks


# ---------------------------------------------------------------------------
# prose
# ---------------------------------------------------------------------------

def _pack_text(blocks: list[TextBlock], breadcrumb: str, max_tokens: int, dims: dict) -> list[ChunkDraft]:
    paras: list[tuple[str, int, tuple]] = []   # (text, page, bbox)
    for b in blocks:
        txt = b.text
        if not txt:
            continue
        if count(txt) <= max_tokens:
            paras.append((txt, b.page, b.bbox))
        else:
            # cut an oversized paragraph at sentence boundaries; it keeps the whole block's bbox
            for piece in _split_sentences(txt, max_tokens):
                paras.append((piece, b.page, b.bbox))

    out: list[ChunkDraft] = []
    cur: list[tuple[str, int, tuple]] = []
    cur_tokens = 0
    for p in paras:
        n = count(p[0])
        if cur and cur_tokens + n > max_tokens:
            out.append(_text_chunk(cur, breadcrumb, dims))
            cur, cur_tokens = [], 0
        cur.append(p)
        cur_tokens += n
    if cur:
        out.append(_text_chunk(cur, breadcrumb, dims))
    return out


def _split_sentences(text: str, max_tokens: int) -> list[str]:
    sents = _SENT.split(text)
    out, cur, cur_n = [], [], 0
    for s in sents:
        n = count(s)
        if cur and cur_n + n > max_tokens:
            out.append(" ".join(cur))
            cur, cur_n = [], 0
        cur.append(s)
        cur_n += n
    if cur:
        out.append(" ".join(cur))
    return out


def _text_chunk(paras: list[tuple[str, int, tuple]], breadcrumb: str, dims: dict) -> ChunkDraft:
    pages = sorted({p[1] for p in paras})
    bboxes = []
    for pg in pages:
        boxes = [p[2] for p in paras if p[1] == pg]
        w, h = dims[pg]
        bboxes.append({"page": pg, **frac(union(boxes), w, h)})
    return ChunkDraft(
        chunk_type="text",
        raw_text="\n\n".join(p[0] for p in paras),
        context=breadcrumb,
        page_start=pages[0],
        page_end=pages[-1],
        bboxes=bboxes,
        metadata={"breadcrumb": breadcrumb, "paragraphs": len(paras)},
    )


# ---------------------------------------------------------------------------
# tables
# ---------------------------------------------------------------------------

def _table_chunks(tb: TableBlock, crumbs: _Crumbs, dims: dict) -> list[ChunkDraft]:
    header = [h or f"col{i+1}" for i, h in enumerate(tb.header)]
    rows = tb.rows
    resolved = resolve_ditto(rows)
    row_bboxes = getattr(tb, "row_bboxes", None)
    breadcrumb = crumbs.text()
    caption = tb.caption or (crumbs.section() and f"Table in {crumbs.section()}") or "Table"
    limit = settings.table_max_tokens
    header_cost = count(to_markdown(header, []))

    # Split rows into parts that fit the budget, header repeated in each part
    parts: list[list[int]] = []
    cur: list[int] = []
    cur_n = header_cost
    for i, r in enumerate(rows):
        n = count("| " + " | ".join(r) + " |")
        if cur and cur_n + n > limit:
            parts.append(cur)
            cur, cur_n = [], header_cost
        cur.append(i)
        cur_n += n
    if cur:
        parts.append(cur)

    out: list[ChunkDraft] = []
    for pi, idxs in enumerate(parts):
        part_rows = [rows[i] for i in idxs]
        bboxes = _bboxes_for_rows(tb, idxs, row_bboxes, dims)
        pages = sorted({b["page"] for b in bboxes})
        md = to_markdown(header, part_rows)
        label = f"{caption}" + (f" (part {pi+1} of {len(parts)})" if len(parts) > 1 else "")
        table_chunk = ChunkDraft(
            chunk_type="table",
            raw_text=md,
            context=f"{breadcrumb} > {label}",
            page_start=pages[0],
            page_end=pages[-1],
            bboxes=bboxes,
            metadata={"breadcrumb": breadcrumb, "caption": caption, "header": header,
                      "row_count": len(part_rows), "part": pi + 1, "parts": len(parts),
                      "row_range": [idxs[0], idxs[-1]]},
        )
        out.append(table_chunk)
        for i in idxs:
            rb = _bboxes_for_rows(tb, [i], row_bboxes, dims)
            out.append(ChunkDraft(
                chunk_type="table_row",
                raw_text=row_to_text(header, resolved[i]),
                context=f"{breadcrumb} > {caption} > row {i+1}",
                page_start=rb[0]["page"],
                page_end=rb[-1]["page"],
                bboxes=rb,
                parent_id=table_chunk.id,
                metadata={"breadcrumb": breadcrumb, "caption": caption, "header": header,
                          "row_index": i, "cells": rows[i], "resolved_cells": resolved[i]},
            ))
    return out


def _bboxes_for_rows(tb: TableBlock, idxs: list[int], row_bboxes, dims: dict) -> list[dict]:
    if row_bboxes and all(i < len(row_bboxes) for i in idxs):
        # which page is each row on? walk the per-page table bboxes
        per_page: dict[int, list] = {}
        for i in idxs:
            rb = row_bboxes[i]
            pg = _page_for_row(tb, i, len(row_bboxes))
            per_page.setdefault(pg, []).append(rb)
        out = []
        for pg in sorted(per_page):
            w, h = dims[pg]
            out.append({"page": pg, **frac(union(per_page[pg]), w, h)})
        return out
    return [{"page": pg, **frac(bb, *dims[pg])} for pg, bb in tb.bboxes]


def _page_for_row(tb: TableBlock, i: int, total: int) -> int:
    """Rows are stored in order across pages; map an index to the page whose
    table bbox contains the row's y. Falls back to proportional placement."""
    rp = getattr(tb, "row_pages", None)
    if rp and i < len(rp):
        return rp[i]                      # recorded by the parser while merging pages
    rb = getattr(tb, "row_bboxes", None)
    if rb and i < len(rb):
        y = (rb[i][1] + rb[i][3]) / 2
        # candidate pages in order; the row belongs to the first page whose
        # table region vertically contains it and comes after the previous row's page
        prev_pg = tb.bboxes[0][0]
        if i > 0:
            prev_pg = _page_for_row_cached(tb, i - 1)
        for pg, bb in tb.bboxes:
            if pg < prev_pg:
                continue
            if bb[1] - 2 <= y <= bb[3] + 2:
                _cache(tb)[i] = pg
                return pg
        _cache(tb)[i] = prev_pg
        return prev_pg
    return tb.bboxes[min(len(tb.bboxes) - 1, int(i / max(total, 1) * len(tb.bboxes)))][0]


def _cache(tb: TableBlock) -> dict:
    c = getattr(tb, "_row_pages", None)
    if c is None:
        c = {}
        tb._row_pages = c  # type: ignore[attr-defined]
    return c


def _page_for_row_cached(tb: TableBlock, i: int) -> int:
    c = _cache(tb)
    if i in c:
        return c[i]
    return _page_for_row(tb, i, len(getattr(tb, "row_bboxes", []) or []))


# ---------------------------------------------------------------------------
# figures
# ---------------------------------------------------------------------------

def _figure_chunk(fig: FigureBlock, breadcrumb: str, dims: dict, all_text_blocks: list[TextBlock]) -> ChunkDraft:
    parts = []
    if fig.caption:
        parts.append(fig.caption)
    else:
        parts.append(f"Figure on page {fig.page}.")
    if fig.labels:
        parts.append("Text on the figure: " + "; ".join(dict.fromkeys(fig.labels)))
    refs = _referencing_sentences(fig, all_text_blocks)
    if refs:
        parts.append("Referenced in the text: " + " ".join(refs))
    w, h = dims[fig.page]
    return ChunkDraft(
        chunk_type="figure",
        raw_text="\n".join(parts),
        context=breadcrumb,
        page_start=fig.page,
        page_end=fig.page,
        bboxes=[{"page": fig.page, **frac(fig.bbox, w, h)}],
        metadata={"breadcrumb": breadcrumb, "caption": fig.caption, "labels": fig.labels,
                  "figure_number": fig.figure_number, "references": refs},
        image_png=fig.image_png,
    )


def _referencing_sentences(fig: FigureBlock, blocks: list[TextBlock], limit: int = 3) -> list[str]:
    if not fig.figure_number:
        return []
    pat = re.compile(rf"\b(fig(?:ure)?\.?|image|photo|plate|diagram|exhibit)\s*{re.escape(fig.figure_number)}\b", re.I)
    out: list[str] = []
    for b in blocks:
        if abs(b.page - fig.page) > 3:
            continue
        for s in _SENT.split(b.text):
            if pat.search(s) and not s.strip().lower().startswith(("fig", "figure")):
                out.append(s.strip())
                if len(out) >= limit:
                    return out
    return out
