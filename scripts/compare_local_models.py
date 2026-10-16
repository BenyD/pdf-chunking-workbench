#!/usr/bin/env python3
"""Which small open-source model should do meaning search on our own server, with no API call?

    cd worker && .venv/bin/python ../scripts/compare_local_models.py [--models ...] [--rerank]

Every candidate embeds the same rule-cut chunks (strategy 'structural': no model wrote any of their text)
and is scored on the same benchmark questions as scripts/compare_chunking.py: keyword ranks come from the
app's own Postgres search, meaning ranks from the local model, fused exactly as hybrid_search fuses them
(reciprocal rank fusion, k = 60, the top 20 of each). A hit is the expected phrase in the document's own
words on the expected page, in the top five. --rerank also sorts the fused top 20 with a small local
cross-encoder before taking the top five. Everything runs on this machine with ONNX on the CPU.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import psycopg

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))
from app.config import settings  # noqa: E402

OUT = ROOT / "scripts" / "benchmarks" / "local-models.json"
DEFAULT = ["BAAI/bge-small-en-v1.5", "snowflake/snowflake-arctic-embed-s", "ibm-granite/granite-embedding-small-english-r2",
           "sentence-transformers/all-MiniLM-L6-v2", "BAAI/bge-base-en-v1.5", "nomic-ai/nomic-embed-text-v1.5-Q"]
RERANKER = "Xenova/ms-marco-MiniLM-L-6-v2"


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def load(c: psycopg.Connection):
    chunks = c.execute("""select c.id::text, c.document_id::text, c.content, c.raw_text, c.page_start, c.page_end
                            from chunks c where c.strategy = 'structural'
                             and c.document_id in (select document_id from eval_questions) order by c.document_id, c.ordinal""").fetchall()
    qs = c.execute("""select q.document_id::text, d.name, q.question, q.must_contain, q.expected_page
                        from eval_questions q join documents d on d.id = q.document_id where d.status = 'ready'
                       order by d.name, q.created_at""").fetchall()
    return chunks, qs


def keyword_ranks(c: psycopg.Connection, q: str, doc: str) -> list[str]:
    # the app asks for 5 and fuses the top 20 (4 x 5) of each list; keyword-only with 20 returns those 20 in order
    rows = c.execute("select id::text from hybrid_search(%s, null, 'structural', %s::uuid, 20, 60, 1, 0) where fts_rank is not null order by fts_rank", (q, doc)).fetchall()
    return [r[0] for r in rows]


def evaluate(models: list[str], rerank: bool) -> None:
    from fastembed import TextEmbedding
    with psycopg.connect(settings.database_url, autocommit=True) as c:
        chunks, qs = load(c)
        kw = {i: keyword_ranks(c, q, doc) for i, (doc, _n, q, _m, _p) in enumerate(qs)}
    print(f"{len(chunks)} chunks, {len(qs)} questions")
    by_doc: dict[str, list[int]] = {}
    for i, ch in enumerate(chunks):
        by_doc.setdefault(ch[1], []).append(i)
    ids = [ch[0] for ch in chunks]
    info = {ch[0]: ch for ch in chunks}
    cross = None
    if rerank:
        from fastembed.rerank.cross_encoder import TextCrossEncoder
        cross = TextCrossEncoder(RERANKER)

    report = {"questions": len(qs), "chunks": len(chunks), "models": []}
    for name in models:
        t0 = time.time()
        model = TextEmbedding(name)
        docs = np.array(list(model.passage_embed([ch[2] for ch in chunks], batch_size=64)), dtype=np.float32)
        docs /= np.linalg.norm(docs, axis=1, keepdims=True) + 1e-9
        t_embed = time.time() - t0
        qv = np.array(list(model.query_embed([q[2] for q in qs])), dtype=np.float32)
        qv /= np.linalg.norm(qv, axis=1, keepdims=True) + 1e-9
        variants = {"hybrid": [], **({"hybrid+rerank": []} if cross else {})}
        t_q = time.time()
        for i, (doc, _name, question, needle, page) in enumerate(qs):
            rows = by_doc.get(doc, [])
            if not rows:
                for v in variants.values():
                    v.append(None)
                continue
            sims = docs[rows] @ qv[i]
            vec = [ids[rows[j]] for j in np.argsort(-sims)[:20]]
            score: dict[str, float] = {}
            for r, cid in enumerate(kw[i], 1):
                score[cid] = score.get(cid, 0) + 1 / (60 + r)
            for r, cid in enumerate(vec, 1):
                score[cid] = score.get(cid, 0) + 1 / (60 + r)
            fused = sorted(score, key=lambda x: -score[x])
            lists = {"hybrid": fused[:5]}
            if cross:
                top = fused[:20]
                s = list(cross.rerank(question, [info[x][3] for x in top]))
                lists["hybrid+rerank"] = [top[j] for j in np.argsort(-np.array(s))[:5]]
            for key, lst in lists.items():
                rank = None
                for r, cid in enumerate(lst, 1):
                    ch = info[cid]
                    if (not needle or _norm(needle) in _norm(ch[3])) and (page is None or ch[4] <= page <= ch[5]):
                        rank = r
                        break
                variants[key].append(rank)
        ms_per_query = (time.time() - t_q) / len(qs) * 1000
        for key, ranks in variants.items():
            n = len(ranks)
            row = {"model": name, "variant": key, "recall": round(sum(1 for r in ranks if r) / n, 3),
                   "mrr": round(sum(1 / r for r in ranks if r) / n, 3), "dims": int(docs.shape[1]),
                   "embed_seconds": round(t_embed, 1), "ms_per_query": round(ms_per_query, 1)}
            report["models"].append(row)
            print(f"{name:52} {key:14} recall {row['recall']:.0%}  MRR {row['mrr']:.2f}  dims {row['dims']}  "
                  f"index {t_embed:5.0f}s  {ms_per_query:6.0f} ms/question")
    # Merge with earlier runs, so models can be scored a few at a time.
    if OUT.exists():
        old = json.loads(OUT.read_text())
        keep = [m for m in old.get("models", []) if (m["model"], m["variant"]) not in {(r["model"], r["variant"]) for r in report["models"]}]
        report["models"] = keep + report["models"]
    OUT.write_text(json.dumps(report, indent=2) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=DEFAULT)
    ap.add_argument("--rerank", action="store_true")
    a = ap.parse_args()
    evaluate(a.models, a.rerank)
