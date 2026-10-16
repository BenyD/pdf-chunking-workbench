#!/usr/bin/env python3
"""Give passages a vector from the local open-source model (no API call) where they have none.

    cd worker
    .venv/bin/python ../scripts/embed_local.py                    # every 'structural' passage without one
    .venv/bin/python ../scripts/embed_local.py --force            # after changing LOCAL_EMBEDDING_MODEL: redo them all

The model is the worker's (LOCAL_EMBEDDING_MODEL, default in worker/app/config.py), run on this machine's CPU.
Point DATABASE_URL at another database to fill that one; the vectors are the same wherever they are computed.
"""
from __future__ import annotations

import argparse
import sys
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


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--strategy", default="structural")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    main(a.strategy, a.force)
