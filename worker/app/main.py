"""Worker API. Called only by the web app (shared secret)."""
from __future__ import annotations

import asyncio
import logging
import os
import uuid

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import db, pipeline, storage
from .chunk.model import ChunkDraft
from .config import settings
from .llm import claude, local, voyage
from .ocr import zonal

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("worker")

app = FastAPI(title="Document worker", version="0.1.0")


def require_secret(x_worker_secret: str | None = Header(default=None)) -> None:
    if x_worker_secret != settings.worker_secret:
        raise HTTPException(status_code=401, detail="bad worker secret")


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "vision_model": settings.vision_model,
        "context_model": settings.context_model,
        "embedding_model": settings.embedding_model,
        "skip_llm": settings.skip_llm,
        "pure": settings.pure,
        "local_embedding_model": settings.local_embedding_model,
        "cpus": os.cpu_count(),
        "embedding_threads": local.threads(),
        "fake_embeddings": settings.fake_embeddings,
        "anthropic_key": bool(settings.anthropic_api_key),
        "voyage_key": bool(settings.voyage_api_key),
    }


class IngestRequest(BaseModel):
    document_id: str


@app.post("/ingest", status_code=202, dependencies=[Depends(require_secret)])
def ingest(req: IngestRequest, bg: BackgroundTasks) -> dict:
    if not db.get_document(req.document_id):
        raise HTTPException(status_code=404, detail="document not found")
    db.update_document(req.document_id, status="queued", progress={"stage": "queued"})
    bg.add_task(pipeline.ingest, req.document_id)
    return {"queued": req.document_id}


@app.post("/embed", status_code=202, dependencies=[Depends(require_secret)])
def embed(req: IngestRequest, bg: BackgroundTasks) -> dict:
    """Resume embedding for chunks that have no vector (after a provider error)."""
    if not db.get_document(req.document_id):
        raise HTTPException(status_code=404, detail="document not found")
    missing = db.count_missing_embedding(req.document_id)
    db.update_document(req.document_id, status="processing", progress={"stage": "embed", "done": 0, "total": missing})
    bg.add_task(pipeline.embed_missing, req.document_id)
    return {"queued": req.document_id, "missing": missing}


class QueryRequest(BaseModel):
    text: str


@app.post("/embed-query", dependencies=[Depends(require_secret)])
def embed_query(req: QueryRequest) -> dict:
    """A question's vector from the local model, for meaning search with no API call."""
    from .llm import local
    return {"embedding": local.embed_query(req.text[:2000]), "model": settings.local_embedding_model}


@app.post("/suggest", status_code=202, dependencies=[Depends(require_secret)])
def suggest(req: IngestRequest, bg: BackgroundTasks) -> dict:
    """Write question suggestions for a document that is already ingested."""
    if not db.get_document(req.document_id):
        raise HTTPException(status_code=404, detail="document not found")
    bg.add_task(pipeline.suggest_existing, req.document_id)
    return {"queued": req.document_id}


class OcrRunRequest(BaseModel):
    document_id: str
    page_number: int = 1
    template: dict = Field(description="{name, fields:[{name,type,page,box,pattern?}], anchors:[{text,page,box}]}")
    template_id: str | None = None
    fallback: bool = True
    save: bool = True


@app.post("/ocr/run", dependencies=[Depends(require_secret)])
async def ocr_run(req: OcrRunRequest) -> dict:
    doc = db.get_document(req.document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")
    pdf = await asyncio.to_thread(storage.download, doc["storage_path"])
    result = await asyncio.to_thread(zonal.run_template, pdf, req.page_number, req.template)

    if req.fallback and result["needs_fallback"] and not settings.pure:      # pure mode: OCR only, never a model
        needing = set(result["needs_fallback"])
        fields = [f for f in req.template.get("fields", []) if f["name"] in needing]
        try:
            png = await asyncio.to_thread(zonal.page_png, pdf, req.page_number, 150)
            llm = await claude.ocr_fallback(png, fields)
        except Exception as e:  # noqa: BLE001
            llm = None
            result["fallback_error"] = str(e)[:300]
        if llm:
            for fr in result["fields"]:
                if fr["name"] in needing and fr["name"] in llm:
                    fr["ocr_value"] = fr["value"]
                    fr["value"] = llm[fr["name"]]
                    fr["source"] = "llm"
                    fr["valid"] = llm[fr["name"]] is not None
                    fr["note"] = "model fallback after " + (fr["note"] or "low confidence")
        result["fallback_used"] = bool(llm)

    chunk_id = None
    if req.save:
        chunk_id = await asyncio.to_thread(_store_record, doc, req, result)
    run_id = db.insert_ocr_run(req.template_id, req.document_id, req.page_number, result, chunk_id)
    return {"run_id": run_id, "chunk_id": chunk_id, "result": result}


def _store_record(doc: dict, req: OcrRunRequest, result: dict) -> str | None:
    """The extracted record becomes a searchable chunk of the document."""
    pairs = [(f["name"], f["value"]) for f in result["fields"] if f["value"] not in (None, "")]
    if not pairs:
        return None
    text = "; ".join(f"{k}: {v}" for k, v in pairs)
    boxes = [f["box_used"] for f in result["fields"] if f.get("box_used")]
    bbox = {"page": req.page_number,
            "x0": min(b["x"] for b in boxes), "y0": min(b["y"] for b in boxes),
            "x1": max(b["x"] + b["w"] for b in boxes), "y1": max(b["y"] + b["h"] for b in boxes)} if boxes else None
    tname = req.template.get("name", "template")
    record = ChunkDraft(
        chunk_type="record",
        raw_text=text,
        context=f"{doc['name']} > extracted record ({tname}, page {req.page_number})",
        page_start=req.page_number, page_end=req.page_number,
        bboxes=[bbox] if bbox else [],
        metadata={"fields": result["fields"], "template_id": req.template_id, "template_name": tname},
    )
    strategy = pipeline.STRATEGY
    if not settings.pure:
        record.embedding = voyage.embed([record.content], input_type="document")[0]
    r = record.to_row(doc["id"], strategy)
    r["id"] = str(uuid.uuid4())
    r["ordinal"] = db.next_ordinal(doc["id"], strategy)
    db.insert_chunks([r])
    if settings.pure:
        from .llm import local
        db.set_embeddings([(r["id"], local.embed_passages([record.content])[0])], "embedding_local")
    return r["id"]


class OcrWordsRequest(BaseModel):
    document_id: str
    page_number: int = 1


@app.post("/ocr/words", dependencies=[Depends(require_secret)])
async def ocr_words(req: OcrWordsRequest) -> dict:
    doc = db.get_document(req.document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")
    pdf = await asyncio.to_thread(storage.download, doc["storage_path"])
    words = await asyncio.to_thread(zonal.words_for_ui, pdf, req.page_number)
    return {"words": words}
