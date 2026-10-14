"""Supabase Storage over its REST API. Two calls, no SDK."""
from __future__ import annotations

import httpx

from .config import settings

_HEADERS = {
    "Authorization": f"Bearer {settings.supabase_service_role_key}",
    "apikey": settings.supabase_service_role_key,
}


def _url(path: str) -> str:
    return f"{settings.supabase_url}/storage/v1/object/{settings.storage_bucket}/{path}"


def download(path: str) -> bytes:
    with httpx.Client(timeout=120) as client:
        r = client.get(_url(path), headers=_HEADERS)
        r.raise_for_status()
        return r.content


def upload(path: str, data: bytes, content_type: str) -> str:
    with httpx.Client(timeout=120) as client:
        r = client.post(
            _url(path),
            headers={**_HEADERS, "Content-Type": content_type, "x-upsert": "true"},
            content=data,
        )
        r.raise_for_status()
    return path


def public_url(path: str) -> str:
    return f"{settings.supabase_url}/storage/v1/object/public/{settings.storage_bucket}/{path}"
