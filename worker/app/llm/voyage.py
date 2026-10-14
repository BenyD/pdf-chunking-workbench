"""Voyage embeddings over REST. Batched, throttled, retried, dimension-pinned.

`input_type` matters: documents and queries get different instruction prefixes
on Voyage models, so the worker embeds with "document" and the web app embeds
queries with "query".

Rate limits are the operational risk here (new accounts are capped at a few
requests per minute), so calls go through one process-wide throttle, honour
Retry-After on 429, and back off for minutes rather than seconds.
"""
from __future__ import annotations

import math
import random
import threading
import time

import httpx

from ..chunk.tokens import count
from ..config import settings

API = "https://api.voyageai.com/v1/embeddings"
MAX_TEXTS = 128

_lock = threading.Lock()
_last_call = 0.0


def embed(texts: list[str], input_type: str = "document") -> list[list[float]]:
    if not texts:
        return []
    if settings.fake_embeddings:
        return [_fake(t) for t in texts]
    if not settings.voyage_api_key:
        raise RuntimeError("VOYAGE_API_KEY is not set. Set it, or set FAKE_EMBEDDINGS=true for plumbing tests.")
    out: list[list[float]] = []
    for batch in _batches(texts):
        out.extend(_call(batch, input_type))
    return out


def _batches(texts: list[str]):
    batch, toks = [], 0
    for t in texts:
        n = count(t)
        if batch and (len(batch) >= MAX_TEXTS or toks + n > settings.voyage_max_tokens_per_request):
            yield batch
            batch, toks = [], 0
        batch.append(t)
        toks += n
    if batch:
        yield batch


def _throttle() -> None:
    """One request at a time, no faster than VOYAGE_RPM per minute."""
    global _last_call
    min_gap = 60.0 / max(settings.voyage_rpm, 1)
    wait = _last_call + min_gap - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    _last_call = time.monotonic()


def _call(batch: list[str], input_type: str) -> list[list[float]]:
    body = {
        "input": batch,
        "model": settings.embedding_model,
        "input_type": input_type,
        "output_dimension": settings.embedding_dim,
        "truncation": True,
    }
    headers = {"Authorization": f"Bearer {settings.voyage_api_key}"}
    delay = 2.0
    for attempt in range(settings.voyage_max_retries):
        with _lock:
            _throttle()
            r = httpx.post(API, json=body, headers=headers, timeout=120)
        if r.status_code == 200:
            data = sorted(r.json()["data"], key=lambda d: d["index"])
            return [d["embedding"] for d in data]
        if r.status_code in (429, 500, 502, 503, 504) and attempt < settings.voyage_max_retries - 1:
            retry_after = r.headers.get("retry-after")
            sleep_for = float(retry_after) if retry_after and retry_after.replace(".", "", 1).isdigit() else delay
            time.sleep(min(sleep_for, 90) + random.random())
            delay = min(delay * 2, 60)
            continue
        detail = ""
        try:
            detail = r.json().get("detail", "")
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(f"voyage {r.status_code}: {detail or r.text[:300]}")
    raise RuntimeError("voyage: retries exhausted (rate limited). If the account has no payment method it is capped at 3 requests/min; add one at dashboard.voyageai.com.")


def _fake(text: str) -> list[float]:
    """Deterministic pseudo-embedding so the pipeline can run without a key.
    Not semantically meaningful; hybrid search degrades to full text only."""
    rng = random.Random(hash(text) & 0xFFFFFFFF)
    v = [rng.gauss(0, 1) for _ in range(settings.embedding_dim)]
    norm = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / norm for x in v]
