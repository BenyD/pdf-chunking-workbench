"""Layout data model shared by the parser and the chunkers.

Coordinates are PDF points with origin top-left (PyMuPDF convention).
"""
from __future__ import annotations

from dataclasses import dataclass, field

BBox = tuple[float, float, float, float]


@dataclass
class Line:
    text: str
    bbox: BBox
    size: float
    bold: bool


@dataclass
class TextBlock:
    page: int
    bbox: BBox
    lines: list[Line]
    heading_level: int = 0        # 0 = body text
    heading_only: bool = False    # True when the block is just a title (e.g. "CHAPTER VI")
    heading_title: str = ""       # what goes in the breadcrumb
    kind: str = "text"

    @property
    def text(self) -> str:
        return " ".join(l.text for l in self.lines).strip()


@dataclass
class TableBlock:
    page: int
    bbox: BBox
    header: list[str]
    rows: list[list[str]]
    caption: str | None = None
    # A table that runs across pages keeps one bbox per page it touches.
    bboxes: list[tuple[int, BBox]] = field(default_factory=list)
    kind: str = "table"

    @property
    def page_end(self) -> int:
        return self.bboxes[-1][0] if self.bboxes else self.page


@dataclass
class FigureBlock:
    page: int
    bbox: BBox
    image_png: bytes
    caption: str | None = None
    labels: list[str] = field(default_factory=list)   # text found inside the figure region
    figure_number: str | None = None
    image_path: str | None = None
    kind: str = "figure"
    drawing: bool = False           # cut from a drawing sheet (one page-sized image): its numbers are read from the ink


Block = TextBlock | TableBlock | FigureBlock


@dataclass
class PageLayout:
    number: int                 # 1-based
    width: float
    height: float
    blocks: list[Block]
    lines: list[Line]           # every text line in reading order, for the naive chunker's bbox mapping
    is_scanned: bool = False
    ocr_applied: bool = False


def frac(bbox: BBox, width: float, height: float) -> dict:
    """Store boxes as fractions so the UI can draw them on any render size."""
    x0, y0, x1, y1 = bbox
    return {
        "x0": round(max(0.0, x0 / width), 5),
        "y0": round(max(0.0, y0 / height), 5),
        "x1": round(min(1.0, x1 / width), 5),
        "y1": round(min(1.0, y1 / height), 5),
    }


def union(boxes: list[BBox]) -> BBox:
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )
