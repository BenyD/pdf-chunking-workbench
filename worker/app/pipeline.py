"""Ingest one document end to end.

download -> render pages -> parse layout -> chunk (3 strategies) -> model
context (strategy 3 only) -> embed -> store. Progress is written to the
documents row after every stage so the UI can show it.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import pymupdf

from . import db, storage
from .chunk.contextual import chunk_contextual
from .chunk.model import ChunkDraft
from .chunk.naive import chunk_naive
from .chunk.structural import chunk_structural
from .config import settings
from .llm import voyage
from .parse.layout import parse_document

log = logging.getLogger(__name__)


def ingest(document_id: str) -> None:
    t0 = time.time()
    try:
        row = db.get_document(document_id)
        if not row:
            raise RuntimeError(f"document {document_id} not found")
        title = row["name"].rsplit(".", 1)[0]

        db.set_progress(document_id, "download")
        pdf = storage.download(row["storage_path"])
        doc = pymupdf.open(stream=pdf, filetype="pdf")
        n = doc.page_count
        db.update_document(document_id, page_count=n)

        db.set_progress(document_id, "render", 0, n)
        page_rows = _render_pages(doc, document_id)

        db.set_progress(document_id, "parse", 0, n)
        layouts = parse_document(doc, progress=lambda d, t: db.set_progress(document_id, "parse", d, t))
        for pr, lay in zip(page_rows, layouts):
            pr["is_scanned"], pr["ocr_applied"] = lay.is_scanned, lay.ocr_applied
        db.replace_pages(document_id, page_rows)

        db.set_progress(document_id, "chunk")
        naive = chunk_naive(layouts, title)
        structural = chunk_structural(layouts, title)
        _upload_figures(structural, document_id)

        db.set_progress(document_id, "context", 0, len(structural))
        contextual, llm_usage = asyncio.run(
            chunk_contextual(structural, title, on_progress=lambda d, t: db.set_progress(document_id, "context", d, t))
        )

        # Store chunks first (embedding null), then embed in a separate, resumable
        # stage. If the embedding provider throttles or fails, the chunks and the
        # paid model context survive and `embed_missing` picks up where it stopped.
        db.set_progress(document_id, "store")
        stats: dict = {"pages": n, "scanned_pages": sum(1 for l in layouts if l.is_scanned), "strategies": {}}
        all_rows = []
        for strategy, chunks in (("naive", naive), ("structural", structural), ("contextual", contextual)):
            for c in chunks:
                c.image_png = None
            all_rows.extend(c.to_row(document_id, strategy) for c in chunks)
            stats["strategies"][strategy] = {
                "chunks": len(chunks),
                "tokens": sum(c.token_count for c in chunks),
                "by_type": dict(Counter(c.chunk_type for c in chunks)),
                "avg_tokens": round(sum(c.token_count for c in chunks) / max(1, len(chunks))),
            }
        db.delete_chunks(document_id)
        db.insert_chunks(all_rows)
        stats["llm"] = llm_usage
        stats["embedding_model"] = settings.embedding_model if not settings.fake_embeddings else "fake (dev)"
        stats["parse_seconds"] = round(time.time() - t0, 1)
        db.update_document(document_id, stats=stats)

        embed_missing(document_id, t0=t0)
    except Exception as e:  # noqa: BLE001
        log.exception("ingest failed for %s", document_id)
        db.update_document(document_id, status="error", progress={"stage": "error", "message": str(e)[:500]})


_embed_lock = __import__("threading").Lock()


def embed_missing(document_id: str, t0: float | None = None) -> None:
    """Embed every chunk of the document that has no vector yet. Idempotent and
    resumable; one document at a time so concurrent ingests do not stampede
    the embedding provider's rate limit."""
    t0 = t0 or time.time()
    try:
        with _embed_lock:
            total = db.count_missing_embedding(document_id)
            done = 0
            db.set_progress(document_id, "embed", done, total)
            while True:
                rows = db.chunks_missing_embedding(document_id, limit=128)
                if not rows:
                    break
                vectors = voyage.embed([r["content"] for r in rows], input_type="document")
                db.set_embeddings([(str(r["id"]), v) for r, v in zip(rows, vectors)])
                done += len(rows)
                db.set_progress(document_id, "embed", done, total)
        row = db.get_document(document_id) or {}
        stats = dict(row.get("stats") or {})
        stats["seconds"] = round(time.time() - t0, 1)
        stats["embedded_chunks"] = done
        db.update_document(document_id, status="ready", progress={"stage": "done"}, stats=stats)
        log.info("embedded %s chunks for %s", done, document_id)
    except Exception as e:  # noqa: BLE001
        log.exception("embedding failed for %s", document_id)
        db.update_document(document_id, status="error", progress={"stage": "error", "message": "embedding: " + str(e)[:400]})


def _render_pages(doc: pymupdf.Document, document_id: str) -> list[dict]:
    rows: list[dict] = []
    n = doc.page_count
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = []
        for i, page in enumerate(doc):
            pno = i + 1
            png = page.get_pixmap(matrix=pymupdf.Matrix(settings.render_scale, settings.render_scale), alpha=False).tobytes("png")
            path = f"documents/{document_id}/pages/{pno}.png"
            futures.append(pool.submit(storage.upload, path, png, "image/png"))
            rows.append({"document_id": document_id, "page_number": pno, "width": page.rect.width,
                         "height": page.rect.height, "image_path": path, "is_scanned": False, "ocr_applied": False})
            if pno % 10 == 0:
                db.set_progress(document_id, "render", pno, n)
        for f in futures:
            f.result()
    return rows


def _upload_figures(chunks: list[ChunkDraft], document_id: str) -> None:
    figs = [c for c in chunks if c.chunk_type == "figure" and c.image_png]
    if not figs:
        return
    with ThreadPoolExecutor(max_workers=6) as pool:
        futs = []
        for c in figs:
            path = f"documents/{document_id}/figures/{c.id}.png"
            c.metadata["image_path"] = path
            futs.append(pool.submit(storage.upload, path, c.image_png, "image/png"))
        for f in futs:
            f.result()

