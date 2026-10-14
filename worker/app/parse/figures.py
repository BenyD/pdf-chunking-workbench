"""Figure detection.

A figure is a cluster of raster images and vector drawings. Arrows, circles and
callouts are usually vector paths drawn on top of a photo, so extracting the
embedded image alone would lose exactly the annotations we care about. We
cluster image rects with nearby drawing rects, grow the cluster to include text
labels sitting on it, and render that whole region as the figure image.
"""
from __future__ import annotations

import re

import pymupdf

from ..config import settings
from .model import BBox, FigureBlock, Line

_CAPTION = re.compile(r"^\s*(fig(?:ure)?\.?|image|photo(?:graph)?|plate|diagram|exhibit|chart|illustration)\s*\.?\s*([A-Za-z]?\d+(?:\.\d+)?)?", re.I)


def _cluster(rects: list[pymupdf.Rect], margin: float) -> list[pymupdf.Rect]:
    rects = [pymupdf.Rect(r) for r in rects]
    changed = True
    while changed:
        changed = False
        out: list[pymupdf.Rect] = []
        for r in rects:
            grown = pymupdf.Rect(r.x0 - margin, r.y0 - margin, r.x1 + margin, r.y1 + margin)
            for i, o in enumerate(out):
                if grown.intersects(o):
                    out[i] = o | r
                    changed = True
                    break
            else:
                out.append(r)
        rects = out
    return rects


def detect_figures(page: pymupdf.Page, lines: list[Line], exclude: list[BBox]) -> list[FigureBlock]:
    W, H = page.rect.width, page.rect.height
    area = W * H
    excl = [pymupdf.Rect(e) for e in exclude]

    def excluded(r: pymupdf.Rect) -> bool:
        return any(e.contains(r) or (e & r).get_area() > 0.6 * r.get_area() for e in excl)

    rects: list[pymupdf.Rect] = []
    for info in page.get_image_info():
        r = pymupdf.Rect(info["bbox"]) & page.rect
        if r.is_empty or r.get_area() < 0.004 * area or excluded(r):
            continue
        rects.append(r)
    for d in page.get_drawings():
        r = pymupdf.Rect(d["rect"]) & page.rect
        if r.is_empty:
            continue
        w, h = r.width, r.height
        if (w > 0.5 * W and h < 3) or (h > 0.5 * H and w < 3):   # rules and borders
            continue
        if w * h > 0.9 * area or excluded(r):
            continue
        rects.append(r)
    if not rects:
        return []

    figs: list[FigureBlock] = []
    for c in _cluster(rects, margin=14):
        if c.get_area() < 0.02 * area or c.get_area() > 0.85 * area:
            continue
        # text sitting on the figure = labels; grow the box to include them
        grown = pymupdf.Rect(c.x0 - 6, c.y0 - 6, c.x1 + 6, c.y1 + 6)
        labels = [l for l in lines if pymupdf.Rect(l.bbox).intersects(grown) and (l.bbox[2] - l.bbox[0]) < 0.6 * W]
        for l in labels:
            c |= pymupdf.Rect(l.bbox)
        caption, number, cap_lines = _find_caption(lines, c)
        clip = pymupdf.Rect(max(0, c.x0 - 4), max(0, c.y0 - 4), min(W, c.x1 + 4), min(H, c.y1 + 4))
        png = page.get_pixmap(clip=clip, dpi=settings.figure_dpi, alpha=False).tobytes("png")
        fb = FigureBlock(
            page=page.number + 1,
            bbox=(clip.x0, clip.y0, clip.x1, clip.y1),
            image_png=png,
            caption=caption,
            labels=[l.text for l in labels],
            figure_number=number,
        )
        fb.consumed_lines = set(id(l) for l in labels) | set(id(l) for l in cap_lines)  # type: ignore[attr-defined]
        figs.append(fb)
    return figs


def _find_caption(lines: list[Line], fig: pymupdf.Rect) -> tuple[str | None, str | None, list[Line]]:
    below = [l for l in lines if fig.y1 - 2 <= l.bbox[1] <= fig.y1 + 48 and _h_overlap(l.bbox, fig)]
    above = [l for l in lines if fig.y0 - 48 <= l.bbox[3] <= fig.y0 + 2 and _h_overlap(l.bbox, fig)]
    for group in (sorted(below, key=lambda l: l.bbox[1]), sorted(above, key=lambda l: -l.bbox[1])):
        for i, l in enumerate(group):
            m = _CAPTION.match(l.text)
            if m:
                text = l.text
                used = [l]
                # pull following lines of the same caption paragraph
                last = l
                for nxt in group[i + 1:]:
                    if 0 <= nxt.bbox[1] - last.bbox[3] <= 6 and nxt.bbox[1] > l.bbox[1]:
                        text += " " + nxt.text
                        used.append(nxt)
                        last = nxt
                    else:
                        break
                return text.strip(), (m.group(2) or None), used
    return None, None, []


def _h_overlap(b: BBox, r: pymupdf.Rect) -> bool:
    return min(b[2], r.x1) - max(b[0], r.x0) > 10
