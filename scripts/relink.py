#!/usr/bin/env python3
"""Add the reference, key and shared-identifier links to passages already stored, without reprocessing.

    cd worker
    .venv/bin/python ../scripts/relink.py                          # every document, 'structural' and 'contextual'
    .venv/bin/python ../scripts/relink.py --rest                   # the same through the REST API (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

Reads each document's passages, rebuilds links with worker/app/chunk/references.py (and the figure keys from
their stored metadata), and writes back only the passages whose links changed. No model is called.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))
from app.chunk.legend import key_links_from_metadata  # noqa: E402
from app.chunk.model import ChunkDraft  # noqa: E402
from app.chunk.references import link_all  # noqa: E402
from app.config import settings  # noqa: E402

COLS = ["id", "document_id", "chunk_type", "raw_text", "context", "metadata", "page_start", "page_end", "parent_id", "ordinal"]


def drafts(rows: list[dict]) -> list[ChunkDraft]:
    out = []
    for r in sorted(rows, key=lambda r: r["ordinal"]):
        md = r["metadata"] if isinstance(r["metadata"], dict) else json.loads(r["metadata"] or "{}")
        out.append(ChunkDraft(chunk_type=r["chunk_type"], raw_text=r["raw_text"], context=r["context"], page_start=r["page_start"],
                              page_end=r["page_end"], bboxes=[], metadata=md, id=str(r["id"]),
                              parent_id=str(r["parent_id"]) if r["parent_id"] else None, ordinal=r["ordinal"]))
    return out


def relink(rows: list[dict]) -> list[ChunkDraft]:
    ds = drafts(rows)
    before = {d.id: json.dumps(d.metadata.get("links", []), sort_keys=True) for d in ds}
    for d in ds:
        d.metadata["links"] = [l for l in d.metadata.get("links", []) if l.get("kind") != "key"]
    key_links_from_metadata(ds)
    link_all(ds)
    return [d for d in ds if json.dumps(d.metadata.get("links", []), sort_keys=True) != before[d.id]]


def run_db(strategies: list[str]) -> None:
    import psycopg
    from psycopg.rows import dict_row
    with psycopg.connect(settings.database_url, autocommit=True, row_factory=dict_row) as c:
        docs = c.execute("select id::text as id, name from documents where status = 'ready' order by name").fetchall()
        for d in docs:
            for s in strategies:
                rows = c.execute(f"select {', '.join(COLS)} from chunks where document_id = %s and strategy = %s", (d["id"], s)).fetchall()
                if not rows:
                    continue
                changed = relink(rows)
                with c.cursor() as cur:
                    cur.executemany("update chunks set metadata = %s::jsonb where id = %s::uuid",
                                    [(json.dumps(x.metadata), x.id) for x in changed])
                print(f"  {d['name'][:44]:44} {s:10} {len(rows):5} passages, {len(changed):4} updated", flush=True)


def run_rest(strategies: list[str]) -> None:
    import httpx
    from concurrent.futures import ThreadPoolExecutor
    base = settings.supabase_url.rstrip("/") + "/rest/v1"
    h = {"apikey": settings.supabase_service_role_key, "Authorization": f"Bearer {settings.supabase_service_role_key}",
         "Content-Type": "application/json", "Prefer": "return=minimal"}
    with httpx.Client(timeout=120, headers=h) as client:
        docs = client.get(f"{base}/documents", params={"select": "id,name", "status": "eq.ready", "order": "name"}).json()
        for d in docs:
            for s in strategies:
                rows, off = [], 0
                while True:
                    r = client.get(f"{base}/chunks", params={"select": ",".join(COLS), "document_id": f"eq.{d['id']}",
                                                            "strategy": f"eq.{s}", "order": "ordinal", "limit": "1000", "offset": str(off)})
                    r.raise_for_status()
                    page = r.json()
                    rows += page
                    if len(page) < 1000:
                        break
                    off += 1000
                if not rows:
                    continue
                changed = relink(rows)

                def put(x):
                    client.patch(f"{base}/chunks", params={"id": f"eq.{x.id}"}, json={"metadata": x.metadata}).raise_for_status()
                with ThreadPoolExecutor(8) as pool:
                    list(pool.map(put, changed))
                print(f"  {d['name'][:44]:44} {s:10} {len(rows):5} passages, {len(changed):4} updated", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rest", action="store_true")
    ap.add_argument("--strategies", nargs="+", default=["structural", "contextual"])
    a = ap.parse_args()
    (run_rest if a.rest else run_db)(a.strategies)
