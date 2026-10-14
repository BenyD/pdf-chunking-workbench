"""Strategy 1: naive fixed-size windows.

This is the baseline everyone starts with: concatenate the text, cut every N
tokens, overlap a little. It is line-granular here so each chunk still knows
which page regions it came from; that is what lets the UI show a naive chunk
slicing straight through a table.
"""
from __future__ import annotations

from ..config import settings
from ..parse.model import PageLayout, frac, union
from .model import ChunkDraft, link_sequence
from .tokens import count


def chunk_naive(layouts: list[PageLayout], doc_title: str,
                max_tokens: int | None = None, overlap_tokens: int | None = None) -> list[ChunkDraft]:
    max_tokens = max_tokens or settings.chunk_max_tokens
    overlap_tokens = overlap_tokens or settings.chunk_overlap_tokens

    # Flatten to (page, bbox, text, tokens)
    units: list[tuple[int, tuple, str, int]] = []
    for lay in layouts:
        for ln in lay.lines:
            if ln.text.strip():
                units.append((lay.number, ln.bbox, ln.text.strip(), count(ln.text)))

    dims = {lay.number: (lay.width, lay.height) for lay in layouts}
    chunks: list[ChunkDraft] = []
    i = 0
    while i < len(units):
        j, toks = i, 0
        while j < len(units) and (toks + units[j][3] <= max_tokens or j == i):
            toks += units[j][3]
            j += 1
        window = units[i:j]
        chunks.append(_make(window, dims))
        if j >= len(units):
            break
        # Step back so the next window repeats ~overlap_tokens of text.
        back, k = 0, j
        while k > i + 1 and back < overlap_tokens:
            k -= 1
            back += units[k][3]
        i = max(k, i + 1)

    link_sequence(chunks)
    return chunks


def _make(window, dims) -> ChunkDraft:
    text = "\n".join(u[2] for u in window)
    pages = sorted({u[0] for u in window})
    bboxes = []
    for p in pages:
        boxes = [u[1] for u in window if u[0] == p]
        w, h = dims[p]
        bboxes.append({"page": p, **frac(union(boxes), w, h)})
    return ChunkDraft(
        chunk_type="text",
        raw_text=text,
        context=None,
        page_start=pages[0],
        page_end=pages[-1],
        bboxes=bboxes,
        metadata={"strategy_note": "fixed window, line granular"},
    )
