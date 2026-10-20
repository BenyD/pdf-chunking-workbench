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
from collections import Counter
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
    # and the other way: each row of the key says which figure it labels; both ends get a "key" link
    by_id = {c.id: c for c in chunks}
    for cid in key.chunk_ids:
        row = by_id.get(cid)
        if not row:
            continue
        row.metadata["labels_figure"] = {"page": figure.page_start, "caption": figure.metadata.get("caption")}
        target = by_id.get(row.parent_id) if row.parent_id else row      # link the figure to the key's table, once
        for a, b, d in ((figure, target, "out"), (target, figure, "in")):
            links = a.metadata.setdefault("links", [])
            if b and not any(l["id"] == b.id for l in links):
                links.append({"id": b.id, "kind": "key", "label": f"Key: {key.title}" if d == "out" else "Figure it labels",
                              "dir": d, "page": b.page_start, "type": b.chunk_type})
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


_ID = re.compile(r"\b([A-Z]{1,4}\d{1,3}(?:\s?-\s?[A-Z0-9]{1,2})?)\b")


def _norm_id(t: str) -> str:
    return re.sub(r"\s+", "", t).upper()


def bind_codes(chunks: list[ChunkDraft]) -> int:
    """A photo labelled with location codes ("Inside Retarding Chamber (FC3, FD3, FM2)") and a table whose ID
    column lists those codes, with what each location is and why it is sampled: the photo's passage gets
    "FC3 = Inside the retarding chamber (For Active Pharmaceutical Ingredient)" for each code it carries, and key
    links to those rows, both ways. A code counts only when a table cell holds that code and nothing else.
    Returns how many figures were bound."""
    rows: dict[str, ChunkDraft] = {}
    for c in chunks:
        if c.chunk_type != "table_row":
            continue
        cells = c.metadata.get("resolved_cells") or c.metadata.get("cells") or []
        for cell in cells:
            if cell and _ID.fullmatch(cell.strip()):
                rows.setdefault(_norm_id(cell), c)
    if not rows:
        return 0
    made = 0
    for f in chunks:
        if f.chunk_type != "figure":
            continue
        codes = list(dict.fromkeys(_norm_id(m.group(1)) for l in f.metadata.get("labels") or [] for m in _ID.finditer(l)))
        hits = [(k, rows[k]) for k in codes if k in rows]
        if not hits:
            continue
        lines = []
        for k, r in hits:
            cells = [x for x in (r.metadata.get("resolved_cells") or r.metadata.get("cells") or []) if x and x.strip()]
            name = next((x.strip() for x in cells if _norm_id(x) != k), "")
            group = r.metadata.get("group")
            lines.append(f"{k} = {name}" + (f" ({group})" if group else ""))
        pages = sorted({r.page_start for _, r in hits})
        f.raw_text += f"\nLocations, from the table on page {', '.join(map(str, pages))}: " + "; ".join(lines)
        f.metadata["codes"] = [k for k, _ in hits]
        links = f.metadata.setdefault("links", [])
        for k, r in hits[:12]:
            if not any(l.get("id") == r.id for l in links):
                links.append({"id": r.id, "kind": "key", "label": k, "dir": "out", "page": r.page_start, "type": r.chunk_type})
            rl = r.metadata.setdefault("links", [])
            if not any(l.get("id") == f.id for l in rl):
                rl.append({"id": f.id, "kind": "key", "label": f"photo on page {f.page_start}", "dir": "in", "page": f.page_start, "type": "figure"})
        made += 1
    return made


_PART = re.compile(r"\b((?:[a-z][a-z\-]*\s+){0,2}[a-z][a-z\-]{2,})\s+(\d{2,3})\b")
_NOT_PART = {"claim", "claims", "page", "pages", "section", "figure", "fig", "line", "lines", "column", "step", "table",
             "note", "item", "about", "than", "least", "most", "only", "and", "or", "of", "to", "from", "between"}
_LEAD = {"the", "a", "an", "said", "this", "that", "each", "both", "its", "their", "which", "with", "by", "and", "of",
         "to", "in", "on", "for", "at", "is", "are", "be", "as", "into", "onto", "via", "from", "or", "nor"}


def part_names(chunks: list[ChunkDraft]) -> dict[str, str]:
    """What the text calls each reference number: "the upper pressure roller 28" gives 28 = upper pressure roller.
    The most frequent wording wins."""
    seen: dict[str, Counter] = {}
    for c in chunks:
        if c.chunk_type == "figure":
            continue
        for m in _PART.finditer(c.raw_text):
            words = m.group(1).split()
            for i in range(len(words) - 1, -1, -1):          # "exhibits a rotor 12": the name starts after an article
                if words[i] in ("a", "an", "the", "said"):
                    words = words[i + 1:]
                    break
            while words and words[0] in _LEAD:
                words = words[1:]
            if not words or words[-1] in _NOT_PART or words[-1] in _LEAD:
                continue
            seen.setdefault(m.group(2), Counter())[" ".join(words)] += 1
    return {n: names.most_common(1)[0][0] for n, names in seen.items()}


def name_drawings(chunks: list[ChunkDraft]) -> int:
    """Drawing-sheet figures (parse/figures.py): their loose numbers are read (parse/callouts.read_numerals), and
    each one the text names becomes "12 rotor" on the figure; a number the text never uses is a misreading and is
    dropped. Drawings with no printed caption are numbered from the text's own list ("FIG. 1", "FIG. 2", ...) when
    the counts agree. Returns how many figures were named."""
    drawings = [c for c in chunks if c.chunk_type == "figure" and c.metadata.get("drawing")]
    if not drawings:
        return 0
    text = "\n".join(c.raw_text for c in chunks if c.chunk_type != "figure")
    figs = sorted({m for m in re.findall(r"\bFIG(?:URE)?S?\.?\s*(\d{1,2})\b", text)}, key=int)
    unnumbered = [c for c in drawings if not c.metadata.get("figure_number")]
    if figs and len(figs) == len(unnumbered):
        for c, n in zip(unnumbered, figs):
            c.metadata["figure_number"] = n
            c.raw_text = c.raw_text.replace(f"Figure on page {c.page_start}.", f"FIG. {n}, page {c.page_start}.", 1)
    names = part_names(chunks)
    from ..parse.callouts import read_numerals
    made = 0
    for c in drawings:
        if not c.image_png:
            continue
        nums = [n for n in read_numerals(c.image_png) if n in names]
        if len(nums) < 3:
            continue
        c.metadata["image_labels"] = nums
        c.metadata["parts"] = {n: names[n] for n in nums}
        c.raw_text += "\nNumbered parts: " + "; ".join(f"{n} {names[n]}" for n in nums)
        made += 1
    return made


def key_links_from_metadata(chunks: list[ChunkDraft]) -> None:
    """Rebuild the figure-to-key links for passages stored before those links existed, from metadata["key"]."""
    by_id = {c.id: c for c in chunks}
    for fig in chunks:
        key = fig.metadata.get("key") if fig.chunk_type == "figure" else None
        if not key:
            continue
        for cid in key.get("chunk_ids", []):
            row = by_id.get(cid)
            target = (by_id.get(row.parent_id) if row and row.parent_id else row)
            if not target:
                continue
            for a, b, d in ((fig, target, "out"), (target, fig, "in")):
                links = a.metadata.setdefault("links", [])
                if not any(l["id"] == b.id for l in links):
                    links.append({"id": b.id, "kind": "key", "label": f"Key: {key.get('title', 'a table')}" if d == "out" else "Figure it labels",
                                  "dir": d, "page": b.page_start, "type": b.chunk_type})
