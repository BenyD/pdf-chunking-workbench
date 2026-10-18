#!/usr/bin/env python3
"""Add the reference, key, shared-identifier and cross-document links to passages already stored, without
reprocessing.

    cd worker
    .venv/bin/python ../scripts/relink.py                          # every document, 'structural' and 'contextual'
    .venv/bin/python ../scripts/relink.py --rest                   # the same through the REST API (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

Reads every document's passages, rebuilds the links within each document with worker/app/chunk/references.py
(and the figure keys from their stored metadata), then the links between documents with
worker/app/chunk/doclinks.py, and writes back only the passages whose links changed. No model is called.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))
from app.chunk.doclinks import Doc, link_library  # noqa: E402
from app.chunk.legend import key_links_from_metadata  # noqa: E402
from app.chunk.model import ChunkDraft  # noqa: E402
from app.chunk.references import link_all  # noqa: E402
from app.config import settings  # noqa: E402

COLS = ["id", "document_id", "chunk_type", "raw_text", "context", "metadata", "page_start", "page_end", "parent_id", "ordinal"]


def relink(library: list[tuple[dict, list[dict]]]) -> list[tuple[dict, list[ChunkDraft], int]]:
    """library: (document, its stored rows) for one strategy. Returns each document with its changed passages."""
    docs, before = [], {}
    for d, rows in library:
        ds = [ChunkDraft.from_row(r) for r in sorted(rows, key=lambda r: r["ordinal"])]
        for x in ds:
            before[x.id] = json.dumps(x.metadata.get("links", []), sort_keys=True)
            x.metadata["links"] = [l for l in x.metadata.get("links", []) if l.get("kind") != "key"]
        key_links_from_metadata(ds)
        link_all(ds)
        docs.append(Doc(d["id"], d["name"], ds, str(d.get("created_at") or ""), d.get("code") or (d.get("stats") or {}).get("code")))
    link_library(docs)
    return [(d, [x for x in doc.chunks if json.dumps(x.metadata.get("links", []), sort_keys=True) != before[x.id]], len(doc.chunks))
            for (d, _), doc in zip(library, docs)]


def run_db(strategies: list[str]) -> None:
    import psycopg
    from psycopg.rows import dict_row
    with psycopg.connect(settings.database_url, autocommit=True, row_factory=dict_row) as c:
        docs = c.execute("""select id::text as id, name, created_at::text as created_at, stats->>'code' as code
                              from documents where status = 'ready' order by name""").fetchall()
        for s in strategies:
            library = [(d, c.execute(f"select {', '.join(COLS)} from chunks where document_id = %s and strategy = %s", (d["id"], s)).fetchall())
                       for d in docs]
            for d, changed, n in relink([(d, rows) for d, rows in library if rows]):
                with c.cursor() as cur:
                    cur.executemany("update chunks set metadata = %s::jsonb where id = %s::uuid", [(json.dumps(x.metadata), x.id) for x in changed])
                print(f"  {d['name'][:44]:44} {s:10} {n:5} passages, {len(changed):4} updated", flush=True)


def run_rest(strategies: list[str]) -> None:
    import httpx
    from concurrent.futures import ThreadPoolExecutor
    base = settings.supabase_url.rstrip("/") + "/rest/v1"
    h = {"apikey": settings.supabase_service_role_key, "Authorization": f"Bearer {settings.supabase_service_role_key}",
         "Content-Type": "application/json", "Prefer": "return=minimal"}
    with httpx.Client(timeout=120, headers=h) as client:
        docs = client.get(f"{base}/documents", params={"select": "id,name,created_at,stats", "status": "eq.ready", "order": "name"}).json()
        for s in strategies:
            library = []
            for d in docs:
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
                if rows:
                    library.append((d, rows))

            def put(x):
                client.patch(f"{base}/chunks", params={"id": f"eq.{x.id}"}, json={"metadata": x.metadata}).raise_for_status()
            for d, changed, n in relink(library):
                with ThreadPoolExecutor(8) as pool:
                    list(pool.map(put, changed))
                print(f"  {d['name'][:44]:44} {s:10} {n:5} passages, {len(changed):4} updated", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rest", action="store_true")
    ap.add_argument("--strategies", nargs="+", default=["structural", "contextual"])
    a = ap.parse_args()
    (run_rest if a.rest else run_db)(a.strategies)
