# Document search and form reading

Upload PDFs, ask questions in plain words and get an answer with the pages it
came from. Built for documents that break ordinary search: 300-page acts with
schedules, 150-page price tables, inspection reports with annotated figures,
scanned bills.

Three pages:

- **Documents**: upload a PDF or load the samples; each one is read, split into passages and indexed within minutes.
- **Search**: a question across all documents or one of them; a short answer with numbered sources, each opening the page it came from.
- **Forms**: mark the fields once on a sample form, then read any scan of the same form.

How a document is processed (one pipeline, chosen after measuring three):
pages are rendered; the layout is parsed so headings, tables (whole and row by
row) and figures are known; passages are cut along those boundaries with their
breadcrumb (chapter, section) in front; a small model writes one situating
sentence per passage and describes every figure, arrows included; everything
is embedded and stored. Search is hybrid (keyword and meaning, fused) and the
answer is written from the passages found, with citations.

Read [docs/DECISIONS.md](docs/DECISIONS.md) for why each choice was made
(internal notes, not served by the app).

## Layout

```
web/       Next.js 16 app (UI + API routes). Deploys to Vercel.
worker/    FastAPI + PyMuPDF + Tesseract + OpenCV. Parsing, chunking, model calls, embeddings, zonal OCR. Deploys as a Docker container.
supabase/  Postgres schema (pgvector + full text + hybrid_search function) and local stack config.
samples/   Generator for the synthetic sample PDFs. Output lands in web/public/samples.
docs/      Internal design notes.
scripts/   eval.py: recall@k on the built-in question sets, against a running deployment.
```

## Run locally

Prerequisites: Node 20+, pnpm, Python 3.12+, [uv](https://docs.astral.sh/uv/),
Docker, the Supabase CLI, and Tesseract with its language packs (`brew install tesseract tesseract-lang`; the Hindi pack reads gazette pages set in legacy fonts).

```bash
# 1. database + storage (local Supabase on ports 563xx)
supabase start -x edge-runtime,logflare,vector,realtime,imgproxy
supabase migration up

# 2. worker
cd worker && cp .env.example .env     # fill in DATABASE_URL, SUPABASE_*, ANTHROPIC_API_KEY, VOYAGE_API_KEY
uv sync
uv run uvicorn app.main:app --reload --port 8000

# 3. web
cd web && cp .env.example .env.local  # NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WORKER_URL, WORKER_SECRET, VOYAGE_API_KEY, ANTHROPIC_API_KEY
pnpm install
pnpm dev --port 3001
```

Open http://localhost:3001 and click **Load samples**.

Dev switches in `worker/.env`: `SKIP_LLM=true` skips the written context and
figure descriptions (no Anthropic calls); `FAKE_EMBEDDINGS=true` writes
deterministic pseudo-vectors so the pipeline runs without a Voyage key (search
then works on keywords only).

Regenerate the synthetic samples: `uv run --project worker python samples/generate/make_samples.py`.
Measure recall on the built-in question sets: `python3 scripts/eval.py [base-url] [k]`.

## Deploy

1. **Supabase**: create a project, run the two files in `supabase/migrations` in the SQL editor (or `supabase db push`). The migration creates the public `chunklab` bucket.
2. **Worker** (Railway, Fly.io, Render, or any Docker host): build `worker/Dockerfile` (it installs the `eng` and `hin` Tesseract packs); set `DATABASE_URL` (the direct Postgres URL), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WORKER_SECRET`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`. Give it at least 1 GB RAM; a 300-page ingest takes a few minutes and runs in a background thread.
3. **Web** (Vercel): import the repo with root directory `web`; set `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WORKER_URL`, `WORKER_SECRET`, `VOYAGE_API_KEY`, `EMBEDDING_MODEL=voyage-4`, `ANTHROPIC_API_KEY`.
4. Open the deployment, click **Load samples**.

Uploads go straight from the browser to Supabase Storage through a signed URL, so Vercel's request-size limit never applies.

## Guard rails

- Every API route that costs money or disk is rate limited per client address (searches 30/min, answers 20/min, uploads and re-processing 10/hour, form reads 30/min). The window is kept in memory; move it to Redis/Upstash when running more than one web instance.
- Uploads are PDF only, 150 MB at most. Questions are capped at 500 characters.
- Processing runs in the worker as a background job with progress written to the document row; embedding is a separate resumable stage, so a provider rate limit never loses the parsed document. The worker paces embedding calls (`VOYAGE_RPM`) and retries on `Retry-After`.
- Model calls use structured output and fall back to plain parsing; a failed figure description or suggestion never fails the document. Model calls time out after two minutes so a hung connection cannot stall a document for the SDK's default ten.
- If the embedding provider is unreachable, search still answers on keywords alone and says so in the response (`embedded: false`).

## Models and cost

| Step | Model | Notes |
|---|---|---|
| figure descriptions | `claude-opus-5-5` | once per figure at ingest, structured JSON output |
| passage context and suggested questions | `claude-haiku-5-5` | once per text/table passage at ingest |
| answer on the search page | `claude-haiku-5-5` | one short call per search, from the passages found |
| OCR fallback | `claude-opus-5-5` | only for fields with low confidence or failed validation |
| embeddings | Voyage `voyage-4` (1024 d) | documents at ingest, queries at search time |

Retrieval itself is a single Postgres function (full text + vector, reciprocal rank fusion) and costs nothing per query.

## Measured on the samples

`scripts/eval.py` runs the built-in question sets through the deployed search
(recall@5 and mean reciprocal rank). On 2026-10-15, with Voyage embeddings:

| Document | questions | recall@5 | MRR |
|---|---|---|---|
| QC inspection report (figures + ruled table) | 5 | 100% | 1.00 |
| Bharatiya Nyaya Sanhita (102 pages, sections) | 12 | 100% | 1.00 |
| Bharatiya Nagarik Suraksha Sanhita (297 pages, 30-page schedule) | 7 | 100% | 0.91 |
| Price schedule (150-page table, 4,500 rows) | 4 | 100% | 1.00 |

The pipeline was chosen by running the same questions against three ways of
cutting the documents (fixed windows, layout-aware cuts, layout-aware cuts
plus written context). Fixed windows found the right row in the price table
half the time; the shipped pipeline finds it every time. The comparison and
its numbers are in `docs/DECISIONS.md`.

Zonal OCR on the rotated scanned bill reads all six fields from Tesseract at
90 to 96% confidence after deskew and anchor registration, no model fallback
needed.
