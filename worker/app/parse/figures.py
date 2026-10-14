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
        # Table borders are zero-area segments that sit exactly on the table's edge;
        # a 3 pt tolerance keeps them with the table instead of seeding a "figure".
        for e in excl:
            wide = pymupdf.Rect(e.x0 - 3, e.y0 - 3, e.x1 + 3, e.y1 + 3)
            if wide.contains(r) or (r.get_area() > 0 and (e & r).get_area() > 0.6 * r.get_area()):
                return True
        return False

    rects: list[pymupdf.Rect] = []
    image_rects: list[pymupdf.Rect] = []
    solid_rects: list[pymupdf.Rect] = []
    for info in page.get_image_info():
        r = pymupdf.Rect(info["bbox"]) & page.rect
        if r.is_empty or r.get_area() < 0.004 * area or excluded(r):
            continue
        rects.append(r)
        image_rects.append(r)
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
        if min(w, h) >= 3:
            solid_rects.append(r)      # a shape, not a hairline
    if not rects:
        return []

    figs: list[FigureBlock] = []
    for c in _cluster(rects, margin=14):
        if c.get_area() < 0.02 * area or c.get_area() > 0.85 * area:
            continue
        has_image = any(c.intersects(i) for i in image_rects)
        # Hairlines alone (cell borders, header rules) never make a figure, and a
        # full-width thin band is a running header or footer decoration.
        if not has_image and not any(c.intersects(sr) for sr in solid_rects):
            continue
        if c.width > 0.9 * W and c.height < 0.07 * H:
            continue
        # A vector-only cluster mostly covered by text is decorated text (a
        # watermark, a box around a paragraph, a page frame), not a figure.
        if not has_image:
            text_area = sum(max(0.0, min(l.bbox[2], c.x1) - max(l.bbox[0], c.x0)) * max(0.0, min(l.bbox[3], c.y1) - max(l.bbox[1], c.y0))
                            for l in lines if pymupdf.Rect(l.bbox).intersects(c))
            if text_area > 0.2 * c.get_area():
                continue
        # The region already belongs to a table
        if any((c & e).get_area() > 0.5 * c.get_area() for e in excl):
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
