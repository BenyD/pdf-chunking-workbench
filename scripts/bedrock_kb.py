#!/usr/bin/env python3
"""Amazon Bedrock's hierarchical chunking, run for real, on the same 129 questions.

    cd worker
    .venv/bin/python ../scripts/bedrock_kb.py export ../samples/work/bedrock     # the 14 benchmark PDFs + metadata
    ../deploy/bedrock/setup.sh ../samples/work/bedrock                          # creates the knowledge base (AWS)
    uv run --with boto3 python ../scripts/bedrock_kb.py eval                     # writes scripts/benchmarks/bedrock.json

The knowledge base parses each PDF with Bedrock's default parser, cuts it with Bedrock's hierarchical chunking
(1,500-token parents, 300-token children, 60 tokens of overlap), embeds the children with Titan Text Embeddings
V2 and stores them in S3 Vectors. A search matches children and returns their parents. Each question is asked
within its own document (a metadata filter), as the app's benchmark does, and counts when one of the passages
returned holds the expected words; when Bedrock reports a page number it must also be the expected page.
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))
OUT = ROOT / "scripts" / "benchmarks" / "bedrock.json"
STATE = ROOT / "deploy" / "bedrock" / "state.env"


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def questions(c) -> list[dict]:
    return c.execute("""select d.name as doc, d.storage_path, q.question, q.must_contain, q.expected_page
                          from eval_questions q join documents d on d.id = q.document_id
                         where d.status = 'ready' order by d.name, q.created_at""").fetchall()


def export(folder: str) -> None:
    import psycopg
    from psycopg.rows import dict_row
    from app import storage
    from app.config import settings
    out = Path(folder)
    out.mkdir(parents=True, exist_ok=True)
    with psycopg.connect(settings.database_url, row_factory=dict_row) as c:
        docs = {(q["doc"], q["storage_path"]) for q in questions(c)}
    for name, path in sorted(docs):
        (out / name).write_bytes(storage.download(path))
        # Bedrock reads <file>.metadata.json beside each file; "doc" lets a search stay inside one document
        (out / f"{name}.metadata.json").write_text(json.dumps({"metadataAttributes": {"doc": name}}))
        print(f"  {name}")
    print(f"{len(docs)} documents in {out}")


def evaluate(ks: tuple[int, ...] = (5,)) -> None:
    import boto3
    import psycopg
    from psycopg.rows import dict_row
    from app.config import settings
    state = dict(l.split("=", 1) for l in STATE.read_text().split())
    rt = boto3.client("bedrock-agent-runtime", region_name=state["REGION"])
    with psycopg.connect(settings.database_url, row_factory=dict_row) as c:
        qs = questions(c)
    k = max(ks)
    per_doc: dict[str, list[int]] = {}
    rows, tokens, t0 = [], 0, time.time()
    for q in qs:
        r = rt.retrieve(knowledgeBaseId=state["KB_ID"], retrievalQuery={"text": q["question"]},
                        retrievalConfiguration={"vectorSearchConfiguration": {
                            "numberOfResults": k, "filter": {"equals": {"key": "doc", "value": q["doc"]}}}})
        hits = r["retrievalResults"]
        rank = None
        for i, h in enumerate(hits):
            text = h["content"].get("text", "")
            page = h.get("metadata", {}).get("x-amz-bedrock-kb-document-page-number")
            if norm(q["must_contain"]) in norm(text) and (page is None or q["expected_page"] is None or int(page) == q["expected_page"]):
                rank = i + 1
                break
        tokens += sum(len(h["content"].get("text", "")) // 4 for h in hits[:5])
        rows.append({"doc": q["doc"], "question": q["question"], "rank": rank})
        per_doc.setdefault(q["doc"], []).append(rank or 0)
    n = len(rows)
    found = sum(1 for r in rows if r["rank"] and r["rank"] <= 5)
    mrr = sum(1 / r["rank"] for r in rows if r["rank"] and r["rank"] <= 5) / n
    report = {"date": time.strftime("%Y-%m-%d"), "setup": "Amazon Bedrock knowledge base, hierarchical chunking 1500/300/60, Titan Text Embeddings V2, S3 Vectors",
              "questions": n, "recall_at_5": round(found / n, 3), "mrr": round(mrr, 3), "tokens_read_top5": round(tokens / n),
              "by_document": {d: round(sum(1 for x in v if 0 < x <= 5) / len(v), 3) for d, v in sorted(per_doc.items())},
              "per_question": rows, "seconds": round(time.time() - t0)}
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(f"{n} questions: right passage in the top five {found} ({found / n:.1%}), MRR {mrr:.3f}, "
          f"about {report['tokens_read_top5']} tokens read; {report['seconds']}s")
    for d, v in report["by_document"].items():
        print(f"  {d[:44]:44} {v:.0%}")


if __name__ == "__main__":
    if sys.argv[1:2] == ["export"]:
        export(sys.argv[2])
    elif sys.argv[1:2] == ["eval"]:
        evaluate()
    else:
        print(__doc__)
