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


CHUNK_COLS = "id::text as id, document_id::text as document_id, chunk_type, raw_text, context, metadata, page_start, page_end, parent_id::text as parent_id, ordinal"


def ready_documents() -> list[dict[str, Any]]:
    with conn() as c:
        return c.execute("""select id::text as id, name, created_at::text as created_at, stats->>'code' as code
                              from documents where status = 'ready'""").fetchall()


def chunk_rows(document_id: str, strategy: str) -> list[dict[str, Any]]:
    with conn() as c:
        return c.execute(f"select {CHUNK_COLS} from chunks where document_id = %s and strategy = %s order by ordinal",
                         (document_id, strategy)).fetchall()


def documents_containing(text: str, strategy: str) -> list[str]:
    """Documents with a passage containing this exact text (a code such as SOP-QA-040, or a title)."""
    pattern = "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    with conn() as c:
        return [r["document_id"] for r in c.execute(
            "select distinct document_id::text as document_id from chunks where strategy = %s and raw_text like %s",
            (strategy, pattern)).fetchall()]


def update_chunk_metadata(pairs: list[tuple[str, dict]]) -> None:
    if not pairs:
        return
    with conn() as c:
        c.cursor().executemany("update chunks set metadata = %s::jsonb where id = %s::uuid", [(json.dumps(m), i) for i, m in pairs])


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


_VECTOR_COLUMNS = {"embedding", "embedding_local"}   # the API model's vectors, and the local model's


def _col(column: str) -> str:
    if column not in _VECTOR_COLUMNS:
        raise ValueError(f"unknown vector column {column}")
    return column


def chunks_missing_embedding(document_id: str, limit: int = 128, column: str = "embedding", strategy: str | None = None) -> list[dict]:
    col = _col(column)
    with conn() as c:
        return c.execute(
            f"select id, content from chunks where document_id = %s and {col} is null"
            " and strategy <> 'hier_parent' and (%s::text is null or strategy = %s) order by strategy, ordinal limit %s",
            (document_id, strategy, strategy, limit),
        ).fetchall()


def count_missing_embedding(document_id: str, column: str = "embedding", strategy: str | None = None) -> int:
    col = _col(column)
    with conn() as c:
        return int(c.execute(
            f"select count(*) as n from chunks where document_id = %s and {col} is null and strategy <> 'hier_parent'"
            " and (%s::text is null or strategy = %s)", (document_id, strategy, strategy)).fetchone()["n"])


def set_embeddings(pairs: list[tuple[str, list[float]]], column: str = "embedding") -> None:
    if not pairs:
        return
    col = _col(column)
    # one statement per batch: from a server far from the database, a round trip per row is most of the time
    with conn() as c:
        c.execute(
            f"""update chunks c set {col} = v.vec::vector
                  from unnest(%s::uuid[], %s::text[]) as v(id, vec) where c.id = v.id""",
            ([cid for cid, _ in pairs], ["[" + ",".join(f"{x:.6f}" for x in v) + "]" for _, v in pairs]),
        )


def sample_chunks(document_id: str, n: int = 12) -> list[dict]:
    """A spread of chunks for writing question suggestions."""
    with conn() as c:
        return c.execute(
            """select raw_text, chunk_type from chunks
               where document_id = %s and strategy = 'contextual' and chunk_type in ('text','table_row','figure')
               order by random() limit %s""",
            (document_id, n),
        ).fetchall()


def merge_stats(document_id: str, extra: dict) -> None:
    with conn() as c:
        c.execute("update documents set stats = coalesce(stats, '{}'::jsonb) || %s::jsonb where id = %s", (json.dumps(extra), document_id))
