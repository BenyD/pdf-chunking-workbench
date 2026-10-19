#!/usr/bin/env python3
"""Amazon Bedrock's hierarchical chunking, run for real, on the same 129 questions.

    cd worker
    .venv/bin/python ../scripts/bedrock_kb.py export ../samples/work/bedrock     # the 14 benchmark PDFs + metadata
    ../deploy/bedrock/setup.sh ../samples/work/bedrock                          # creates the knowledge base (AWS)
    uv run --with boto3 --with "botocore[crt]" python ../scripts/bedrock_kb.py reingest   # one document at a time
    uv run --with boto3 --with "botocore[crt]" python ../scripts/bedrock_kb.py eval       # writes scripts/benchmarks/bedrock.json

The first ingestion (setup.sh) sends all PDFs at once. With this account's Titan quota in ap-south-1 (60 embedding
requests a minute) Bedrock reported it COMPLETE but had kept only the first pages of every long document (13 of
Humira's 100). `reingest` deletes each document from the knowledge base and sends it again on its own, waiting
for it to be indexed before the next, and reports how many pieces it now has and up to which page.

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
            md = h.get("metadata", {})
            page = md.get("x-amz-bedrock-kb-document-page-number")
            if page is not None:
                page = int(md.get("first_page") or 1) - 1 + int(page)
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


PART = 8                                   # pages per file sent to Bedrock


def export_parts(src: str, dst: str) -> None:
    """Each PDF cut into files of PART pages, with metadata naming the document and the part's first page, so the
    knowledge base can take one small file a minute under the 60-a-minute embedding quota."""
    import pymupdf
    out = Path(dst)
    out.mkdir(parents=True, exist_ok=True)
    for f in sorted(Path(src).glob("*.pdf")):
        doc = pymupdf.open(f)
        for start in range(0, doc.page_count, PART):
            part = pymupdf.open()
            part.insert_pdf(doc, from_page=start, to_page=min(start + PART, doc.page_count) - 1)
            name = f"{f.stem} [p{start + 1:03d}].pdf"
            part.save(out / name)
            (out / f"{name}.metadata.json").write_text(json.dumps({"metadataAttributes": {"doc": f.name, "first_page": start + 1}}))
        print(f"  {f.name}: {doc.page_count} pages, {-(-doc.page_count // PART)} parts")


def vectors_by_doc(state: dict) -> dict[str, list[int]]:
    import boto3
    s3v = boto3.client("s3vectors", region_name=state["REGION"])
    out: dict[str, list[int]] = {}
    tok = None
    while True:
        kw = dict(vectorBucketName=state["VECTOR_BUCKET"], indexName=state["INDEX"], returnMetadata=True, maxResults=500)
        if tok:
            kw["nextToken"] = tok
        r = s3v.list_vectors(**kw)
        for v in r["vectors"]:
            md = v.get("metadata", {})
            out.setdefault(md.get("doc", "?"), []).append(int(md.get("first_page") or 1) - 1 + int(md.get("x-amz-bedrock-kb-document-page-number") or 1))
        tok = r.get("nextToken")
        if not tok:
            return out


def reingest(only: list[str]) -> None:
    import boto3
    state = dict(l.split("=", 1) for l in STATE.read_text().split())
    ag = boto3.client("bedrock-agent", region_name=state["REGION"])
    s3 = boto3.client("s3", region_name=state["REGION"])
    names = sorted(o["Key"] for o in s3.list_objects_v2(Bucket=state["SRC_BUCKET"])["Contents"] if o["Key"].endswith(".pdf"))
    names = [n for n in names if not only or any(x.lower() in n.lower() for x in only)]
    kb, ds = state["KB_ID"], state["DATA_SOURCE_ID"]
    for name in names:
        uri = f"s3://{state['SRC_BUCKET']}/{name}"
        ident = {"dataSourceType": "S3", "s3": {"uri": uri}}
        ag.delete_knowledge_base_documents(knowledgeBaseId=kb, dataSourceId=ds, documentIdentifiers=[ident])
        for _ in range(60):                            # wait until it is gone, or it was never there
            d = ag.get_knowledge_base_documents(knowledgeBaseId=kb, dataSourceId=ds, documentIdentifiers=[ident])["documentDetails"][0]
            if d["status"] in ("DELETED", "NOT_FOUND") or "does not exist" in d.get("statusReason", ""):
                break
            time.sleep(5)
        t0 = time.time()
        ag.ingest_knowledge_base_documents(knowledgeBaseId=kb, dataSourceId=ds, documents=[{
            "content": {"dataSourceType": "S3", "s3": {"s3Location": {"uri": uri}}},
            "metadata": {"type": "S3_LOCATION", "s3Location": {"uri": uri + ".metadata.json"}}}])
        while True:
            time.sleep(10)
            d = ag.get_knowledge_base_documents(knowledgeBaseId=kb, dataSourceId=ds, documentIdentifiers=[ident])["documentDetails"][0]
            if d["status"] in ("INDEXED", "FAILED", "PARTIALLY_INDEXED", "METADATA_PARTIALLY_INDEXED", "METADATA_UPDATE_FAILED", "IGNORED"):
                break
        print(f"  {name[:52]:52} {d['status']:10} {time.time() - t0:4.0f}s {d.get('statusReason', '')[:100]}", flush=True)
        time.sleep(max(0, 65 - (time.time() - t0)))   # the quota is per minute: one small file a minute


if __name__ == "__main__":
    if sys.argv[1:2] == ["parts"]:
        export_parts(sys.argv[2], sys.argv[3])
        sys.exit()
    if sys.argv[1:2] == ["count"]:
        st = dict(l.split("=", 1) for l in STATE.read_text().split())
        for d, ps in sorted(vectors_by_doc(st).items()):
            print(f"  {d[:44]:44} {len(ps):5} pieces, pages {min(ps)}..{max(ps)}, {len(set(ps))} distinct")
        sys.exit()
    if sys.argv[1:2] == ["reingest"]:
        reingest(sys.argv[2:])
        sys.exit()
    if sys.argv[1:2] == ["export"]:
        export(sys.argv[2])
    elif sys.argv[1:2] == ["eval"]:
        evaluate()
    else:
        print(__doc__)
