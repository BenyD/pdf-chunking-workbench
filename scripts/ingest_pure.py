#!/usr/bin/env python3
"""Upload PDFs to the local stack and run them through the real pipeline in pure mode (rules and the local
model only, no API call), whatever the local worker's own setting is.

    cd worker && .venv/bin/python ../scripts/ingest_pure.py ../samples/real-test/*.pdf

A document already in the library under the same name is processed again in place.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

os.environ["PURE"] = "true"                       # before the worker's settings load
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))
from app import db, pipeline, storage  # noqa: E402

for f in map(Path, sys.argv[1:]):
    name = f.name
    with db.conn() as c:
        row = c.execute("select id::text as id from documents where name = %s", (name,)).fetchone()
        if not row:
            row = c.execute("""insert into documents (name, storage_path, kind, status, progress)
                               values (%s, 'pending', 'upload', 'processing', '{"stage": "queued"}') returning id::text as id""",
                            (name,)).fetchone()
    doc_id = row["id"]
    path = f"documents/{doc_id}/source.pdf"
    storage.upload(path, f.read_bytes(), "application/pdf")
    db.update_document(doc_id, storage_path=path, status="processing")
    t = time.time()
    pipeline.ingest(doc_id)
    d = db.get_document(doc_id)
    s = d.get("stats") or {}
    print(f"{name[:44]:44} {d['status']:6} {s.get('pages', '?'):>4} pages {s.get('chunks', '?'):>5} passages "
          f"{s.get('by_type', {})}  {time.time() - t:.0f}s", flush=True)
