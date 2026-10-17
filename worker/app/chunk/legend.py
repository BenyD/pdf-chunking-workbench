"""Bind a figure's bare callout labels (A, B, C or 1, 2, 3) to the key that explains them, wherever it is.

Manuals and inspection drawings often mark a part with a lone letter or number and explain the
letters somewhere else: a table on another page ("Table 6. Key to Figure 4"), or a list under the
figure ("A - upper punch guide; B - die table"). The figure on its own then says nothing a search
can match, and the table on its own does not say where the part is.

The key is found by what it shares with the figure, not by where it sits:

1. The labels. A table whose first or second column holds the same letters or numbers as the
   figure is a candidate; so is a run of "A - text" or "A: text" items in the text. At least two
   labels must match, and most of the figure's labels must be covered.
2. The name. A key whose caption or nearby text names the figure ("Key to Figure 4") wins over
   one that merely shares letters.
3. The distance. Between equal candidates the one closest to the figure wins.

Once found, the key is written into the figure's passage ("Key, from Table 6 on page 3: A = upper
punch guide ..."), so a question naming the part finds the figure, and the figure's description
can say what each arrow points at. The labels come from three places, tried in order: the text
printed on the figure, the labels drawn into its image and read with OCR (parse/callouts.py), both
without a model, and, only when generative AI is on, what the vision model reads from the picture.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .model import ChunkDraft

_LABEL = re.compile(r"^\(?([A-Z]|\d{1,2})\)?[.:]?$|^\(([a-z])\)$")   # A, (B), 3, 12, (c); never a bare "a"
_REFERRER = {"fig", "fig.", "figure", "table", "page", "section", "step", "no", "no."}
# "A - text", "A: text", "A = text", "(A) text" inside running text; not "1." (numbered paragraphs)
_LIST_ITEM = re.compile(r"(?:^|[\s;,])\(?([A-Z]|\d{1,2})\)?\s*(?:[-–—=:]|\))\s+([^;\n]{2,120}?)(?=\s*(?:;|\n|$|\s\(?(?:[A-Z]|\d{1,2})\)?\s*(?:[-–—=:]|\))\s))")
_FIG_NO = re.compile(r"\b(?:fig(?:ure)?\.?|diagram|drawing|image|photo|plate|exhibit)\s*([A-Za-z]?\d+(?:\.\d+)?[A-Za-z]?)", re.I)


def callouts(texts: list[str]) -> list[str]:
    """The short labels among the text found on a figure, in order, without repeats."""
    out: list[str] = []
    for t in texts:
        toks = re.split(r"[\s,;]+", t or "")
        for i, tok in enumerate(toks):
            m = _LABEL.match(tok.strip())
            if not m or (i and toks[i - 1].lower() in _REFERRER):     # the 4 in "Figure 4" is not a label
                continue
            lab = (m.group(1) or m.group(2)).upper()
            if lab not in out:
                out.append(lab)
    return out


@dataclass
class Key:
    source: str                          # "table" or "list"
    page: int
    title: str                           # the table caption, or "the text"
    entries: dict[str, str] = field(default_factory=dict)
    names_figure: bool = False
    chunk_ids: list[str] = field(default_factory=list)

    def text(self) -> str:
        where = f"{self.title} on page {self.page}" if self.source == "table" else f"the text on page {self.page}"
        items = "; ".join(f"{k} = {v}" for k, v in self.entries.items())
        return f"Key, from {where}: {items}."


def _candidates(chunks: list[ChunkDraft]) -> list[Key]:
    keys: list[Key] = []
    # tables: rows grouped by the table they belong to (a split table shares its caption and header)
    tables: dict[tuple, list[ChunkDraft]] = {}
    for c in chunks:
        if c.chunk_type == "table_row":
            tables.setdefault((c.metadata.get("caption"), tuple(c.metadata.get("header") or [])), []).append(c)
    for (caption, header), rows in tables.items():
        for col in (0, 1):
            entries: dict[str, str] = {}
            ids: list[str] = []
            for r in rows:
                cells = r.metadata.get("resolved_cells") or r.metadata.get("cells") or []
                if col >= len(cells):
                    continue
                m = _LABEL.match((cells[col] or "").strip())
                if not m:
                    continue
                lab = (m.group(1) or m.group(2)).upper()
                rest = [f"{h}: {v}" if i > col + 1 and h and not h.startswith("col") else v
                        for i, (h, v) in enumerate(zip(header, cells)) if i != col and v]
                entries[lab] = ", ".join(rest)
                ids.append(r.id)
            if len(entries) >= 2:
                keys.append(Key("table", rows[0].page_start, caption or "a table", entries, False, ids))
                break
    # lists in running text
    for c in chunks:
        if c.chunk_type != "text":
            continue
        items = {m.group(1).upper(): m.group(2).strip(" .") for m in _LIST_ITEM.finditer(c.raw_text)}
        if len(items) >= 2:
            keys.append(Key("list", c.page_start, "the text", items, False, [c.id]))
    return keys


def _names(key: Key, chunks_by_id: dict[str, ChunkDraft], figure_number: str | None) -> bool:
    if not figure_number:
        return False
    texts = [key.title] + [chunks_by_id[i].context or "" for i in key.chunk_ids[:1] if i in chunks_by_id]
    return any(m.group(1).lower() == figure_number.lower() for t in texts for m in _FIG_NO.finditer(t or ""))


def find_key(labels: list[str], page: int, figure_number: str | None, chunks: list[ChunkDraft]) -> Key | None:
    """The best key for these labels in this document, or None."""
    if len(labels) < 2:
        return None
    want = set(labels)
    by_id = {c.id: c for c in chunks}
    best, best_score = None, 0.0
    for k in _candidates(chunks):
        shared = want & set(k.entries)
        cover = len(shared) / len(want)
        if len(shared) < 2 or cover < 0.6:
            continue
        k.names_figure = _names(k, by_id, figure_number)
        # Letters are distinctive; bare numbers are everywhere (row numbers, axis ticks). Without the key
        # naming the figure, numbers need the key on the same page, letters within three pages.
        numeric = all(x.isdigit() for x in shared)
        near = k.page == page if numeric else abs(k.page - page) <= 3
        if not k.names_figure and not (near and cover >= 0.8):
            continue
        score = cover + (2.0 if k.names_figure else 0.0) - min(abs(k.page - page), 20) * 0.02
        if score > best_score:
            best, best_score = k, score
    if best:
        best.entries = {lab: best.entries[lab] for lab in labels if lab in best.entries} | \
                       {lab: v for lab, v in best.entries.items() if lab not in labels}
    return best


def bind(figure: ChunkDraft, labels: list[str], chunks: list[ChunkDraft]) -> Key | None:
    """Find the key for a figure's labels and write it into the figure's passage. Returns what was bound."""
    if figure.metadata.get("key"):
        return None
    key = find_key(labels, figure.page_start, figure.metadata.get("figure_number"), chunks)
    if not key:
        return None
    figure.raw_text = figure.raw_text.rstrip() + "\n" + key.text()
    figure.metadata["key"] = {"source": key.source, "page": key.page, "title": key.title, "entries": key.entries,
                              "names_figure": key.names_figure, "chunk_ids": key.chunk_ids}
    # and the other way: each row of the key says which figure it labels
    for cid in key.chunk_ids:
        for c in chunks:
            if c.id == cid:
                c.metadata["labels_figure"] = {"page": figure.page_start, "caption": figure.metadata.get("caption")}
    return key


def bind_all(chunks: list[ChunkDraft]) -> int:
    """Deterministic pass, no model. A figure's labels printed as PDF text are tried first; when they find no
    key, the labels drawn into the figure's image (a circled 2, a boxed B) are read with OCR
    (parse/callouts.py) and tried the same way. Returns how many figures were bound."""
    n = 0
    for c in chunks:
        if c.chunk_type != "figure":
            continue
        if bind(c, callouts(c.metadata.get("labels") or []), chunks):
            n += 1
            continue
        if not c.image_png:
            continue
        from ..parse.callouts import read_callouts
        read = sorted((r.label for r in read_callouts(c.image_png)), key=lambda x: (not x.isdigit(), int(x) if x.isdigit() else 0, x))
        if not read:
            continue
        c.metadata["image_labels"] = read
        if bind(c, read, chunks):
            c.metadata["key"]["labels_from"] = "image"
            n += 1
    return n
