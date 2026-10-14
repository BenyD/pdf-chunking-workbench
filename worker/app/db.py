"""Thin psycopg layer. One connection per operation keeps it simple and safe
inside background threads."""
from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any, Iterable

import psycopg
from psycopg.rows import dict_row

from .config import settings


@contextmanager
def conn():
    with psycopg.connect(settings.database_url, autocommit=True, row_factory=dict_row) as c:
        yield c


def get_document(document_id: str) -> dict[str, Any] | None:
    with conn() as c:
        return c.execute("select * from documents where id = %s", (document_id,)).fetchone()


def update_document(document_id: str, **fields: Any) -> None:
    sets, vals = [], []
    for k, v in fields.items():
        sets.append(f"{k} = %s")
        vals.append(json.dumps(v) if isinstance(v, (dict, list)) else v)
    vals.append(document_id)
    with conn() as c:
        c.execute(f"update documents set {', '.join(sets)} where id = %s", vals)


def set_progress(document_id: str, stage: str, done: int | None = None, total: int | None = None, message: str | None = None) -> None:
    progress = {"stage": stage}
    if done is not None:
        progress["done"] = done
    if total is not None:
        progress["total"] = total
    if message:
        progress["message"] = message
    update_document(document_id, status="processing", progress=progress)


def replace_pages(document_id: str, rows: Iterable[dict[str, Any]]) -> None:
    with conn() as c:
        c.execute("delete from pages where document_id = %s", (document_id,))
        c.cursor().executemany(
            """insert into pages (document_id, page_number, width, height, image_path, is_scanned, ocr_applied)
               values (%(document_id)s, %(page_number)s, %(width)s, %(height)s, %(image_path)s, %(is_scanned)s, %(ocr_applied)s)""",
            list(rows),
        )


def delete_chunks(document_id: str, strategy: str | None = None) -> None:
    with conn() as c:
        if strategy:
            c.execute("delete from chunks where document_id = %s and strategy = %s", (document_id, strategy))
        else:
            c.execute("delete from chunks where document_id = %s", (document_id,))


def insert_chunks(rows: list[dict[str, Any]]) -> None:
    """rows carry an `embedding` list[float] or None; cast happens in SQL."""
    if not rows:
        return
    prepared = []
    for r in rows:
        emb = r.get("embedding")
        prepared.append({
            **r,
            "bboxes": json.dumps(r.get("bboxes", [])),
            "metadata": json.dumps(r.get("metadata", {})),
            "embedding": "[" + ",".join(f"{x:.6f}" for x in emb) + "]" if emb else None,
        })
    with conn() as c:
        cur = c.cursor()
        for i in range(0, len(prepared), 500):
            cur.executemany(
                """insert into chunks (id, document_id, strategy, chunk_type, ordinal, content, raw_text, context,
                                       page_start, page_end, bboxes, parent_id, prev_id, next_id, metadata, token_count, embedding)
                   values (%(id)s, %(document_id)s, %(strategy)s, %(chunk_type)s, %(ordinal)s, %(content)s, %(raw_text)s, %(context)s,
                           %(page_start)s, %(page_end)s, %(bboxes)s::jsonb, %(parent_id)s, %(prev_id)s, %(next_id)s, %(metadata)s::jsonb,
                           %(token_count)s, %(embedding)s::vector)""",
                prepared[i:i + 500],
            )


def insert_ocr_run(template_id: str | None, document_id: str, page_number: int, result: dict, chunk_id: str | None) -> str:
    with conn() as c:
        row = c.execute(
            """insert into ocr_runs (template_id, document_id, page_number, result, chunk_id)
               values (%s, %s, %s, %s::jsonb, %s) returning id""",
            (template_id, document_id, page_number, json.dumps(result), chunk_id),
        ).fetchone()
        return str(row["id"])


def next_ordinal(document_id: str, strategy: str) -> int:
    with conn() as c:
        row = c.execute(
            "select coalesce(max(ordinal), -1) + 1 as n from chunks where document_id = %s and strategy = %s",
            (document_id, strategy),
        ).fetchone()
        return int(row["n"])


def chunks_missing_embedding(document_id: str, limit: int = 128) -> list[dict]:
    with conn() as c:
        return c.execute(
            "select id, content from chunks where document_id = %s and embedding is null order by strategy, ordinal limit %s",
            (document_id, limit),
        ).fetchall()


def count_missing_embedding(document_id: str) -> int:
    with conn() as c:
        return int(c.execute("select count(*) as n from chunks where document_id = %s and embedding is null", (document_id,)).fetchone()["n"])


def set_embeddings(pairs: list[tuple[str, list[float]]]) -> None:
    if not pairs:
        return
    with conn() as c:
        c.cursor().executemany(
            "update chunks set embedding = %s::vector where id = %s",
            [("[" + ",".join(f"{x:.6f}" for x in v) + "]", cid) for cid, v in pairs],
        )
