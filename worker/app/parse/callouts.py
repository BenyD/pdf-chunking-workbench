"""Read callout labels drawn INTO a figure's image: a circled 2, a boxed B, a red letter at an arrow's tail.

A label printed as PDF text is read by the parser already. One drawn into a photo or a scanned drawing is only
pixels, so it is found and read here with classic image processing and OCR, the way auto-ballooning tools for
engineering drawings do it: find the marker, crop it, read it. No generative model.

1. Markers. A callout is a small closed shape, roundish or square, with ink inside it. Contours of the dark
   strokes and of the saturated-colour strokes are kept when their size fits a marker (8 to 65 px radius at
   the 150 dpi the parser renders figures at), their shape is a circle or a square (4 pi area / perimeter^2 of
   at least 0.70), and the inside holds some ink but is not filled with it. A coloured glyph standing alone,
   with no ring around it, is kept too; a black one is not, since photos are full of dark specks.
2. Reading. The inside of each marker is cropped past its ring, turned into dark text on white, enlarged to
   64 px tall, given a white border, and read by Tesseract as one character (--psm 10), or as one word
   (--psm 8) when the ink is wider than tall, restricted to A to Z and 0 to 9. A reading counts at a
   confidence of 60 or more and only if it is one letter or a one- or two-digit number. A coloured glyph
   without a ring must also stand alone (no letter beside it, so not part of a word) and sit at the end of
   a leader line.
3. Clean-up. A ring found twice (its outer and inner edge) or a label read twice is kept once, and a
   figure with a single reading has none: callouts come in sets, and a lone one is usually a stray shape.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import cv2
import numpy as np
import pytesseract

from ..config import settings

if settings.tesseract_cmd:
    pytesseract.pytesseract.tesseract_cmd = settings.tesseract_cmd

_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
_LABEL = re.compile(r"^(?:[A-Z]|\d{1,2})$")
MIN_SIZE, MAX_SIZE = 20, 130          # marker width in px (radius 10 to 65); smaller rings are degree signs and letter holes
MIN_CONF = 60


@dataclass
class Callout:
    label: str
    box: tuple[int, int, int, int]   # x, y, w, h in the figure image
    how: str                         # "marker" (inside a ring or box) or "colour" (a coloured glyph on its own)
    conf: float


def _ocr(crop: np.ndarray, wide: bool) -> tuple[str, float]:
    """One small crop, dark text on white, read as a single character or word."""
    h = crop.shape[0]
    if h == 0 or crop.shape[1] == 0:
        return "", 0.0
    scale = 64 / h
    big = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    _, bw = cv2.threshold(big, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if bw.mean() < 127:                                   # light text on dark: flip
        bw = 255 - bw
    bw = cv2.copyMakeBorder(bw, 14, 14, 14, 14, cv2.BORDER_CONSTANT, value=255)
    best = ("", 0.0)
    for psm in ((8, 10) if wide else (10,)):
        data = pytesseract.image_to_data(bw, config=f"--psm {psm} -c tessedit_char_whitelist={_WHITELIST}",
                                         output_type=pytesseract.Output.DICT)
        for text, conf in zip(data["text"], data["conf"]):
            t, c = (text or "").strip(), float(conf)
            if t and c > best[1]:
                best = (t, c)
    return best


def _ink(mask_crop: np.ndarray) -> float:
    return float((mask_crop > 0).mean()) if mask_crop.size else 0.0


def _glyph_mask(gray: np.ndarray, x: int, y: int, w: int, h: int) -> np.ndarray:
    """Inside a solid marker, the glyph is whatever stands out from the fill: Otsu on just that box."""
    full = np.zeros_like(gray)
    box = gray[y:y + h, x:x + w]
    if box.size:
        _, bw = cv2.threshold(box, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        full[y:y + h, x:x + w] = bw if bw.mean() < 127 else 255 - bw      # the minority colour is the glyph
    return full


def _read_inside(gray: np.ndarray, mask: np.ndarray, x: int, y: int, w: int, h: int) -> tuple[str, float] | None:
    """Read what sits inside a marker, past its ring."""
    m = int(round(0.17 * max(w, h)))
    x0, y0, x1, y1 = x + m, y + m, x + w - m, y + h - m
    if x1 - x0 < 6 or y1 - y0 < 6:
        return None
    inner = mask[y0:y1, x0:x1]
    ink = _ink(inner)
    if not (0.03 <= ink <= 0.55) and not (0.45 <= ink <= 0.97):    # empty, or a solid blob (a filled badge flips below)
        return None
    ys, xs = np.nonzero(inner if ink < 0.5 else 255 - inner)
    if len(xs) == 0:
        return None
    wide = (xs.max() - xs.min() + 1) > 1.1 * (ys.max() - ys.min() + 1)
    return _ocr(gray[y0:y1, x0:x1], wide)


def read_callouts(png: bytes, max_markers: int = 60) -> list[Callout]:
    img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return []
    if max(img.shape[:2]) > 2400:                                   # very large renders: work at about 150 dpi
        f = 2400 / max(img.shape[:2])
        img = cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    colour = (((hsv[..., 1] > 110) & (hsv[..., 2] > 60)) * 255).astype(np.uint8)
    dark = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 12)
    # in a coloured marker the colour mask is the cleaner one; on a plain drawing the dark mask is
    colour_gray = cv2.bitwise_not(colour)
    # A filled badge (a white 2 on a solid disc) touches its arrow, so disc and line are one shape and it is not
    # round. An opening with a disc wider than a line but narrower than the badge erases the line, keeps the disc.
    solid = cv2.bitwise_or(colour, ((gray < 90) * 255).astype(np.uint8))
    solid = cv2.morphologyEx(solid, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    solid = cv2.morphologyEx(solid, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))

    found: list[Callout] = []
    rings: list[tuple[int, int, int, int]] = []
    for mask, src in ((dark, gray), (colour, colour_gray), (solid, gray)):
        cnts, _ = cv2.findContours(mask, cv2.RETR_LIST if mask is not solid else cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cands = []
        for c in cnts:
            x, y, w, h = cv2.boundingRect(c)
            if not (MIN_SIZE <= max(w, h) <= MAX_SIZE) or not (0.75 <= w / max(h, 1) <= 1.33):
                continue
            area, peri = cv2.contourArea(c), cv2.arcLength(c, True)
            if peri == 0 or area < 0.45 * w * h:
                continue
            circ = 4 * np.pi * area / (peri * peri)
            if circ >= 0.70:
                cands.append((circ, x, y, w, h))
        cands.sort(reverse=True)
        for _circ, x, y, w, h in cands[:max_markers]:
            if any(abs(x + w / 2 - (rx + rw / 2)) < 0.3 * rw and abs(y + h / 2 - (ry + rh / 2)) < 0.3 * rh for rx, ry, rw, rh in rings):
                continue                                             # the same ring, seen from its other edge
            read = _read_inside(src, mask if mask is not solid else _glyph_mask(gray, x, y, w, h), x, y, w, h)
            if read and _LABEL.match(read[0]) and read[1] >= MIN_CONF:
                rings.append((x, y, w, h))
                found.append(Callout(read[0], (x, y, w, h), "marker", read[1]))

    # a coloured glyph on its own, not inside a marker: an arrow's red "A". Two tests keep letters out of
    # coloured words ("STEP 1", "2.1 mm"): the glyph stands alone (no glyph-sized neighbour beside it), and a
    # leader line (long, thin, same colour) starts right next to it, as at an arrow's tail.
    n, labels, stats, _ = cv2.connectedComponentsWithStats(colour, connectivity=8)
    comps = [tuple(int(v) for v in stats[i]) for i in range(1, n)]
    lines = [(x, y, w, h) for x, y, w, h, area in comps if max(w, h) >= 40 and area / float(w * h) < 0.35]
    glyphish = [(x, y, w, h) for x, y, w, h, area in comps if 6 <= h <= 80 and max(w, h) < 40 or (12 <= h <= 70 and w <= 1.5 * h)]

    def _near(a, b, gap):
        ax, ay, aw, ah = a; bx, by, bw, bh = b
        dx = max(bx - (ax + aw), ax - (bx + bw), 0); dy = max(by - (ay + ah), ay - (by + bh), 0)
        return dx <= gap and dy <= gap

    def _alone(g):
        x, y, w, h = g
        for o in glyphish:
            if o == g:
                continue
            ox, oy, ow, oh = o
            overlap = min(y + h, oy + oh) - max(y, oy)
            if overlap > 0.3 * min(h, oh) and max(ox - (x + w), x - (ox + ow)) < 0.9 * h:
                return False                                         # a letter beside it: part of a word
        return True

    for x, y, w, h, area in comps:
        if not (14 <= h <= 70) or w < 6 or not (0.2 <= w / h <= 1.5):
            continue
        fill = area / float(w * h)
        if not (0.12 <= fill <= 0.8):
            continue
        if not _alone((x, y, w, h)) or not any(_near((x, y, w, h), ln, 1.2 * h) for ln in lines):
            continue
        if any(rx - 2 <= x and ry - 2 <= y and x + w <= rx + rw + 2 and y + h <= ry + rh + 2 for rx, ry, rw, rh in rings):
            continue                                                 # already read inside its marker
        if any(x <= rx and y <= ry and rx + rw <= x + w and ry + rh <= y + h for rx, ry, rw, rh in rings):
            continue                                                 # it is the ring itself
        pad = 4
        crop = colour_gray[max(0, y - pad): y + h + pad, max(0, x - pad): x + w + pad]
        text, conf = _ocr(crop, w > 1.1 * h)
        if _LABEL.match(text) and conf >= MIN_CONF:
            found.append(Callout(text, (int(x), int(y), int(w), int(h)), "colour", conf))

    best: dict[str, Callout] = {}
    for c in found:
        if c.label not in best or c.conf > best[c.label].conf:
            best[c.label] = c
    # Callouts come in sets. A single reading is far more often a stray shape than a label, and a key can
    # only be matched on two or more labels anyway, so one alone counts as none.
    if len(best) < 2:
        return []
    return sorted(best.values(), key=lambda c: (c.box[1], c.box[0]))


# ---------------------------------------------------------------------------
# loose numbers on a drawing
# ---------------------------------------------------------------------------
# A patent's or an old manual's drawing names its parts with hand-lettered numbers at the end of leader lines
# ("12" pointing at the rotor), with no circle around them. Tesseract is trained on print and reads few of them.
# A handwritten-digit classifier does better: the MNIST model from the ONNX model zoo (models/mnist-8.onnx, 26 KB,
# MIT licence), run through onnxruntime, which the local embedding model already brings. No API, no generated text.
# Long straight strokes are erased first, the digit-sized pieces left are grouped into numbers left to right, and
# each digit is classified. What is read here is only a candidate: legend.py keeps a number only if the
# document's own text names a part with it ("the rotor 12").

_MNIST = None


def _digit(glyph: np.ndarray) -> tuple[int, float]:
    global _MNIST
    if _MNIST is None:
        import onnxruntime as ort
        from pathlib import Path
        _MNIST = ort.InferenceSession(str(Path(__file__).with_name("models") / "mnist-8.onnx"))
    h, w = glyph.shape
    s = 20 / max(h, w)
    g = cv2.resize(glyph, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA).astype(np.float32)
    canvas = np.zeros((28, 28), np.float32)                  # the MNIST layout: white digit, 20 px box, centred by mass
    y0, x0 = (28 - g.shape[0]) // 2, (28 - g.shape[1]) // 2
    canvas[y0:y0 + g.shape[0], x0:x0 + g.shape[1]] = g
    m = cv2.moments(canvas)
    if m["m00"]:
        canvas = cv2.warpAffine(canvas, np.float32([[1, 0, 14 - m["m10"] / m["m00"]], [0, 1, 14 - m["m01"] / m["m00"]]]), (28, 28))
    out = _MNIST.run(None, {"Input3": canvas[None, None]})[0][0]
    p = np.exp(out - out.max())
    p /= p.sum()
    return int(p.argmax()), float(p.max())


def read_numerals(png: bytes, dpi: int = 150, min_conf: float = 0.9) -> list[str]:
    """Candidate part numbers (two or three digits) lettered loose on a drawing."""
    img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return []
    k = dpi / 150                                            # sizes below are for 150 dpi
    bw = ((img < 150) * 255).astype(np.uint8)
    long_ = int(35 * k)
    strokes = cv2.morphologyEx(bw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (long_, 1))) | \
        cv2.morphologyEx(bw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, long_)))
    rest = cv2.subtract(bw, strokes)
    n, lab, st, _ = cv2.connectedComponentsWithStats(rest, 8)
    glyphs = sorted((i, *map(int, st[i][:4])) for i in range(1, n)
                    if 11 * k <= st[i][3] <= 40 * k and 2 * k <= st[i][2] <= 30 * k and st[i][4] >= 15 * k * k)
    glyphs.sort(key=lambda b: b[1])
    used: set[int] = set()
    found: list[str] = []
    for a in glyphs:
        if a[0] in used:
            continue
        group = [a]
        used.add(a[0])
        for b in glyphs:                                     # the next digit: just to the right, on the same line
            last = group[-1]
            if b[0] in used or b[1] <= last[1]:
                continue
            if b[1] - (last[1] + last[3]) < 0.5 * last[4] and \
                    min(last[2] + last[4], b[2] + b[4]) - max(last[2], b[2]) > 0.5 * min(last[4], b[4]):
                group.append(b)
                used.add(b[0])
        if not 2 <= len(group) <= 3:
            continue
        digits, conf = "", 1.0
        for i, x, y, w, h in group:
            d, c = _digit(((lab[y:y + h, x:x + w] == i) * 255).astype(np.uint8))
            digits += str(d)
            conf = min(conf, c)
        if conf >= min_conf and digits[0] != "0":
            found.append(digits)
    return sorted(set(found), key=int)
