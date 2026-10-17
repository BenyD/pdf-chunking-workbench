# Document search and form reading

Upload PDFs, ask questions in plain words and get an answer with the pages it
came from. Built for documents that break ordinary search: 300-page acts with
schedules, 150-page price tables, inspection reports with annotated figures,
scanned bills.

Pages:

- **Documents**: upload a PDF or load the samples; each one is read, split into passages and indexed within minutes.
- **Search**: a question across all documents or one of them; the passages that answer it, each highlighted on its page. With generative AI switched on, also a short written answer with citations.
- **Compare**: one question asked three ways (keywords only, the app, the app with generative AI) side by side, and the standard chunking methods (the ones LangChain, LlamaIndex and AWS Bedrock offer) scored on the same 129 questions.
- **SOP check**: a company SOP checked sentence by sentence against 21 CFR Part 211, each gap with the SOP's words and the reason.
- **Forms** (hidden unless `NEXT_PUBLIC_FORMS=1` in `web/.env.local`): teach it a form once, then read every scan of that form into a table.

How a document is processed: pages are rendered; the layout is parsed so
headings, tables (whole and row by row) and figures are known; passages are cut
along those boundaries with their breadcrumb (chapter, section) in front, and a
figure's bare labels (A, B, 1, 2), printed or drawn into the image and read
with OCR, are tied to the key that explains them;
every passage is embedded by a small open-source model running in our own
worker and stored. Search is hybrid (keyword and meaning, fused) and returns
the passages, each on its page.

**No generative AI by default, and no outside API.** Nothing in the pipeline
writes text: the passages are exactly what the rules cut, and the embedding
model (snowflake-arctic-embed-s, run on the CPU through ONNX) only turns text
into numbers. It scores 93% on the benchmark below, above every standard chunking
method. Setting `NEXT_PUBLIC_AI=1` on the web app and `PURE=false` on the
worker turns on the optional extras: a model-written context line per
passage, figure descriptions, and a written answer (98%).

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
           compare_chunking.py: builds fixed-size, semantic, hierarchical and structure-only chunks beside the live ones and scores them all.
           gap_check.py: checks SOPs against 21 CFR Part 211, line by line (regulations/21cfr211.xml is the eCFR text): picks the sections
           that apply to each SOP, keeps every verdict by its evidence (benchmarks/gap-cache.sqlite), and with --batch uses the Batch API.
           With --library it checks a company's SOPs as one set: a gap only when no SOP meets the requirement, named against its owner.
           With --local it calls no AI at all (local model, rules judge); --judge cascade sends only the lines the rules leave unsure to a model.
           gap_modes.py: runs those ways side by side on the same SOPs and prints what each decides, gets right, leaves for a person and costs.
```

## Run locally

Prerequisites: Node 20+, pnpm, Python 3.12+, [uv](https://docs.astral.sh/uv/),
Docker, the Supabase CLI, and Tesseract with its language packs (`brew install tesseract tesseract-lang`; the Hindi pack reads gazette pages set in legacy fonts).

Once the two env files below exist, one command runs everything (Supabase,
the worker and the web app) from one terminal, and Ctrl-C stops all three:

```bash
./dev.sh
```

Step by step, the same thing by hand:

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

## Deploy

Three pieces, each on the service that fits it. The commands below are what
was run for the demo; the secret values live only in the hosting dashboards
and in the two local env files.

**Database and storage: Supabase.** One project, with the migrations pushed
and the public bucket the first migration creates.

```bash
supabase projects create chunklab --org-id <org> --region ap-south-1 --db-password <generated>
supabase link --project-ref <ref> -p <password>
supabase db push -p <password>
supabase projects api-keys --project-ref <ref>      # anon and service_role keys
```

The worker connects through the session pooler
(`postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`),
which answers over IPv4; the direct host does not on the free tier.

**Worker: a Cloudflare container.** The worker needs PyMuPDF and Tesseract,
native code that Cloudflare Workers cannot run, so it runs as a container
built from `worker/Dockerfile` behind a small Worker that forwards every
request to it (`deploy/cloudflare`). Needs Docker locally and the Workers
paid plan.

```bash
cd deploy/cloudflare && npm install
npm run deploy                                       # builds and pushes the image, deploys the Worker
npx wrangler secret bulk secrets.json                # DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
                                                     # STORAGE_BUCKET, WORKER_SECRET, ANTHROPIC_API_KEY,
                                                     # VOYAGE_API_KEY, VOYAGE_RPM, VOYAGE_MAX_TOKENS_PER_REQUEST
curl https://chunklab-worker.<account>.workers.dev/health
```

The container sleeps two hours after its last request and wakes on the
next one, which takes a few seconds; an ingest started before it sleeps
runs to the end.
A running container keeps the environment it started with, so after
changing a secret bump `GENERATION` in `wrangler.jsonc` and deploy again:
traffic moves to a fresh container that starts with the new values.

**Web app: Vercel.** The `web` folder is the project root.

```bash
cd web && vercel link --yes --project chunklab --scope <team>
vercel env add NEXT_PUBLIC_SUPABASE_URL production    # and SUPABASE_SERVICE_ROLE_KEY, WORKER_URL, WORKER_SECRET,
                                                      # ANTHROPIC_API_KEY, VOYAGE_API_KEY, EMBEDDING_MODEL, NEXT_PUBLIC_FORMS
vercel deploy --prod
```

`WORKER_URL` is the Worker's address and `WORKER_SECRET` must match the one
given to the container. Samples load from the deployment itself, so nothing
else needs uploading.

## Models and cost

**By default nothing here is called.** Passages are cut by rules, and meaning
search uses snowflake-arctic-embed-s inside the worker: no API, no per-use
bill, nothing leaves the servers. Indexing costs only the worker's CPU time.
The table below applies when generative AI is switched on.


| Step | Model | Notes |
|---|---|---|
| a look at each figure | `claude-haiku-5-5` | one cheap look at every figure crop at ingest, thinking off; a logo, a border or a blank box gets no description and no passage |
| figure descriptions | `claude-opus-5-5` | once per figure that carries information, structured JSON output |
| passage context and suggested questions | `claude-haiku-5-5` | once per text/table passage at ingest, thinking off |
| answer on the search page | `claude-haiku-5-5` | one short call per search, from the passages found |
| OCR fallback | `claude-opus-5-5` | only for fields with low confidence or failed validation |
| embeddings | Voyage `voyage-4` (1024 d) | documents at ingest, queries at search time |

**What it costs.** Every document's stats carry the tokens its ingest spent
(`stats.llm.tokens`), so the figure is measured, not guessed. Prices below
were read from the Claude pricing page and Voyage's pricing page on
2026-10-15: Haiku 5.5 $0.10 in / $0.50 out per million tokens, Opus 5.5
$4 / $20, voyage-4 $0.06 per million with the first 200 million free.

| One call | tokens in / out | cost |
|---|---|---|
| context line for a passage (Haiku) | ~530 / ~125 | $0.00012 |
| a look at a figure (Haiku) | ~960 / 5 | $0.0001 |
| a figure description (Opus) | ~1,500 / ~400 | $0.014 |
| an answer on Search (Haiku, six passages) | ~800 to 2,500 / ~350 | $0.0004 |

| One document | model calls | about |
|---|---|---|
| a one-page bill | 3 context lines | $0.0004 |
| the 4-page inspection report, 2 photos | 9 context, 2 looks, 2 descriptions | $0.03 |
| a 102-page act, no figures | 416 context lines, 145k embedding tokens | $0.06 |
| a 297-page act | 768 context lines, 431k embedding tokens | $0.12 |
| the 151-page price table | 182 context lines, 1.2M embedding tokens | $0.09 |
| a 100-page drug label with 49 illustrated steps | 238 context, 49 looks, 49 descriptions | $0.73 |

So text and tables cost well under a cent a page, questions cost a
twentieth of a cent each, and the one thing that costs real money is a
figure described by Opus, about a cent and a half each. The fixed costs are
the hosting: Supabase (free tier, or $25 a month), Vercel (free, or $20),
one small machine for the worker (about $5 to $10), Tesseract is free.

**Where it can go lower.** The Batch API halves every ingest call and
ingest is already asynchronous, so bulk imports can run through it for 50%
off. Figure descriptions on Sonnet 5.5 would cost half of Opus, and on
Haiku a fortieth; the current choice is Opus because arrows and callouts
on inspection photos are where the smaller models miss, and that is what
the demo is about. A re-ingest redoes every call; caching descriptions by
image hash and context lines by passage hash would make it free.

Retrieval itself is a single Postgres function (full text + vector, reciprocal rank fusion) and costs nothing per query.

## Measured

**Against the alternatives.** `scripts/compare_chunking.py` rebuilds every
benchmark document the standard ways, with the settings AWS Bedrock documents (fixed-size, semantic,
hierarchical) and with our chunker and no AI, embeds all of them with the
same model and scores them with the same search. Right passage in the top
five, 129 questions:

| Setup | recall@5 |
|---|---|
| Fixed-size 300 tokens (the usual default) | 84% |
| Semantic chunking | 82% |
| Hierarchical 1,500 / 300 | 87 to 89%, reading about three times the tokens |
| Our structure, keywords only | 86% |
| Our structure + local open-source model (the app, no API) | 93% |
| Our structure + embeddings API, nothing generated | 95% |
| With generative AI switched on | 98% |

Every setup is searched the way the search page searches: 8 results asked
for, the top five scored (re-run 2026-10-18). The full table, per document,
is on the Compare page and in docs/DECISIONS.md section 22.

**When the answer is somewhere else.** A passage often points at the one
that answers: "see Table 2", a figure whose decision is in a table row,
a unit number recorded twice. These links are built by rules at ingest and
shown under each result. On 36 questions whose answer sits only in the
passage pointed at, the app finds 75% in the top five, 86% with links
(81% if it simply showed ten), and 100% with generative AI switched on.
Documents citing each other are linked the same way ("section 230 of the
Bharatiya Nyaya Sanhita", "kept under SOP-QA-040"): on 21 questions asked
of the BNSS whose answer is in the BNS, search inside the BNSS finds none
and links find 71%. Details in docs/DECISIONS.md sections 28 and 32.

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
The same set against the hosted deployment, run after all thirteen documents
had been ingested at once, scored 96% recall@5 and 0.86 MRR; the context
line for each passage is written afresh on every ingest, so a point or two
moves between runs.

The pipeline was chosen by running the same questions against three ways of
cutting the documents (fixed windows, layout-aware cuts, layout-aware cuts
plus written context). Fixed windows found the right row in the price table
half the time; the shipped pipeline finds it every time. The comparison and
its numbers are in `docs/DECISIONS.md`.

Zonal OCR on the rotated scanned bill reads all six fields from Tesseract at
90 to 96% confidence after deskew and anchor registration, no model fallback
needed.
