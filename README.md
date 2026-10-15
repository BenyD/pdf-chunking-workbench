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
web/       Next.js 16 app (UI + API routes) on the Quartz design system (design.how). Deploys to Vercel.
worker/    FastAPI + PyMuPDF + Tesseract + OpenCV. Parsing, chunking, model calls, embeddings, zonal OCR. Deploys as a Docker container.
supabase/  Postgres schema (pgvector + full text + hybrid_search function) and local stack config.
samples/   Generator for the synthetic sample PDFs. Output lands in web/public/samples.
docs/      Internal design notes.
scripts/   eval.py: recall@k on the question sets, against a running deployment. make_questions.py: writes a labelled set per document with Claude. benchmarks/: the saved sets.
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
UI work follows the Quartz skill in `web/.claude/skills/quartz/SKILL.md`; check a screen with `npx eslint -c quartz.eslint.config.mjs .` from `web/`.

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
| a look at each figure | `claude-haiku-5-5` | one cheap look at every figure crop at ingest; a logo, a border or a blank box gets no description and no passage |
| figure descriptions | `claude-opus-5-5` | once per figure that carries information, structured JSON output |
| passage context and suggested questions | `claude-haiku-5-5` | once per text/table passage at ingest |
| answer on the search page | `claude-haiku-5-5` | one short call per search, from the passages found |
| OCR fallback | `claude-opus-5-5` | only for fields with low confidence or failed validation |
| embeddings | Voyage `voyage-4` (1024 d) | documents at ingest, queries at search time |

Retrieval itself is a single Postgres function (full text + vector, reciprocal rank fusion) and costs nothing per query.

## Measured

`scripts/make_questions.py` writes a labelled question set for every document
with Claude: passages are sampled across each document's pages and kinds (text,
table rows, whole tables, figures, forms), and for each one the model writes a
question someone who works with the document would ask, plus the exact phrase
from that passage which the right answer must contain. A phrase that is not in
the passage word for word, or that the question already gives away, is
rejected. The sets live in `scripts/benchmarks/` (and `public/samples/eval.json`
for the hand-written sample questions); `scripts/eval.py` runs them through the
live search and reports recall@5 and mean reciprocal rank. On 2026-10-15, 126
questions over 13 documents, with Voyage embeddings:

| Document | questions | recall@5 | MRR |
|---|---|---|---|
| Bharatiya Nyaya Sanhita 2023 (102 pages, sections) | 23 | 100% | 0.96 |
| Bharatiya Nagarik Suraksha Sanhita 2023 (297 pages, 30-page schedule) | 18 | 94% | 0.90 |
| QC inspection report (annotated photos, ruled table) | 16 | 100% | 0.97 |
| NPPA ceiling-price notice, Apollo (public gazette) | 12 | 100% | 1.00 |
| WHO GMP main principles, TRS 986 Annex 2 (60 pages) | 12 | 92% | 0.78 |
| FDA Humira label (100 pages, tables, illustrated instructions) | 11 | 100% | 0.84 |
| Pharma price schedule (150-page table, 4,500 rows) | 9 | 100% | 1.00 |
| NPPA ceiling-price notice 2024 (English and Hindi) | 8 | 100% | 1.00 |
| Rifaximin tablets monograph (watermarked draft) | 6 | 100% | 0.83 |
| CDSCO new drugs 2024 (table across a page break) | 4 | 100% | 1.00 |
| Three pharmacy bills, one a crooked scan | 7 | 100% | 0.93 |
| All documents | 126 | 98% | 0.93 |

The two misses: which clause of the BNSS names the Directorate of Prosecution,
where the search returned the section itself rather than the table-of-contents
entry the label asked for; and which earlier annex the WHO document replaces, a
sentence in its preamble. After a reset, `make_questions.py --seed` puts the
saved sets back onto the documents by name.

The pipeline was chosen by running the same questions against three ways of
cutting the documents (fixed windows, layout-aware cuts, layout-aware cuts
plus written context). Fixed windows found the right row in the price table
half the time; the shipped pipeline finds it every time. The comparison and
its numbers are in `docs/DECISIONS.md`.

Zonal OCR on the rotated scanned bill reads all six fields from Tesseract at
90 to 96% confidence after deskew and anchor registration, no model fallback
needed.
