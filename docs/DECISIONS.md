# Design decisions

This is the document to read before explaining the project. Every section
answers the same three questions: what was decided, why, and what the
alternative would have cost.

## 1. The problem in one sentence

Chunking is deciding what the unit of meaning is in a document, then making
sure every unit carries enough of its surroundings to be understood alone.
Everything else (tables, figures, OCR) is a special case of that.

## 2. Parse layout, not text

**Decision.** PDFs are parsed into typed blocks with positions (text, heading,
table, figure) using PyMuPDF, and chunking happens on those blocks.

**Why.** Plain text extraction destroys the structure before chunking starts:
tables become word soup, figures disappear, and headings detach from the text
under them. Positions are also what let the UI draw every chunk on the page,
which is how you prove a cut happened for a reason.

**Alternatives.**
- Hosted parsers (LlamaParse, Azure Document Intelligence, Unstructured) give
  better tables out of the box but cost per page and hide the decisions.
- `docling` or `pymupdf-layout` (a model-based layout analyser) would be the
  production upgrade for messy scans; both are drop-in at the block level.
  The chunking logic above the parser would not change.

## 3. Three strategies, compared; one shipped

During development every document was chunked three ways and all three lived
in the same table with a `strategy` column, so the same page or the same
query could be shown under each. That comparison is what chose the pipeline.
The product ships only the winner (the `strategy` column still says
"contextual" on every row, a leftover of the comparison), because a user of
the product wants one answer, not three columns to compare; see section 13.

| Strategy | What it does | Model calls | What it proves |
|---|---|---|---|
| naive | ~450-token windows, ~60-token overlap, line granular | 0 | The baseline everybody starts with, and why it fails on tables |
| structural | cuts at headings; tables atomic + one chunk per row; figures as chunks; breadcrumb prepended | 0 | Most of the quality gain is deterministic and free |
| contextual | structural + a model-written situating sentence per chunk + a vision description per figure | 1 per chunk, 1 per figure, once at ingest | The last mile, and what it costs |

**Why naive was kept during development.** The evaluation needed a baseline,
and showing a naive chunk slicing straight through a table is the fastest way
to explain the problem to a non-engineer. It is gone from the code now; the
numbers it produced are kept below.

## 4. Headings and breadcrumbs

**Decision.** A chunk never crosses a heading. Each chunk gets a breadcrumb
("Document > Chapter V > 90. Death caused by act done with intent to cause
miscarriage") prepended as context before embedding.

**How headings are found.** Three deterministic cues, in order: pattern
(`CHAPTER IV`, `THE FIRST SCHEDULE`, `103.` at line start), typography (larger
or bold short lines), and position (centred all-caps lines). Indian gazette
acts print section titles as 8pt notes in the margin; those are attached to
the section that starts at the same height. Running headers and page numbers
are removed by finding lines that repeat on more than 30% of pages.

**Why a breadcrumb and not the whole document?** The breadcrumb costs nothing
and fixes the orphan-chunk problem ("shall be punished likewise" means nothing
without its section). The contextual strategy adds a model-written sentence
on top, but only sees the chunk, its breadcrumb and its neighbours, not the
whole document. Anthropic's contextual-retrieval recipe prompts with the
entire document under prompt caching; for a 300-page act that is 150k cached
tokens per call. The windowed version is a few hundred tokens per call and
loses little, because the breadcrumb already carries the global position.

## 5. Tables

This is where generic tools break, so the rules are explicit.

1. **Two detectors.** Ruled tables (borders drawn) go through PyMuPDF's line
   finder. Ruling-free tables (statutes, schedules, most government PDFs) go
   through a whitespace-gutter projection: project every line onto the x axis,
   and x ranges that no line covers are column boundaries. A numbered header
   row like `(1) (2) (3)` is used as an extra cue when present. Cuts are
   snapped to the start of the next column's text because column starts are
   stable (left aligned) and column ends are not (wrapped text).
2. **Rows.** A new row begins when the key column (the leftmost column whose
   values look like codes or numbers) gets a value, or when the vertical gap is
   clearly larger than a line. Wrapped cells therefore stay in one row.
3. **Continuation across pages.** A table at the top of page N+1 whose
   columns match the table at the bottom of page N is the same table. A page
   that prints its own `(1) (2) (3)` row defines its columns exactly, so two
   such pages match on column count alone; pages without one borrow the
   previous page's model, and otherwise the cuts may drift by 5% of the page
   width (gazette typesetting shifts columns a little on every page).
   Repeated header rows are dropped, and keyless rows at the top of a page are
   appended to the previous row (they are its wrapped tail). This is how a
   150-page ruled table comes out as one table with 4,500 rows and the 30-page
   BNSS First Schedule as one table with 377 rows.
4. **Chunking.** A table is one chunk. If it is bigger than ~900 tokens it is
   split by rows and the header is repeated in every part, so no row is ever
   separated from its column names. Every row is also its own chunk, flattened
   to `Header: value. Header: value.` with the table part as its parent.
   "Ditto" / "Do." cells are resolved to the value above before flattening.

**Why rows as chunks?** "Is theft bailable?" should land on the row for
theft, not on a 900-token slab of table. The flattened row is semantically
self-contained, so both full-text and vector search find it. The parent link
lets the UI expand back to the whole table.

**What it took to keep the BNSS First Schedule in one piece.** The first
version split it into eight tables and skipped eleven pages. None of the
causes was a layout problem a model would be needed for; they were small
things the deterministic rules got wrong, and every fix is generic:

- A `1 2 3 4 5 6` row at the top of a page looks like six page numbers, and
  page-number filtering removed it. Column-number rows are now recognised
  before that filter runs.
- The real page number sits at 86% of the page height, outside the footer
  zone, and became a one-cell row. The top-most and bottom-most line of a
  page is now treated as a folio when it is only a number.
- Keys such as `109(2)` were not keys, and PyMuPDF sometimes glues the key to
  its cell (`109(2)For commission of...`). Both forms are accepted; a glued
  line is split at the first column boundary.
- Gazettes print `5, 10, 15...` line numbers in the margin; with prose beside
  them they passed as a three-column table. An arithmetic run of small
  numbers in the margin is dropped before layout.
- Column cuts were snapped to the left edge of whatever line began inside the
  column, including centred titles; snapping now anchors on clean cells, and
  the refinement pass keeps lines that straddle one cut so a wrong cut can
  move.
- A centred title in the middle of the table region (the heading of part II)
  ends the table instead of being absorbed into the last row.
- A section key at the top of a page (`57` just under the column numbers) sat
  in the header zone and looked like a folio. A number is a folio only when
  nothing but a running header shares its baseline. The same rule applies
  when learning which lines repeat across pages, otherwise a document that is
  mostly one table reports "Ditto" as a running header.
- Sub-cases of one section ("(i) if the offence be committed", "(ii) if not")
  carry no key and used to merge into one row with "Ditto Ditto" cells.
  Vertical gaps do not separate them reliably (two leadings on one page), so
  the rule is about content: a baseline that fills several cells starts a
  new row when, in some column, its text cannot continue the cell above (a
  second "Ditto", or a new sentence after a full stop). Those rows inherit
  the section number, so the flattened row still says which section it is;
  a single-cell keyless row is a wrapped tail and is glued back.

Result: one table, 454 rows, 350 distinct section keys, and no row with two
values in one cell. The other samples are unchanged (4,500-row price schedule,
the inspection and bill tables).

## 6. Figures with arrows

**Decision.** A figure is a cluster of raster images and vector drawings,
grown to include text sitting on it, rendered as one PNG. Its chunk contains
the caption, the text found on the figure, the sentences elsewhere that refer
to it, and (contextual strategy) a vision-model description that names every
arrow and what it points at.

**Why render the region rather than extract the image?** Arrows, circles and
labels are usually vector paths drawn over a photo. Extracting the embedded
image loses exactly the annotations the question is about.

**Why a description rather than a multimodal embedding?** CLIP-style
embeddings are good at "a photo of a bowl" and weak at "arrow indicating a
dent on the rim". A description is searchable text, explainable, and can be
read back to the user. An image embedding could be added later as a second
vector for image-to-image search.

## 7. Zonal OCR

**Decision.** The user draws named boxes once on a sample form, plus two or
three anchor words. For a new scan: render at 300 dpi, deskew, OCR the whole
page once for word positions, locate the anchors to compute shift and scale,
crop each box (shifted), OCR it alone, parse by type (date, amount, integer,
text, optional regex), and record a confidence. Boxes are stored as fractions
of the page so a template drawn on a 90 dpi render applies to a 300 dpi scan.

**Why registration matters.** Scans are never straight or exactly placed. A
box that is right on the template is wrong on the scan by a few millimetres,
which is a whole field. Anchors turn "same region always" into something that
survives a crooked scan.

**Fallback.** A field with low confidence or a failed validation is sent,
with its schema, to a vision model that returns structured JSON. Deterministic
where it works, model where it does not. For a pharma company this matters
twice: a single wrong digit in a dosage is dangerous, so the OCR path is
auditable and the model path is marked as such; and the fallback is only paid
on failures.

**Then search it.** The extracted record becomes a `record` chunk of the
document ("invoice_no: SP/2026/04469; date: 2026-10-16; grand_total: ..."),
embedded and indexed like any other chunk.

## 8. Search

**Decision.** Hybrid search in one SQL function: Postgres full-text rank and
pgvector cosine rank, each computed independently, fused with reciprocal rank
fusion (score = sum of 1/(60 + rank)).

**Why not vectors alone?** Embeddings blur numbers: "Section 420" matches
"Section 402" almost as well. Legal and pharma text is full of exact tokens
(section numbers, drug names, batch codes). Full-text catches those; vectors
catch paraphrase. RRF needs no score normalisation between the two.

**Retrieve small, show big.** Search runs over small chunks for precision.
Every chunk stores prev/next/parent ids, so the UI expands a row to its table
and a passage to its neighbours in one lookup, no second search.

## 9. Models and cost

| Job | Model | When | Why this tier |
|---|---|---|---|
| Figure description with arrows | Claude Opus 5.5 | once per figure at ingest | needs visual judgement; figures are rare |
| Chunk context sentence | Claude Haiku 5.5 | once per text/table chunk at ingest | bulk, simple; 40x cheaper than Opus on input |
| OCR fallback | Claude Opus 5.5 with structured output | only on low-confidence fields | correctness over cost, paid rarely |
| Embeddings | Voyage voyage-4, 1024 dims | once per chunk at ingest, once per query | Anthropic has no embedding endpoint; Voyage is the recommended partner |
| Search | none | every query | the hot path costs nothing |

**The efficiency argument.** Model work is pushed to ingest and paid once per
document. Query time is pure Postgres. The contextual strategy for a 100-page
act is a few hundred Haiku calls, well under a dollar. All model calls sit in
one file (`worker/app/llm/claude.py`) behind one module boundary, so swapping
a model is a config change and can be measured with the evaluation page.

**Production notes.** The Batches API halves ingest cost for the context
step; prompt caching would matter if the whole document were sent per call;
the same SDK code runs on Bedrock, Vertex and Foundry for data residency.

## 10. Evaluation

Each sample ships with questions and a phrase the right chunk must contain.
Recall@k and mean reciprocal rank are computed with the same search. This is
the difference between a preference and a measurement, and it is what should
be shown before any claim about chunk size. The evaluation page was removed
with the product pivot (section 13); `scripts/eval.py` runs the same
measurement against a deployment, and the numbers from the three-way
comparison are these (2026-10-15, recall@5 / MRR):

| Document | naive | structural | contextual |
|---|---|---|---|
| QC inspection report | 100% / 0.90 | 100% / 1.00 | 100% / 1.00 |
| Bharatiya Nyaya Sanhita | 100% / 0.78 | 100% / 0.96 | 100% / 0.94 |
| Bharatiya Nagarik Suraksha Sanhita | 86% / 0.79 | 86% / 0.75 | 100% / 0.86 |
| Price schedule, 4,500 rows | 50% / 0.50 | 100% / 0.52 | 100% / 0.80 |

## 11. Architecture and hosting

- **Next.js on Vercel**: UI, API routes, search. Uploads go browser-to-storage
  via signed URLs so Vercel's request-body limit never applies.
- **Python worker (FastAPI)**: parsing, chunking, model calls, embeddings,
  zonal OCR. PyMuPDF, Tesseract and OpenCV do not fit a Vercel function's time
  and bundle limits, and a 300-page ingest is minutes of work. Deployed as a
  Docker container (Railway, Fly, Modal, any VM).
- **Supabase**: Postgres with pgvector and full-text search, plus Storage for
  PDFs, page renders and figure crops.

**Why not chunk in TypeScript?** The Python PDF ecosystem is years ahead on
layout analysis and OCR. Keeping the worker in Python and the UI in
TypeScript is the standard split.

**Why chunk at all when context windows are a million tokens?** Cost per
query, latency, precision across many documents, and pointing at the exact
row or figure. Whole-document reading suits one-off analysis; chunking suits
search.

## 12. What I would do next

1. Put a layout model (docling or pymupdf-layout) in front of the row logic
   for messy schedules and scanned tables.
2. Run the context step through the Batches API and add prompt caching for
   the system prompt.
3. Add an image embedding per figure for image-to-image search.
4. Add a reranker (cross-encoder) over the fused top 50 when latency allows.
5. Per-template OCR evaluation: a labelled set of scans with known values,
   reporting field accuracy per source (Tesseract vs model).

## 13. From comparison to product

**Decision (2026-10-15).** The app stopped being a side-by-side demo of three
chunking strategies and became one product: Documents, Search, Forms.

- One pipeline is stored per document (the one that won the comparison in
  section 10). Ingest is three times cheaper and faster than storing three.
- Search returns one list and, on top, a short answer written by Haiku from
  the passages found, with numbered citations that jump to the source and
  open the page. A business reader asked "is theft bailable?" wants the
  sentence, not six passages to read.
- The evaluation and documentation pages are gone from the UI; the
  measurement lives in `scripts/eval.py` and this file.
- Plain words everywhere: passages, not chunks; "Finding tables and figures",
  not "parsing layout"; no scores, token counts or model names on screen.
- Guard rails for a public URL: per-client rate limits on every paid route,
  size and length caps, resumable embedding, model fallbacks (README,
  "Guard rails"). No login: the demo is meant to be opened from a link.

**Why not keep the comparison as an "advanced" view?** Because every extra
concept on screen is a question in the interview that is not about the
problem being solved. The comparison is the story of how the pipeline was
chosen; it belongs in the conversation and in these notes, not in the product.
