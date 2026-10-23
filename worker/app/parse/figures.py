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
from .tables import grid_table

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
    def written_over(r: pymupdf.Rect) -> int:
        """Characters of text lying inside the rectangle: a slide's words over its template picture."""
        return sum(len(l.text) for l in lines if r.contains(pymupdf.Rect(l.bbox) + (-2, -2, 2, 2)))

    for info in page.get_image_info():
        r = pymupdf.Rect(info["bbox"]) & page.rect
        if r.is_empty or r.get_area() < 0.004 * area or excluded(r):
            continue
        # A slide's background: an image filling half the page or more with the slide's text written over it.
        # It is a template, not a figure; left out before clustering so the slide's own drawings and charts
        # still form figures of their own.
        if (info.get("width", 99) <= 4 or info.get("height", 99) <= 4) and r.get_area() > 0.05 * area:
            continue                                        # a one-pixel strip stretched into a gradient: decoration
        if r.get_area() > 0.25 * area and written_over(r) > 60:
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
    if not any(c.get_area() <= 0.85 * area for c in _cluster(rects, margin=14)):
        sheet = _drawing_sheet(page, lines)
        if sheet:
            return sheet

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
        # Text laid out as a grid inside the drawing, on a slide or over shaded cells with no rules, is a table
        grid = grid_table(labels, page.number + 1, (c.x0, c.y0, c.x1, c.y1)) if len(labels) >= 8 else None
        if grid is not None:
            fb = FigureBlock(page=page.number + 1, bbox=grid.bbox, image_png=b"", caption=None, labels=[], figure_number=None)
            fb.as_table = grid                              # type: ignore[attr-defined]
            fb.consumed_lines = set(id(l) for l in labels)  # type: ignore[attr-defined]
            figs.append(fb)
            continue
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


def shaded_grid_tables(page: pymupdf.Page, lines: list[Line], exclude: list[BBox]) -> list:
    """A table that has no ruling the ruled-table finder reads (a slide's cell shapes, one-point rectangles used as
    rules, shaded boxes): its words are short and sit in rows and columns. The short lines of the page, those a
    cell could hold, are tried as a grid (tables.grid_table); long prose lines and the slide's title are left out
    by being long. At most one per page. Returns the tables found, with the lines they used as consumed_lines."""
    W = page.rect.width
    ex = [pymupdf.Rect(e) for e in exclude]
    short = [l for l in lines if len(l.text) <= 32 and (l.bbox[2] - l.bbox[0]) < 0.3 * W
             and not any(pymupdf.Rect(l.bbox).intersects(e) for e in ex)]
    if len(short) < 10:
        return []
    top = min(l.bbox[1] for l in short)
    bbox = (min(l.bbox[0] for l in short), top, max(l.bbox[2] for l in short), max(l.bbox[3] for l in short))
    tb = grid_table(short, page.number + 1, bbox)
    if tb is None:
        return []
    tb.consumed_lines = set(id(l) for l in short)            # type: ignore[attr-defined]
    return [tb]


def _drawing_sheet(page: pymupdf.Page, lines: list[Line]) -> list[FigureBlock]:
    """A drawing sheet: the whole page is one image (a patent's drawings, a scanned diagram) with almost no text of
    its own ("Sheet 1 of 3"). Each separate drawing on it, found as a block of ink, becomes a figure."""
    import cv2
    import numpy as np
    W, H = page.rect.width, page.rect.height
    if sum(len(l.text) for l in lines) > 300 or not any((pymupdf.Rect(i["bbox"]) & page.rect).get_area() > 0.85 * W * H
                                                       for i in page.get_image_info()):
        return []
    pix = page.get_pixmap(dpi=100, colorspace=pymupdf.csGRAY)
    g = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width)
    ink = cv2.dilate(((g < 160) * 255).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_RECT, (25, 25)))
    n, _, st, _ = cv2.connectedComponentsWithStats(ink)
    s = 72 / 100
    figs = []
    for x, y, w, h, a in sorted((tuple(st[i]) for i in range(1, n)), key=lambda b: (b[1], b[0])):
        if a < 0.03 * pix.width * pix.height:
            continue
        r = pymupdf.Rect(x * s, y * s, (x + w) * s, (y + h) * s) & page.rect
        inside = [l for l in lines if r.contains(pymupdf.Rect(l.bbox))]
        if sum(len(l.text) for l in inside) > 0.5 * sum(len(l.text) for l in lines) and len(inside) == len(lines) and r.height < 0.1 * H:
            continue                                     # the sheet's own header line, not a drawing
        caption, number, cap_lines = _find_caption(lines, r)
        fb = FigureBlock(page=page.number + 1, bbox=(r.x0, r.y0, r.x1, r.y1),
                         image_png=page.get_pixmap(clip=r, dpi=settings.figure_dpi, alpha=False).tobytes("png"),
                         caption=caption, labels=[l.text for l in inside], figure_number=number, drawing=True)
        fb.consumed_lines = set(id(l) for l in inside) | set(id(l) for l in cap_lines)  # type: ignore[attr-defined]
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
