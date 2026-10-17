#!/usr/bin/env python3
"""Give passages a vector from the local open-source model (no API call) where they have none.

    cd worker
    .venv/bin/python ../scripts/embed_local.py                    # every 'structural' passage without one
    .venv/bin/python ../scripts/embed_local.py --force            # after changing LOCAL_EMBEDDING_MODEL: redo them all

The model is the worker's (LOCAL_EMBEDDING_MODEL, default in worker/app/config.py), run on this machine's CPU.
Point DATABASE_URL at another database to fill that one; the vectors are the same wherever they are computed.
With --linked it reaches the Supabase project this repo is linked to through the Supabase CLI and its
Management API (`supabase db query --linked`), so no database password is needed, only `supabase login`.
That costs about ten seconds a call; --rest is the fast way when the database password is not at hand: it
reads and writes through the project's REST API with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))
from app.config import settings  # noqa: E402
from app.llm import local  # noqa: E402


def main(strategy: str, force: bool, batch: int = 256) -> None:
    t0 = time.time()
    with psycopg.connect(settings.database_url, autocommit=True) as c:
        if force:
            c.execute("update chunks set embedding_local = null where strategy = %s", (strategy,))
        total = c.execute("select count(*) from chunks where strategy = %s and embedding_local is null", (strategy,)).fetchone()[0]
        print(f"{total} '{strategy}' passages to embed with {settings.local_embedding_model}")
        done = 0
        while True:
            rows = c.execute("select id::text, content from chunks where strategy = %s and embedding_local is null order by document_id, ordinal limit %s",
                             (strategy, batch)).fetchall()
            if not rows:
                break
            vecs = local.embed_passages([r[1] for r in rows])
            with c.cursor() as cur:
                cur.executemany("update chunks set embedding_local = %s::vector where id = %s::uuid",
                                [("[" + ",".join(f"{x:.6f}" for x in v) + "]", r[0]) for r, v in zip(rows, vecs)])
            done += len(rows)
            print(f"  {done}/{total}  {time.time() - t0:.0f}s", flush=True)
    print(f"done in {time.time() - t0:.0f}s")


def _cli(sql: str) -> list[dict]:
    """Run SQL on the linked project through the Supabase CLI; return its rows."""
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
        f.write(sql)
    out = subprocess.run(["supabase", "db", "query", "--linked", "--output-format", "json", "-f", f.name],
                         cwd=ROOT, capture_output=True, text=True)
    Path(f.name).unlink(missing_ok=True)
    text = out.stdout
    if out.returncode != 0 or "{" not in text:
        raise RuntimeError(f"supabase db query failed: {(out.stderr or text)[-400:]}")
    obj, _ = json.JSONDecoder().raw_decode(text[text.index("{"):])
    return obj.get("rows", [])


def main_linked(strategy: str, force: bool, batch: int = 200) -> None:
    t0 = time.time()
    if force:
        _cli(f"update chunks set embedding_local = null where strategy = '{strategy}'")
    total = int(_cli(f"select count(*) as n from chunks where strategy = '{strategy}' and embedding_local is null")[0]["n"])
    print(f"{total} '{strategy}' passages on the linked project to embed with {settings.local_embedding_model}")
    done = 0
    while True:
        rows = _cli(f"select id::text as id, content from chunks where strategy = '{strategy}' and embedding_local is null "
                    f"order by id limit {batch}")
        if not rows:
            break
        vecs = local.embed_passages([r["content"] for r in rows])
        values = ",\n".join(f"('{r['id']}', '[" + ",".join(f"{x:.6f}" for x in v) + "]')" for r, v in zip(rows, vecs))
        _cli(f"update chunks c set embedding_local = v.e::vector from (values {values}) as v(id, e) where c.id = v.id::uuid")
        done += len(rows)
        print(f"  {done}/{total}  {time.time() - t0:.0f}s", flush=True)
    print(f"done in {time.time() - t0:.0f}s")


def main_rest(strategy: str, force: bool, batch: int = 500, threads: int = 8) -> None:
    import httpx
    from concurrent.futures import ThreadPoolExecutor
    base = settings.supabase_url.rstrip("/") + "/rest/v1/chunks"
    h = {"apikey": settings.supabase_service_role_key, "Authorization": f"Bearer {settings.supabase_service_role_key}",
         "Content-Type": "application/json", "Prefer": "return=minimal"}
    t0 = time.time()
    with httpx.Client(timeout=120, headers=h) as client:
        if force:
            client.patch(base, params={"strategy": f"eq.{strategy}"}, json={"embedding_local": None}).raise_for_status()
        done = 0
        while True:
            r = client.get(base, params={"select": "id,content", "strategy": f"eq.{strategy}", "embedding_local": "is.null",
                                         "order": "id", "limit": str(batch)})
            r.raise_for_status()
            rows = r.json()
            if not rows:
                break
            vecs = local.embed_passages([x["content"] for x in rows])

            def put(pair):
                row, v = pair
                client.patch(base, params={"id": f"eq.{row['id']}"},
                             json={"embedding_local": "[" + ",".join(f"{x:.6f}" for x in v) + "]"}).raise_for_status()

            with ThreadPoolExecutor(threads) as pool:
                list(pool.map(put, zip(rows, vecs)))
            done += len(rows)
            print(f"  {done} done  {time.time() - t0:.0f}s", flush=True)
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--strategy", default="structural")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--linked", action="store_true", help="the Supabase project this repo is linked to, through the CLI")
    ap.add_argument("--rest", action="store_true", help="through the REST API (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)")
    a = ap.parse_args()
    (main_rest if a.rest else main_linked if a.linked else main)(a.strategy, a.force)
