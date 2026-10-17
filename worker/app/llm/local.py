"""Meaning search with a small open-source embedding model, run on this server's CPU through ONNX.

No API call and no generated text: the model only turns a passage or a question into a list of numbers, and
search compares them. Loaded once, on first use; the Docker image carries the model so a cold start never
downloads it.
"""
from __future__ import annotations

from functools import lru_cache

from ..config import settings


@lru_cache(maxsize=1)
def _model():
    from pathlib import Path

    from fastembed import TextEmbedding
    # fastembed's own default is the system temp folder, which macOS clears; keep the model somewhere that lasts.
    cache = settings.local_model_cache or str(Path.home() / ".cache" / "fastembed")
    return TextEmbedding(settings.local_embedding_model, cache_dir=cache)


def embed_passages(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    return [v.tolist() for v in _model().passage_embed(texts, batch_size=32)]


def embed_query(text: str) -> list[float]:
    return next(iter(_model().query_embed([text]))).tolist()
