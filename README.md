# Document chunking, search and zonal OCR

Layout-aware PDF chunking, hybrid search and zonal OCR, with three chunking
strategies stored side by side so you can see and measure the difference.

- **naive**: fixed token windows (the baseline)
- **structural**: cuts follow headings, tables (whole and row by row) and figures; breadcrumb prepended; no model calls
- **contextual**: structural + a model-written context sentence per chunk and an arrow-aware description per figure

Read [docs/DECISIONS.md](docs/DECISIONS.md) for why each choice was made (internal
notes, not served by the app). The user guide is [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md),
served at `/docs`.

## Layout

```
web/       Next.js 16 app (UI + API routes). Deploys to Vercel.
worker/    FastAPI + PyMuPDF + Tesseract + OpenCV. Parsing, chunking, model calls, embeddings, zonal OCR. Deploys as a Docker container.
supabase/  Postgres schema (pgvector + full text + hybrid_search function) and local stack config.
samples/   Generator for the synthetic sample PDFs. Output lands in web/public/samples.
docs/      User documentation (served at /docs) and internal design notes.
```

## Run locally

Prerequisites: Node 20+, pnpm, Python 3.12+, [uv](https://docs.astral.sh/uv/),
Docker, the Supabase CLI, and Tesseract (`brew install tesseract`).

```bash
# 1. database + storage (local Supabase on ports 563xx)
supabase start -x edge-runtime,logflare,vector,realtime,imgproxy
supabase migration up

# 2. worker
cd worker && cp .env.example .env     # fill in DATABASE_URL, SUPABASE_*, ANTHROPIC_API_KEY, VOYAGE_API_KEY
uv sync
uv run uvicorn app.main:app --reload --port 8000

# 3. web
cd web && cp .env.example .env.local  # NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WORKER_URL, WORKER_SECRET, VOYAGE_API_KEY
pnpm install
pnpm dev --port 3001
```

Open http://localhost:3001 and click **Load sample documents**.

Dev switches in `worker/.env`: `SKIP_LLM=true` makes the contextual strategy
equal the structural one (no Anthropic calls); `FAKE_EMBEDDINGS=true` writes
deterministic pseudo-vectors so the pipeline runs without a Voyage key (search
then works on full text only).

Regenerate the synthetic samples: `uv run --project worker python samples/generate/make_samples.py`.
Sync the documentation page after editing the markdown: `python3 scripts/sync-content.py`.

## Deploy

1. **Supabase**: create a project, run the two files in `supabase/migrations` in the SQL editor (or `supabase db push`). The migration creates the public `chunklab` bucket.
2. **Worker** (Railway, Fly.io, Render, or any Docker host): build `worker/Dockerfile`; set `DATABASE_URL` (the direct Postgres URL), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WORKER_SECRET`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`. Give it at least 1 GB RAM; a 300-page ingest takes a few minutes and runs in a background thread.
3. **Web** (Vercel): import the repo with root directory `web`; set `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WORKER_URL`, `WORKER_SECRET`, `VOYAGE_API_KEY`, `EMBEDDING_MODEL=voyage-4`.
4. Open the deployment, click **Load sample documents**.

Uploads go straight from the browser to Supabase Storage through a signed URL, so Vercel's request-size limit never applies.

## Models and cost

| Step | Model | Notes |
|---|---|---|
| figure descriptions | `claude-opus-5-5` | once per figure at ingest, structured JSON output |
| chunk context | `claude-haiku-5-5` | once per text/table chunk at ingest |
| OCR fallback | `claude-opus-5-5` | only for fields with low confidence or failed validation |
| embeddings | Voyage `voyage-4` (1024 d) | documents at ingest, queries at search time |

Search itself is a single Postgres function (full text + vector, reciprocal rank fusion) and costs nothing per query.

## Measured on the samples

recall@5 and mean reciprocal rank per strategy on the built-in question sets,
run on 2026-10-15 with Voyage embeddings and hybrid search (k = 5).

| Document | naive | structural | contextual |
|---|---|---|---|
| QC inspection report (figures + ruled table) | 100% (MRR 0.90) | 100% (MRR 1.00) | 100% (MRR 1.00) |
| Bharatiya Nyaya Sanhita (102 pages, sections) | 100% (MRR 0.78) | 100% (MRR 0.96) | 100% (MRR 0.94) |
| Bharatiya Nagarik Suraksha Sanhita (297 pages) | 86% (MRR 0.79) | 86% (MRR 0.75) | 100% (MRR 0.86) |
| Price schedule (150-page table, 4,500 rows) | 50% (MRR 0.50) | 100% (MRR 0.52) | 100% (MRR 0.80) |

Where naive and structural both reach 100% recall, the MRR column shows the
difference: structural puts the right chunk first far more often. Contextual
wins on the table-heavy documents, where the model-written context and the
row flattening give each small chunk enough meaning to be ranked first.

Ingest times on an M4 Pro with real model calls and embeddings: 4-page report
66 s (rate-limited run), 102-page act 493 s, 151-page table 211 s, 297-page
act 638 s. Zonal OCR on the rotated scanned bill: all six fields from
Tesseract at 90 to 96% confidence after deskew and anchor registration, no
model fallback needed.
