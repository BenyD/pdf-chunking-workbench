#!/usr/bin/env python3
"""Give every ready document the suggestions the Search page shows, built from its stored passages' own headings,
captions and codes (worker/app/chunk/suggest.py). No model, no re-reading of any PDF.

    cd worker
    .venv/bin/python ../scripts/backfill_suggestions.py [--rest]    # --rest: the hosted project, through the REST API

A document whose suggestions were written by a model (stats.suggestions already filled) is left alone unless
--force is given.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))
from app.chunk.model import ChunkDraft  # noqa: E402
from app.chunk.suggest import from_structure  # noqa: E402
from app.config import settings  # noqa: E402

COLS = ["id", "chunk_type", "raw_text", "context", "metadata", "page_start", "page_end", "parent_id", "ordinal"]


def local(force: bool) -> None:
    import psycopg
    from psycopg.rows import dict_row
    with psycopg.connect(settings.database_url, autocommit=True, row_factory=dict_row) as c:
        for d in c.execute("select id::text as id, name, stats from documents where status = 'ready' order by name").fetchall():
            if (d["stats"] or {}).get("suggestions") and not force:
                print(f"  {d['name'][:46]:46} kept ({len(d['stats']['suggestions'])})")
                continue
            rows = c.execute(f"select {', '.join(COLS)} from chunks where document_id = %s and strategy = 'structural' order by ordinal", (d["id"],)).fetchall()
            qs = from_structure([ChunkDraft.from_row(r) for r in rows], d["name"].rsplit(".", 1)[0])
            stats = dict(d["stats"] or {}); stats["suggestions"] = qs
            c.execute("update documents set stats = %s::jsonb where id = %s::uuid", (json.dumps(stats), d["id"]))
            print(f"  {d['name'][:46]:46} {len(qs)}")


def rest(force: bool) -> None:
    import httpx
    base = settings.supabase_url.rstrip("/") + "/rest/v1"
    h = {"apikey": settings.supabase_service_role_key, "Authorization": f"Bearer {settings.supabase_service_role_key}",
         "Content-Type": "application/json", "Prefer": "return=minimal"}
    with httpx.Client(timeout=120, headers=h) as c:
        for d in c.get(f"{base}/documents", params={"select": "id,name,stats", "status": "eq.ready", "order": "name"}).json():
            if (d["stats"] or {}).get("suggestions") and not force:
                print(f"  {d['name'][:46]:46} kept ({len(d['stats']['suggestions'])})")
                continue
            rows, off = [], 0
            while True:
                page = c.get(f"{base}/chunks", params={"select": ",".join(COLS), "document_id": f"eq.{d['id']}", "strategy": "eq.structural",
                                                      "order": "ordinal", "limit": "1000", "offset": str(off)}).json()
                rows += page
                if len(page) < 1000:
                    break
                off += 1000
            qs = from_structure([ChunkDraft.from_row(r) for r in rows], d["name"].rsplit(".", 1)[0])
            stats = dict(d["stats"] or {}); stats["suggestions"] = qs
            c.patch(f"{base}/documents", params={"id": f"eq.{d['id']}"}, json={"stats": stats}).raise_for_status()
            print(f"  {d['name'][:46]:46} {len(qs)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rest", action="store_true")
    ap.add_argument("--force", action="store_true", help="replace suggestions already stored, a model's included")
    a = ap.parse_args()
    (rest if a.rest else local)(a.force)
