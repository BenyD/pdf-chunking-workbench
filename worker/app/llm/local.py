"""Meaning search with a small open-source embedding model, run on this server's CPU through ONNX.

No API call and no generated text: the model only turns a passage or a question into a list of numbers, and
search compares them. Loaded once, on first use; the Docker image carries the model so a cold start never
downloads it.
"""
from __future__ import annotations

import math
import os
from functools import lru_cache

from ..config import settings


def threads() -> int:
    """The CPUs this process may really use. A container can see the host's cores while its quota allows a
    fraction of them; ONNX then starts a thread per core, and they fight over the quota."""
    if settings.local_embedding_threads:
        return settings.local_embedding_threads
    n = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else (os.cpu_count() or 1)
    try:
        quota, period = open("/sys/fs/cgroup/cpu.max").read().split()
        if quota != "max":
            n = min(n, math.ceil(int(quota) / int(period)))
    except (OSError, ValueError):
        pass
    return max(1, n)


@lru_cache(maxsize=1)
def _model():
    from pathlib import Path

    from fastembed import TextEmbedding
    # fastembed's own default is the system temp folder, which macOS clears; keep the model somewhere that lasts.
    cache = settings.local_model_cache or str(Path.home() / ".cache" / "fastembed")
    return TextEmbedding(settings.local_embedding_model, cache_dir=cache, threads=threads())


def embed_passages(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    return [v.tolist() for v in _model().passage_embed(texts, batch_size=32)]


def embed_query(text: str) -> list[float]:
    return next(iter(_model().query_embed([text]))).tolist()
