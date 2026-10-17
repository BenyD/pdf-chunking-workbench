"""The unit every strategy produces. Mirrors the `chunks` table."""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field

from .tokens import count


@dataclass
class ChunkDraft:
    chunk_type: str                 # text | table | table_row | figure | record
    raw_text: str
    context: str | None
    page_start: int
    page_end: int
    bboxes: list[dict]              # [{page, x0, y0, x1, y1}] fractions
    metadata: dict = field(default_factory=dict)
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    parent_id: str | None = None
    prev_id: str | None = None
    next_id: str | None = None
    ordinal: int = 0
    embedding: list[float] | None = None
    image_png: bytes | None = None  # figures only; uploaded by the pipeline

    @property
    def content(self) -> str:
        """What gets embedded and indexed: context first, then the text."""
        return f"{self.context.strip()}\n\n{self.raw_text}" if self.context else self.raw_text

    @property
    def token_count(self) -> int:
        return count(self.content)

    def to_row(self, document_id: str, strategy: str) -> dict:
        return {
            "id": self.id,
            "document_id": document_id,
            "strategy": strategy,
            "chunk_type": self.chunk_type,
            "ordinal": self.ordinal,
            "content": self.content,
            "raw_text": self.raw_text,
            "context": self.context,
            "page_start": self.page_start,
            "page_end": self.page_end,
            "bboxes": self.bboxes,
            "parent_id": self.parent_id,
            "prev_id": self.prev_id,
            "next_id": self.next_id,
            "metadata": self.metadata,
            "token_count": self.token_count,
            "embedding": self.embedding,
        }

    @classmethod
    def from_row(cls, r: dict) -> "ChunkDraft":
        """A stored passage back as a draft, for rebuilding its links."""
        md = r["metadata"] if isinstance(r["metadata"], dict) else json.loads(r["metadata"] or "{}")
        return cls(chunk_type=r["chunk_type"], raw_text=r["raw_text"], context=r["context"], page_start=r["page_start"],
                   page_end=r["page_end"], bboxes=[], metadata=md, id=str(r["id"]),
                   parent_id=str(r["parent_id"]) if r.get("parent_id") else None, ordinal=r.get("ordinal") or 0)


def link_sequence(chunks: list[ChunkDraft]) -> None:
    """Assign ordinals and prev/next pointers in document order."""
    for i, c in enumerate(chunks):
        c.ordinal = i
        c.prev_id = chunks[i - 1].id if i > 0 else None
        c.next_id = chunks[i + 1].id if i + 1 < len(chunks) else None
