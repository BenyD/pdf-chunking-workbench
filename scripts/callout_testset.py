#!/usr/bin/env python3
"""Figures with known callout labels drawn INTO the image, in the styles manuals and inspection reports use,
plus figures with no labels at all. scripts/test_callouts.py reads them and scores the callout reader.

    cd worker && .venv/bin/python ../scripts/callout_testset.py      # writes scripts/benchmarks/callouts/*.png + expected.json

Seeded, so the set is the same every time. Sizes match what the parser hands over: a figure region rendered
at 150 dpi, roughly 900 to 1,000 pixels wide.
"""
from __future__ import annotations

import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent / "benchmarks" / "callouts"
FONTS = {
    "arial": "/System/Library/Fonts/Supplemental/Arial.ttf",
    "helvetica": "/System/Library/Fonts/Helvetica.ttc",
    "times": "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
}
RED, BLACK, WHITE, BLUE = (200, 20, 20), (20, 20, 20), (255, 255, 255), (30, 70, 170)


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(FONTS[name], size)
    except OSError:
        return ImageFont.load_default(size=size)


def photo(w: int = 960, h: int = 620, seed: int = 1, shade: int = 200) -> Image.Image:
    """A bench-photo-like background with texture and a few soft shapes."""
    r = random.Random(seed)
    im = Image.new("RGB", (w, h), (shade, shade + 2, shade - 3))
    px = im.load()
    for _ in range(w * h // 12):
        x, y = r.randrange(w), r.randrange(h)
        g = r.randrange(shade - 25, shade + 20)
        px[x, y] = (g, g + 2, g - 2)
    d = ImageDraw.Draw(im)
    for _ in range(4):
        x, y = r.randrange(80, w - 300), r.randrange(80, h - 250)
        d.rounded_rectangle([x, y, x + r.randrange(150, 280), y + r.randrange(90, 200)], 20,
                            fill=(150, 154, 158), outline=(80, 82, 85), width=4)
    return im.filter(ImageFilter.GaussianBlur(1.0))


def drawing(w: int = 960, h: int = 620, holes: bool = True) -> Image.Image:
    """A white line drawing of a part: plates, a shaft, bolt holes."""
    im = Image.new("RGB", (w, h), WHITE)
    d = ImageDraw.Draw(im)
    d.rectangle([200, 200, 760, 300], outline=BLACK, width=4)
    d.rectangle([300, 300, 660, 470], outline=BLACK, width=4)
    d.line([480, 120, 480, 200], fill=BLACK, width=6)
    d.ellipse([400, 80, 560, 140], outline=BLACK, width=4)
    if holes:
        for x in range(330, 640, 60):
            d.ellipse([x - 9, 380, x + 9, 398], outline=BLACK, width=3)
    return im


def text_center(d: ImageDraw.ImageDraw, xy: tuple[int, int], s: str, f, fill) -> None:
    l, t, r_, b = d.textbbox((0, 0), s, font=f)
    d.text((xy[0] - (r_ - l) / 2 - l, xy[1] - (b - t) / 2 - t), s, font=f, fill=fill)


def leader(d, start, end, color, width=4, head=True) -> None:
    d.line([start, end], fill=color, width=width)
    if head:
        a = math.atan2(end[1] - start[1], end[0] - start[0])
        L, W = 16, 8
        p1 = (end[0] - L * math.cos(a) + W * math.sin(a), end[1] - L * math.sin(a) - W * math.cos(a))
        p2 = (end[0] - L * math.cos(a) - W * math.sin(a), end[1] - L * math.sin(a) + W * math.cos(a))
        d.polygon([end, p1, p2], fill=color)


def circled(d, c, s, f, r=24, ring=RED, text=RED, fill=WHITE, width=4) -> None:
    d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=fill, outline=ring, width=width)
    text_center(d, c, s, f, text)


# Each case: (name, builder) -> builder returns (image, labels)
def case_red_circled_digits():
    im = photo(seed=3); d = ImageDraw.Draw(im); f = font("arial", 32)
    spots = [((90, 90), (260, 200)), ((870, 80), (700, 190)), ((470, 560), (520, 430)), ((90, 520), (240, 420))]
    for i, (c, t) in enumerate(spots, 1):
        leader(d, c, t, RED); circled(d, c, str(i), f)
    return im, ["1", "2", "3", "4"]


def case_black_balloons_letters():
    im = drawing(); d = ImageDraw.Draw(im); f = font("helvetica", 30)
    spots = [("A", (110, 150), (205, 220)), ("B", (850, 160), (755, 240)), ("C", (120, 520), (305, 430)),
             ("D", (850, 520), (655, 420)), ("E", (680, 70), (555, 105))]
    for s, c, t in spots:
        leader(d, c, t, BLACK, width=3); circled(d, c, s, f, r=26, ring=BLACK, text=BLACK, width=3)
    return im, [s for s, _, _ in spots]


def case_boxed_letters():
    im = drawing(holes=False); d = ImageDraw.Draw(im); f = font("arial", 28)
    spots = [("P", (100, 140), (205, 230)), ("Q", (860, 150), (755, 250)), ("R", (110, 540), (305, 440))]
    for s, (x, y), t in spots:
        leader(d, (x, y), t, BLACK, width=3)
        d.rectangle([x - 22, y - 22, x + 22, y + 22], fill=WHITE, outline=BLACK, width=3)
        text_center(d, (x, y), s, f, BLACK)
    return im, [s for s, _, _ in spots]


def case_two_digit():
    im = drawing(); d = ImageDraw.Draw(im); f = font("arial", 26)
    spots = [("10", (100, 150), (205, 230)), ("11", (860, 150), (755, 250)), ("12", (110, 540), (305, 440)), ("13", (860, 540), (655, 440))]
    for s, c, t in spots:
        leader(d, c, t, BLACK, width=3); circled(d, c, s, f, r=28, ring=BLACK, text=BLACK, width=3)
    return im, [s for s, _, _ in spots]


def case_small_markers():
    im = photo(seed=5, shade=215); d = ImageDraw.Draw(im); f = font("arial", 15)
    spots = [((70, 70), (200, 160)), ((890, 70), (740, 170)), ((480, 580), (520, 450))]
    for i, (c, t) in enumerate(spots, 1):
        leader(d, c, t, RED, width=2, head=False); circled(d, c, str(i), f, r=12, width=2)
    return im, ["1", "2", "3"]


def case_red_plain_letters():
    im = photo(seed=7); d = ImageDraw.Draw(im); f = font("arial", 36)
    spots = [("A", (70, 80), (230, 190)), ("B", (880, 90), (720, 200)), ("C", (450, 575), (500, 430))]
    for s, c, t in spots:
        text_center(d, c, s, f, RED); leader(d, (c[0] + (20 if c[0] < 480 else -20), c[1] + 12), t, RED, width=3)
    return im, [s for s, _, _ in spots]


def case_filled_badges():
    im = photo(seed=9, shade=185); d = ImageDraw.Draw(im); f = font("helvetica", 28)
    spots = [((90, 90), (250, 210)), ((870, 90), (710, 210)), ((480, 560), (500, 420))]
    for i, (c, t) in enumerate(spots, 1):
        leader(d, c, t, BLUE); circled(d, c, str(i), f, r=24, ring=BLUE, text=WHITE, fill=BLUE)
    return im, ["1", "2", "3"]


def case_times_letters():
    im = drawing(); d = ImageDraw.Draw(im); f = font("times", 32)
    spots = [("F", (110, 150), (205, 230)), ("G", (850, 160), (755, 240)), ("H", (120, 520), (305, 430))]
    for s, c, t in spots:
        leader(d, c, t, BLACK, width=3); circled(d, c, s, f, r=26, ring=BLACK, text=BLACK, width=3)
    return im, [s for s, _, _ in spots]


def case_negative_photo():
    im = photo(seed=11); d = ImageDraw.Draw(im)
    d.ellipse([300, 150, 700, 450], fill=(176, 180, 186), outline=(90, 92, 96), width=6)   # a bowl
    for x in range(330, 680, 70):
        d.ellipse([x - 14, 280, x + 14, 308], fill=(120, 122, 126))                        # rivets
    return im.filter(ImageFilter.GaussianBlur(0.6)), []


def case_negative_drawing():
    return drawing(), []


CASES = [case_red_circled_digits, case_black_balloons_letters, case_boxed_letters, case_two_digit, case_small_markers,
         case_red_plain_letters, case_filled_badges, case_times_letters, case_negative_photo, case_negative_drawing]


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    expected = {}
    for fn in CASES:
        name = fn.__name__.removeprefix("case_")
        im, labels = fn()
        im.save(OUT / f"{name}.png")
        expected[name] = labels
    (OUT / "expected.json").write_text(json.dumps(expected, indent=2) + "\n")
    print(f"wrote {len(expected)} figures to {OUT}")
