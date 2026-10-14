"""All Claude calls live here so cost and model choice are visible in one file.

Three jobs, three different cost profiles:
  describe_figure  - vision judgement, once per figure at ingest      -> Opus 5.5
  chunk_context    - bulk, simple, once per chunk at ingest           -> Haiku 5.5
  ocr_fallback     - only when zonal OCR confidence is low            -> Opus 5.5

Thinking is adaptive by default on these models; depth is controlled with
output_config.effort. Structured outputs guarantee JSON so there is no
parse-and-retry loop.
"""
from __future__ import annotations

import base64
import json
import logging
from typing import Any

import anthropic

from ..config import settings

log = logging.getLogger(__name__)

_client: anthropic.AsyncAnthropic | None = None


def client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key, max_retries=4)
    return _client


def _text_of(resp: Any) -> str:
    for block in resp.content:
        if block.type == "text":
            return block.text
    return ""


async def _opus_structured(system: str, content: list[dict], schema: dict, max_tokens: int = 4000) -> dict | None:
    """Opus call with a JSON schema. Returns None on refusal.

    Server-side fallbacks are requested so a safety-classifier decline on the
    primary model is retried on a fallback model inside the same request.
    """
    kwargs: dict[str, Any] = dict(
        model=settings.vision_model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": content}],
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema}},
    )
    try:
        resp = await client().beta.messages.create(
            betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs
        )
    except anthropic.BadRequestError as e:
        if "fallback" not in str(e).lower():
            raise
        log.warning("fallbacks parameter rejected, retrying without it: %s", e)
        resp = await client().messages.create(**kwargs)
    if resp.stop_reason == "refusal":
        return None
    text = _text_of(resp)
    return json.loads(text) if text else None


FIGURE_SCHEMA = {
    "type": "object",
    "properties": {
        "subject": {"type": "string", "description": "One line: what the figure shows."},
        "description": {"type": "string", "description": "Two to five sentences a reader could search by. Mention materials, parts, defects, directions, quantities."},
        "annotations": {
            "type": "array",
            "description": "One entry per arrow, circle, box, callout or label.",
            "items": {
                "type": "object",
                "properties": {
                    "marker": {"type": "string", "description": "arrow | circle | box | label | other"},
                    "points_to": {"type": "string", "description": "What part or region the marker indicates."},
                    "text": {"type": "string", "description": "The annotation text, transcribed exactly; empty if none."},
                },
                "required": ["marker", "points_to", "text"],
                "additionalProperties": False,
            },
        },
        "text_in_image": {"type": "array", "items": {"type": "string"}, "description": "Every other piece of text visible in the image."},
    },
    "required": ["subject", "description", "annotations", "text_in_image"],
    "additionalProperties": False,
}

FIGURE_SYSTEM = (
    "You describe figures from technical, legal and medical documents so that they can be found by text search. "
    "Be literal and specific. Arrows and callouts are the most important content: for each one, say exactly what it "
    "points at and transcribe its label. Do not speculate beyond what is drawn."
)


async def describe_figure(png: bytes, caption: str | None, labels: list[str], breadcrumb: str) -> dict | None:
    hints = []
    if caption:
        hints.append(f"Caption from the document: {caption}")
    if labels:
        hints.append("Text extracted near or inside the figure: " + "; ".join(labels[:30]))
    hints.append(f"Location in document: {breadcrumb}")
    content = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.standard_b64encode(png).decode()}},
        {"type": "text", "text": "\n".join(hints) + "\n\nDescribe this figure for search."},
    ]
    return await _opus_structured(FIGURE_SYSTEM, content, FIGURE_SCHEMA)


CONTEXT_SYSTEM = (
    "You write a short situating context for a chunk of a long document, so the chunk can be understood and "
    "retrieved on its own. Answer with one or two plain sentences and nothing else: which part of the document "
    "this is, what it is about, and what key entities, section numbers or terms it concerns. Do not restate the chunk."
)


async def chunk_context(doc_title: str, breadcrumb: str, chunk_text: str, before: str, after: str) -> str:
    prompt = (
        f"<document_title>{doc_title}</document_title>\n"
        f"<location>{breadcrumb}</location>\n"
        f"<text_before>{before[-1500:]}</text_before>\n"
        f"<chunk>{chunk_text[:4000]}</chunk>\n"
        f"<text_after>{after[:1500]}</text_after>\n\n"
        "Write the situating context for <chunk>."
    )
    resp = await client().messages.create(
        model=settings.context_model,
        max_tokens=1500,
        system=CONTEXT_SYSTEM,
        output_config={"effort": "low"},
        messages=[{"role": "user", "content": prompt}],
    )
    if resp.stop_reason == "refusal":
        return ""
    return _text_of(resp).strip()


OCR_SYSTEM = (
    "You read a scanned or photographed document image and extract the requested fields exactly as printed. "
    "Return null for a field that is not visible. Never guess digits: if a number is unclear, return null."
)


async def ocr_fallback(png: bytes, fields: list[dict]) -> dict | None:
    """fields: [{name, type, description?}] -> {name: value|null}"""
    props = {}
    for f in fields:
        t = f.get("type", "text")
        desc = f.get("description") or f"{f['name']} ({t})"
        if t in ("amount",):
            props[f["name"]] = {"type": ["number", "null"], "description": desc + ". Numeric value only, no currency symbol."}
        elif t == "integer":
            props[f["name"]] = {"type": ["integer", "null"], "description": desc}
        elif t == "date":
            props[f["name"]] = {"type": ["string", "null"], "description": desc + ". Format YYYY-MM-DD."}
        else:
            props[f["name"]] = {"type": ["string", "null"], "description": desc}
    schema = {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}
    content = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.standard_b64encode(png).decode()}},
        {"type": "text", "text": "Extract these fields: " + ", ".join(f["name"] for f in fields)},
    ]
    return await _opus_structured(OCR_SYSTEM, content, schema, max_tokens=2000)
