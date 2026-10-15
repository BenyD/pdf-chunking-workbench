"""Strategy 3: structural chunks + model-written context.

Same cuts as the structural strategy. What changes is what gets embedded:
  * text and table chunks get one or two situating sentences written by a
    small model that sees the chunk, its breadcrumb and its neighbours
  * figure chunks get a vision model description with every arrow and label
  * table rows inherit their table's context (no extra calls)

All of it happens once per document at ingest time.
"""
from __future__ import annotations

import asyncio
import copy

from ..config import settings
from ..llm import claude
from .model import ChunkDraft, link_sequence


async def chunk_contextual(structural: list[ChunkDraft], doc_title: str, on_progress=None) -> tuple[list[ChunkDraft], dict]:
    # Fresh ids, same order, remapped parent links
    clones = [copy.copy(c) for c in structural]
    id_map: dict[str, str] = {}
    for old, new in zip(structural, clones):
        import uuid
        new.id = str(uuid.uuid4())
        new.metadata = dict(old.metadata)
        new.bboxes = list(old.bboxes)
        id_map[old.id] = new.id
    for c in clones:
        c.parent_id = id_map.get(c.parent_id) if c.parent_id else None
    link_sequence(clones)

    usage = {"context_calls": 0, "triage_calls": 0, "vision_calls": 0, "figures_dropped": 0, "skipped": 0, "errors": 0}
    if settings.skip_llm:
        for c in clones:
            c.metadata["llm_context"] = None
            c.metadata["note"] = "SKIP_LLM=true: contextual strategy equals structural"
        usage["skipped"] = len(clones)
        return clones, usage

    sem = asyncio.Semaphore(settings.llm_concurrency)
    by_id = {c.id: c for c in clones}
    done = 0
    targets = [c for c in clones if c.chunk_type in ("text", "table", "figure")]

    async def work(c: ChunkDraft, idx: int) -> None:
        nonlocal done
        async with sem:
            try:
                if c.chunk_type == "figure":
                    # One cheap look first. A logo, a border or a blank box gets no description and no
                    # passage; a captioned or numbered figure is always described, whatever the look says.
                    kind = await claude.triage_figure(c.image_png or b"")
                    usage["triage_calls"] += 1
                    c.metadata["figure_kind"] = kind
                    if kind in claude.SKIP_KINDS and not c.metadata.get("caption") and not c.metadata.get("figure_number"):
                        c.metadata["vision_skipped"] = kind
                        usage["figures_dropped"] += 1
                        desc = None
                    else:
                        desc = await claude.describe_figure(c.image_png or b"", c.metadata.get("caption"), c.metadata.get("labels", []), c.context or doc_title)
                        usage["vision_calls"] += 1
                    if desc:
                        c.metadata["vision"] = desc
                        ann = "; ".join(f"{a['marker']} -> {a['points_to']}" + (f" ({a['text']})" if a.get("text") else "") for a in desc.get("annotations", []))
                        extra = [desc.get("subject", ""), desc.get("description", "")]
                        if ann:
                            extra.append("Annotations: " + ann)
                        if desc.get("text_in_image"):
                            extra.append("Text in image: " + "; ".join(desc["text_in_image"]))
                        c.raw_text = c.raw_text + "\n" + "\n".join(x for x in extra if x)
                else:
                    before = clones[idx - 1].raw_text if idx > 0 else ""
                    after = clones[idx + 1].raw_text if idx + 1 < len(clones) else ""
                    ctx = await claude.chunk_context(doc_title, c.context or "", c.raw_text, before, after)
                    usage["context_calls"] += 1
                    if ctx:
                        c.metadata["llm_context"] = ctx
                        c.context = f"{ctx}\n{c.context}" if c.context else ctx
            except Exception as e:  # keep going; the chunk falls back to its structural form
                usage["errors"] += 1
                c.metadata["llm_error"] = str(e)[:300]
            done += 1
            if on_progress and (done % 10 == 0 or done == len(targets)):
                on_progress(done, len(targets))

    await asyncio.gather(*(work(c, clones.index(c)) for c in targets))

    # A figure the look dismissed leaves the document, and the sequence closes over the gap.
    if any(c.metadata.get("vision_skipped") for c in clones):
        clones = [c for c in clones if not c.metadata.get("vision_skipped")]
        link_sequence(clones)

    # rows inherit their table's model context
    for c in clones:
        if c.chunk_type == "table_row" and c.parent_id and c.parent_id in by_id:
            parent_ctx = by_id[c.parent_id].metadata.get("llm_context")
            if parent_ctx:
                c.metadata["llm_context"] = parent_ctx
                c.context = f"{parent_ctx}\n{c.context}" if c.context else parent_ctx
    return clones, usage
