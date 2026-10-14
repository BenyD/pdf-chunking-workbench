"""Zonal (template) OCR.

The user draws named boxes on a sample page. For a new scan of the same form we:
  1. render at 300 dpi and deskew (scans are never perfectly straight)
  2. OCR the whole page once to get word positions
  3. register: find the template's anchor words and compute the offset/scale
     between where they should be and where they are
  4. crop each field box (shifted by that offset), upscale, OCR it alone
  5. parse by type and validate; low confidence or failed validation marks the
     field for the model fallback

Boxes are fractions of page width/height so a template drawn on a 90 dpi
render applies to a 300 dpi scan unchanged.
"""
from __future__ import annotations

import difflib
import re
import statistics
from dataclasses import dataclass, field

import cv2
import numpy as np
import pymupdf
import pytesseract

from ..config import settings

if settings.tesseract_cmd:
    pytesseract.pytesseract.tesseract_cmd = settings.tesseract_cmd

CONF_THRESHOLD = 70.0


@dataclass
class Word:
    text: str
    x: float
    y: float
    w: float
    h: float
    conf: float

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2


@dataclass
class FieldResult:
    name: str
    type: str
    value: object
    raw: str
    confidence: float
    source: str                       # tesseract | llm | none
    valid: bool
    box_used: dict = field(default_factory=dict)
    note: str = ""


# ---------------------------------------------------------------------------
# rendering / deskew
# ---------------------------------------------------------------------------

def render_gray(pdf_bytes: bytes, page_number: int, dpi: int) -> np.ndarray:
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    page = doc[page_number - 1]
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY, alpha=False)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width).copy()


def deskew(gray: np.ndarray) -> tuple[np.ndarray, float]:
    """Estimate skew from the orientation of text lines and rotate it out."""
    thr = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, gray.shape[1] // 60), 1))
    joined = cv2.dilate(thr, kernel, iterations=1)
    contours, _ = cv2.findContours(joined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    angles = []
    for c in contours:
        (_, _), (w, h), ang = cv2.minAreaRect(c)
        if max(w, h) < gray.shape[1] * 0.15:
            continue
        if w < h:
            ang += 90
        if ang > 45:
            ang -= 90
        angles.append(ang)
    if len(angles) < 3:
        return gray, 0.0
    angle = statistics.median(angles)
    if abs(angle) < 0.15 or abs(angle) > 15:
        return gray, 0.0
    h, w = gray.shape
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    rotated = cv2.warpAffine(gray, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=255)
    return rotated, float(angle)


# ---------------------------------------------------------------------------
# OCR primitives
# ---------------------------------------------------------------------------

def page_words(gray: np.ndarray) -> list[Word]:
    data = pytesseract.image_to_data(gray, output_type=pytesseract.Output.DICT, config="--psm 3")
    words = []
    for i, txt in enumerate(data["text"]):
        t = (txt or "").strip()
        conf = float(data["conf"][i])
        if not t or conf < 0:
            continue
        words.append(Word(t, data["left"][i], data["top"][i], data["width"][i], data["height"][i], conf))
    return words


def ocr_region(region: np.ndarray, single_line: bool) -> tuple[str, float]:
    if region.size == 0:
        return "", 0.0
    up = cv2.resize(region, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    up = cv2.GaussianBlur(up, (3, 3), 0)
    up = cv2.threshold(up, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    up = cv2.copyMakeBorder(up, 20, 20, 20, 20, cv2.BORDER_CONSTANT, value=255)
    psm = 7 if single_line else 6
    data = pytesseract.image_to_data(up, output_type=pytesseract.Output.DICT, config=f"--psm {psm}")
    toks, confs = [], []
    for i, txt in enumerate(data["text"]):
        t = (txt or "").strip()
        c = float(data["conf"][i])
        if t and c >= 0:
            toks.append(t)
            confs.append(c)
    return " ".join(toks), (statistics.mean(confs) if confs else 0.0)


# ---------------------------------------------------------------------------
# registration
# ---------------------------------------------------------------------------

def register(anchors: list[dict], words: list[Word], W: int, H: int) -> dict:
    """Match template anchors to OCR'd words; return pixel dx, dy and a scale."""
    matches = []
    for a in anchors:
        box = a["box"]
        ex, ey = (box["x"] + box["w"] / 2) * W, (box["y"] + box["h"] / 2) * H
        target = re.sub(r"[^a-z0-9]", "", a["text"].lower())
        best, best_score = None, 0.0
        for w in words:
            cand = re.sub(r"[^a-z0-9]", "", w.text.lower())
            if not cand:
                continue
            score = difflib.SequenceMatcher(None, target, cand).ratio()
            # prefer candidates near the expected spot when scores tie
            dist = ((w.cx - ex) ** 2 + (w.cy - ey) ** 2) ** 0.5
            score -= min(dist / max(W, H), 0.3) * 0.5
            if score > best_score:
                best, best_score = w, score
        if best and best_score >= 0.6:
            matches.append(((ex, ey), (best.cx, best.cy), a["text"], best.text))

    if not matches:
        return {"dx": 0.0, "dy": 0.0, "scale": 1.0, "matched": []}

    dx = statistics.median(m[1][0] - m[0][0] for m in matches)
    dy = statistics.median(m[1][1] - m[0][1] for m in matches)
    # Scale only with three or more anchors (two cannot separate scale from a
    # mis-located anchor) and only within what a scanner can plausibly do.
    scale = 1.0
    if len(matches) >= 3:
        ratios = []
        for i in range(len(matches)):
            for j in range(i + 1, len(matches)):
                e1, a1 = matches[i][0], matches[i][1]
                e2, a2 = matches[j][0], matches[j][1]
                de = ((e2[0] - e1[0]) ** 2 + (e2[1] - e1[1]) ** 2) ** 0.5
                da = ((a2[0] - a1[0]) ** 2 + (a2[1] - a1[1]) ** 2) ** 0.5
                if de > 0.15 * max(W, H):
                    ratios.append(da / de)
        if ratios:
            scale = max(0.95, min(1.05, statistics.median(ratios)))
    if scale != 1.0:
        # the shift must be measured after scaling the expected positions
        dx = statistics.median(m[1][0] - m[0][0] * scale for m in matches)
        dy = statistics.median(m[1][1] - m[0][1] * scale for m in matches)
    return {"dx": float(dx), "dy": float(dy), "scale": float(scale),
            "matched": [{"anchor": m[2], "found": m[3]} for m in matches]}


# ---------------------------------------------------------------------------
# parsing by type
# ---------------------------------------------------------------------------

_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}


def parse_value(raw: str, ftype: str, pattern: str | None = None) -> tuple[object, bool]:
    s = re.sub(r"\s+", " ", raw).strip()
    if pattern and not re.search(pattern, s):
        return s, False
    if ftype == "date":
        m = re.search(r"(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2,4})", s)
        if m:
            d, mo, y = int(m[1]), int(m[2]), int(m[3])
            y = y + 2000 if y < 100 else y
            if 1 <= d <= 31 and 1 <= mo <= 12:
                return f"{y:04d}-{mo:02d}-{d:02d}", True
        m = re.search(r"(\d{1,2})\s*([A-Za-z]{3,9})[,.]?\s*(\d{4})", s)
        if m and m[2][:3].lower() in _MONTHS:
            return f"{int(m[3]):04d}-{_MONTHS[m[2][:3].lower()]:02d}-{int(m[1]):02d}", True
        m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s)
        if m:
            return m[0], True
        return s, False
    if ftype == "amount":
        cleaned = s.replace("O", "0").replace("o", "0")
        m = re.search(r"\d[\d,]*(?:\.\d{1,2})?", cleaned)
        if m:
            try:
                return float(m[0].replace(",", "")), True
            except ValueError:
                pass
        return s, False
    if ftype == "integer":
        m = re.search(r"\d+", s.replace("O", "0"))
        return (int(m[0]), True) if m else (s, False)
    return s, bool(s)


# ---------------------------------------------------------------------------
# main entry
# ---------------------------------------------------------------------------

def run_template(pdf_bytes: bytes, page_number: int, template: dict) -> dict:
    gray = render_gray(pdf_bytes, page_number, settings.ocr_dpi)
    gray, angle = deskew(gray)
    H, W = gray.shape
    words = page_words(gray)
    reg = register(template.get("anchors", []), words, W, H)

    results: list[FieldResult] = []
    for f in template.get("fields", []):
        if int(f.get("page", 1)) != page_number:
            continue
        b = f["box"]
        # apply registration: scale about the page origin, then shift
        x0 = int(b["x"] * W * reg["scale"] + reg["dx"])
        y0 = int(b["y"] * H * reg["scale"] + reg["dy"])
        x1 = int((b["x"] + b["w"]) * W * reg["scale"] + reg["dx"])
        y1 = int((b["y"] + b["h"]) * H * reg["scale"] + reg["dy"])
        pad = int(0.004 * W)
        x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
        x1, y1 = min(W, x1 + pad), min(H, y1 + pad)
        region = gray[y0:y1, x0:x1]
        single = f.get("type", "text") in ("date", "amount", "integer") or (y1 - y0) < 0.03 * H
        raw, conf = ocr_region(region, single_line=single)
        value, ok = parse_value(raw, f.get("type", "text"), f.get("pattern"))
        results.append(FieldResult(
            name=f["name"], type=f.get("type", "text"), value=value, raw=raw, confidence=round(conf, 1),
            source="tesseract" if raw else "none", valid=ok and conf >= CONF_THRESHOLD,
            box_used={"x": x0 / W, "y": y0 / H, "w": (x1 - x0) / W, "h": (y1 - y0) / H},
            note="" if (ok and conf >= CONF_THRESHOLD) else ("low confidence" if ok else "failed validation"),
        ))

    return {
        "page_number": page_number,
        "deskew_angle": round(angle, 2),
        "registration": reg,
        "render_size": {"w": W, "h": H},
        "fields": [r.__dict__ for r in results],
        "needs_fallback": [r.name for r in results if not r.valid],
    }


def page_png(pdf_bytes: bytes, page_number: int, dpi: int = 150) -> bytes:
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    return doc[page_number - 1].get_pixmap(dpi=dpi, alpha=False).tobytes("png")


def words_for_ui(pdf_bytes: bytes, page_number: int) -> list[dict]:
    """OCR'd words as fractional boxes so the template designer can offer anchors."""
    gray = render_gray(pdf_bytes, page_number, 200)
    gray, _ = deskew(gray)
    H, W = gray.shape
    return [
        {"text": w.text, "conf": round(w.conf, 1), "box": {"x": w.x / W, "y": w.y / H, "w": w.w / W, "h": w.h / H}}
        for w in page_words(gray) if w.conf >= 50 and len(w.text) >= 3
    ]
