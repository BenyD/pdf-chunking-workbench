"""Full-page OCR for scanned pages (no text layer). Produces the same Line /
TextBlock structures as the PDF text extractor so everything downstream is
identical."""
from __future__ import annotations

import pymupdf
import pytesseract

from ..config import settings
from .model import Line, TextBlock

if settings.tesseract_cmd:
    pytesseract.pytesseract.tesseract_cmd = settings.tesseract_cmd


def looks_scanned(page: pymupdf.Page, lines: list[Line]) -> bool:
    chars = sum(len(l.text) for l in lines)
    if chars >= 40:
        return False
    area = page.rect.get_area()
    for info in page.get_image_info():
        if (pymupdf.Rect(info["bbox"]) & page.rect).get_area() > 0.45 * area:
            return True
    return False


def ocr_page(page: pymupdf.Page, dpi: int = 250) -> tuple[list[Line], list[TextBlock]]:
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY, alpha=False)
    import numpy as np
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT, config="--psm 3")
    s = 72.0 / dpi
    groups: dict[tuple[int, int, int], list[tuple[str, float, float, float, float]]] = {}
    for i, txt in enumerate(data["text"]):
        t = (txt or "").strip()
        if not t or float(data["conf"][i]) < 0:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        x, y, w, h = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
        groups.setdefault(key, []).append((t, x * s, y * s, (x + w) * s, (y + h) * s))
    lines: list[Line] = []
    paras: dict[tuple[int, int], list[Line]] = {}
    for key in sorted(groups):
        ws = groups[key]
        bbox = (min(w[1] for w in ws), min(w[2] for w in ws), max(w[3] for w in ws), max(w[4] for w in ws))
        ln = Line(" ".join(w[0] for w in ws), bbox, size=bbox[3] - bbox[1], bold=False)
        lines.append(ln)
        paras.setdefault(key[:2], []).append(ln)
    blocks = []
    for key, ls in paras.items():
        bbox = (min(l.bbox[0] for l in ls), min(l.bbox[1] for l in ls), max(l.bbox[2] for l in ls), max(l.bbox[3] for l in ls))
        blocks.append(TextBlock(page=page.number + 1, bbox=bbox, lines=ls))
    return lines, blocks
