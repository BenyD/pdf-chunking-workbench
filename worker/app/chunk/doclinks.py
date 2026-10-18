"""Links between documents: a passage that cites another document in the library.

The BNSS cites the BNS 114 times ("an offence under section 230 of the Bharatiya Nyaya Sanhita, 2023"), and
SOPs point at each other ("records are kept as per SOP-QA-040"). The answer to a question asked of the first
document is then in the second. As within a document (references.py), these links are found by rules, no model.

A document is named in two ways: its code (SOP-QA-040 from its file name, or ORA-LAB.5.5.1 from a "Document
Number:" line on its first page) and, for a long title, the title
itself (Bharatiya Nyaya Sanhita, the year dropped). A copy or revision of the same SOP shares its code: it is
never linked to its own copies, and a citation goes to the newest of them only.

  section  "section 230 of the Bharatiya Nyaya Sanhita", "sections 68 and 69 of ...": a link to each section's
           first passage in that document, stored on both ends (out on the citing passage, in on the cited one)
  document "as per SOP-QA-040", "any offence under the Bharatiya Nyaya Sanhita": no place to point at, so the
           link names the document and search looks inside it with the question (web search route)

Each link is {"kind": "doc", "doc_id": the other document, "id": the passage or None, "label", "dir", "page",
"type"} in metadata["links"]. They are rebuilt for every pair of documents passed in together, and links to
documents outside that set are left alone, so one new upload only touches the documents it cites or is cited by.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .model import ChunkDraft
from .references import anchor_targets

MAX_OUT = 6          # links to other documents per passage
MAX_IN = 4           # passages of other documents citing one passage

_CODE = re.compile(r"\b[A-Z]{2,4}-[A-Z]{2,4}-\d{2,4}\b")                      # SOP-QA-040
# "Document Number: ORA-LAB.5.5.1", "SOP No.: QC/SOP/014", "Doc ID: WI-PR-021" on a document's first page
_CODE_LINE = re.compile(r"\b(?:Document|Doc\.?|SOP|Procedure)\s*(?:No\.?|Number|#|ID)\s*[:.]?\s*([A-Z][A-Z0-9]*(?:[-./][A-Z0-9]+)+)")


def code_in(text: str) -> str | None:
    """A code a document gives itself ("Document Number: ORA-LAB.5.5.1"). Read from the first page's every line
    at upload, header box included, since the box is dropped as boilerplate before passages are cut."""
    m = _CODE_LINE.search(text)
    return m.group(1).rstrip(".") if m else None


def doc_code(chunks: list[ChunkDraft]) -> str | None:
    return next((c for c in (code_in(x.raw_text) for x in chunks[:4]) if c), None)
_NUM = r"\d{1,3}[A-Z]?(?:\s*\(\d{1,3}\))*"
# the sections named right before "of the <document>": "section 230", "sections 64, 66 and 68",
# "section 63, section 64 or section 71", "sub-section (1) of section 351"
_CHAIN = re.compile(rf"(?:sub-section\s*\(\d+\)\s*of\s+)?\bsections?\s+{_NUM}(?:\s*(?:,|\bor\b|\band\b)\s*(?:sections?\s+)?{_NUM})*\s*,?\s+of\s+(?:the\s+)?$", re.I)


@dataclass
class Doc:
    id: str
    name: str
    chunks: list[ChunkDraft]
    created: str = ""                                       # ISO time; the newest copy of an SOP is the one cited
    stored_code: str | None = None                          # the code found at upload, for a document read by name only

    @property
    def code(self) -> str | None:
        m = _CODE.search(self.name)
        return m.group(0) if m else self.stored_code or doc_code(self.chunks)

    @property
    def title(self) -> str | None:
        """A long title by which other documents cite this one: three words or more, the year and notes dropped."""
        stem = self.name.rsplit(".", 1)[0]
        stem = re.sub(r"\(.*?\)|,.*$", "", stem)
        stem = re.sub(r"\b(19|20)\d{2}\b", "", stem).strip(" -_")
        words = re.findall(r"[A-Za-z]{2,}", stem)
        return stem if not self.code and len(words) >= 3 and len(stem) >= 15 else None

    @property
    def label(self) -> str:
        return self.code or self.title or self.name.rsplit(".", 1)[0]

    def mention(self) -> re.Pattern | None:
        if self.code:          # not a prefix of a longer code: ORA-LAB.5.5 is not cited by "ORA-LAB.5.5.1"
            return re.compile(rf"\b{re.escape(self.code)}(?![.\-/]?\w)")
        if self.title:
            return re.compile(r"\b" + r"\s+".join(map(re.escape, self.title.split())) + r"\b")     # case as printed
        return None


def same_document(a: Doc, b: Doc) -> bool:
    """The same document, or a copy or revision of it."""
    return a.id == b.id or (a.code is not None and a.code == b.code) or (a.title is not None and a.title == b.title)


def _strip(c: ChunkDraft, others: set[str]) -> None:
    c.metadata["links"] = [l for l in c.metadata.get("links", []) if not (l.get("kind") == "doc" and l.get("doc_id") in others)]


def _add(c: ChunkDraft, link: dict, cap: int) -> bool:
    links = c.metadata.setdefault("links", [])
    mine = [l for l in links if l.get("kind") == "doc" and l.get("dir") == link["dir"]]
    if len(mine) >= cap or any(l.get("doc_id") == link["doc_id"] and l.get("id") == link["id"] and l.get("label") == link["label"] for l in links):
        return False
    links.append(link)
    return True


def link_library(docs: list[Doc]) -> int:
    """Rebuild the links between every pair of the given documents. Returns how many were made."""
    ids = {d.id for d in docs}
    for d in docs:
        for c in d.chunks:
            _strip(c, ids - {d.id})
    targets = {d.id: anchor_targets(d.chunks) for d in docs}
    made = 0
    for b in docs:                                          # b: the document cited
        pat = b.mention()
        if not pat or any(same_document(o, b) and o.id != b.id and o.created > b.created for o in docs):
            continue
        for a in docs:                                      # a: the document citing it
            if same_document(a, b):
                continue
            for c in a.chunks:
                if c.chunk_type == "table_row":             # a row repeats its table's words
                    continue
                for m in pat.finditer(c.raw_text):
                    chain = _CHAIN.search(c.raw_text[max(0, m.start() - 240): m.start()])
                    nums = re.findall(r"\b\d{1,3}[A-Z]?\b", re.sub(r"\(\d+\)", "", chain.group(0))) if chain else []
                    hit = False
                    for n in dict.fromkeys(nums):
                        t = targets[b.id].get(("section", n))
                        if not t:
                            continue
                        label = f"{b.label}, section {n}"
                        if _add(c, {"kind": "doc", "doc_id": b.id, "id": t.id, "label": label, "dir": "out",
                                    "page": t.page_start, "type": t.chunk_type}, MAX_OUT):
                            made += 1
                            _add(t, {"kind": "doc", "doc_id": a.id, "id": c.id, "label": a.label, "dir": "in",
                                     "page": c.page_start, "type": c.chunk_type}, MAX_IN)
                        hit = True
                    if not hit and _add(c, {"kind": "doc", "doc_id": b.id, "id": None, "label": b.label, "dir": "out",
                                            "page": None, "type": None}, MAX_OUT):
                        made += 1
    return made


def key(d: Doc) -> str | None:
    """The plain text a citation of this document contains: its code, or its title."""
    return d.code or d.title


def mentions(docs: list[Doc], chunks: list[ChunkDraft]) -> set[str]:
    """Which of the documents these passages cite."""
    text = "\n".join(c.raw_text for c in chunks)
    return {d.id for d in docs if (p := d.mention()) and p.search(text)}
