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

## 14. Stress test on real pharmaceutical documents

**Why.** The samples were written to exercise known failure modes. Real
documents fail in ways nobody planned for, so on 2026-10-15 six public pharma
PDFs went through the product unchanged: the FDA Humira prescribing
information (100 pages, dosing tables, adverse-reaction tables, illustrated
instructions for use), the WHO GMP main principles (TRS 986 Annex 2, 60 pages
of numbered clauses), two NPPA ceiling-price gazette notifications (English
and Hindi, ruled tables), the CDSCO list of new drugs approved in 2024 (a
two-page ruled table that breaks across the page) and an Indian Pharmacopoeia
draft monograph (Rifaximin tablets, every page under a diagonal "DRAFT FOR
COMMENTS" watermark). Thirteen questions a pharmacist or a pricing analyst
would ask were run across all documents at once.

**What held.** Every question was answered correctly with the right citation:
the ceiling price of Tacrolimus 1 mg (Rs 39.98) and Temozolomide 250 mg
(Rs 3,757.94), the oxaliplatin vial price, the CDSCO approval dates and
indications, the WHO rules on self-inspection, dedicated facilities for
penicillins and reference-standard labels, the Humira Crohn's induction dose
(160 mg, then 80 mg, then 40 mg), the 14-day room-temperature limit and the
paediatric maximum dose. The layout parser produced the right tables and rows
on all of them without any document-specific rule.

**What broke, and the generic fix for each.**

1. *Every ruled table also became a figure.* Table borders are zero-area line
   segments sitting exactly on the table's edge; the figure detector's table
   exclusion tested area overlap, which is zero for a line. Each table then
   cost an Opus vision call that described "a table listing four new drugs".
   Exclusion now uses a 3 pt tolerance, and a cluster that mostly overlaps a
   table is dropped.
2. *A watermark swallowed a monograph.* The diagonal "DRAFT FOR COMMENTS" is
   vector text covering half the page; it clustered into a figure, the page's
   text became its "labels", and the dissolution test lived only inside a
   figure description. A vector-only cluster whose area is more than a fifth
   text is now treated as decorated text, not a figure.
3. *Fifty-eight figures in a text-only guideline.* The WHO running header is
   drawn with hairlines; every page produced a 5%-of-page "figure" and an
   Opus call. Clusters made only of hairlines, and full-width thin bands, are
   never figures.
4. *A row lost at a page break.* PyMuPDF names the first row of every ruled
   table its header; on the CDSCO continuation page that row was drug number
   5, and the merge kept it as a header. The header of a continuation page is
   now put back as data unless it reads like a header (short cells, no long
   numbers). The "(1) (2) (3)" column-number row of gazette tables is dropped
   from ruled tables as it already was from ruling-free ones.
5. *A hung model call stalled a document for ten minutes.* Two context calls
   for the price schedule never returned; the SDK waits 600 s per attempt.
   The client now times out at 120 s.
6. *A network blip returned a server error from search.* One connect timeout
   to the embedding provider surfaced as a 500. Query embedding now retries
   with an 8 s limit and falls back to keyword search, and the response says
   so.
7. *Exact codes lost to long passages.* After the single-pipeline re-ingest,
   "ceiling price of F-11000" ranked two 900-token table parts above the one
   row that contains F-11000, because keyword rank rewards many header-word
   hits and ignores length; "how is theft defined" found five sections that
   mention theft before the one headed "Theft". Migration
   `20261015000000_fts_codes_headings.sql` weights the context (breadcrumb and
   situating sentence) above the body, ranks chunks containing every
   digit-bearing query token first, and normalises ranks by length. Recall@5
   on the samples went back to 100% on all four sets.

**Cost and time, before and after** (same documents, same machine):

| Document | before | after |
|---|---|---|
| CDSCO new drugs 2024 (2 pp) | 93 s, 2 vision calls, row 5 lost | 20 s, 0 vision calls, 6 rows |
| NPPA notification (2 pp) | 1 spurious figure, "(1) (2)" row | 0 figures, 9 rows |
| Rifaximin monograph (3 pp) | 4 figures, 2 text passages | 0 figures, 6 text passages |
| WHO GMP (60 pp) | 121 s, 58 vision calls, 58 junk figures | 50 s, 0 vision calls, 80 text passages |
| Humira label (100 pp) | 201 s, 59 vision calls, 60 figures | 181 s, 49 vision calls, 49 figures (the illustrated instructions for use; 11 decorations gone) |

After the fixes, 12 of the 13 questions had their source passage at rank 1
and the thirteenth (tirzepatide's approval) was answered correctly from the
row at rank 1 as well; the only miss was my own check string, which expected
the date in one format.

**Legacy-font pages (fixed the same day).** The Hindi half of the NPPA
notification is set in a Kruti Dev style font: the PDF has a text layer, but
it is the font's private glyph codes, which PyMuPDF maps onto Latin Extended,
IPA and combining characters ("राçĚȣय औषध मूãय"). No search can match that.
The rule: count, per page, the share of letters that land on those code
points (Latin Extended A/B, IPA, the combining-diacriticals block, Latin
Extended Additional); above 8% the text layer is mojibake and the page is
rendered and read with Tesseract's `hin+eng` models instead, exactly as a
scanned page would be. Plain accented letters and a script's own marks
(Devanagari virama, nukta) are not counted, so French or clean Unicode
Hindi never trips it; across the seven samples and the six stress documents
the rule flags exactly the two Hindi pages. Ruled-table and figure detection
are skipped on such a page because they read the PDF's own text. After the
change, "ऑक्सालिप्लैटिन इंजेक्शन की अधिकतम कीमत क्या है?" is answered in Hindi
with Rs 4,979.68 from the Hindi table, and the English question still lands
on the English row. Tesseract reads the digit 1 badly in that font (2023
becomes 203), so quantities on such pages deserve a check against the
English half when there is one.

**Still open.** A figure on a page without raster images still costs one
Opus call; cheap pre-classification (is this a chart, a photo, a logo?) would
cut that. The question set is thirteen hand-written questions; a labelled
set per document type is the next step before any number is quoted as a
benchmark.

## 15. The Quartz design system

**Decision (2026-10-15).** The UI moved onto Quartz from design.how
(https://design.how/systems/quartz), installed through its shadcn registry:
tokens and scoped base styles, the components the screens need, the Quartz
skill for coding agents and the Quartz lint. Every screen was ported one at a
time on a run branch, verified at 390 and 1280 against the skill's rules and
the lint, and landed as its own commit; the reviews and the decision ledger
are in `web/.ui-review`.

What changed in the product's look: one framed list of rows instead of grey
cards per document, status as a word with a small arc while running instead
of a tinted pill, ink for exactly one primary button per view, kind hues only
in labels and selected rows, and no shadows, glass or pills anywhere. What
did not change: behaviour and copy.

Three places needed a judgement, each logged in the ledger:

- Quartz's page shell names a sidebar, but the registry ships none, so the
  shell is a top bar with the three places as text links and a PageHeader
  per screen.
- Quartz has no hotspot or drawing surface. A passage drawn on a page is a
  kind-lined region holding a stretched ItemLink to the passage, and the
  forms canvas keeps its pointer handler as the one custom region.
- Passage types borrow the five kind hues (text, table, figure, form) so a
  row's badge and its box on the page match.

The installed design-system code under `web/src/components/quartz` and
`web/src/lib/quartz` is kept as the registry ships it and excluded from the
project lint; the Quartz lint (`npx eslint -c quartz.eslint.config.mjs .` in
`web/`) reports nothing.

## 16. One cheap look before every figure description, and a labelled benchmark

**Why.** Section 14 left two things open: a figure on a page with no raster
image still cost one Opus call, and the thirteen stress questions were
hand-written, so no number could be quoted as a benchmark.

**The look.** Every figure crop now goes to Haiku first with one question,
which kind of region is this, answered in one word: photo, chart, diagram,
drawing, map, table, text, logo, decoration or blank. Only logo, decoration
and blank are dismissed, and never when the figure has a caption or a figure
number; a dismissed figure gets no Opus description and leaves the document
altogether, so no junk passage is stored and the sequence closes over the
gap. Anything with arrows, callouts, labels or measurements is told to count
as a photo, diagram or drawing, so annotated images are always described in
full as before. The look costs a fraction of a cent and adds under a second
per figure. On the thirteen documents it kept all 49 Humira instruction
figures and both inspection photos, and dismissed one: the Gazette of India
emblem on the first page of the Bharatiya Nyaya Sanhita, which had been
described by Opus at every ingest and stored as a figure passage nobody would
search for. The geometric rules from section 14 already remove hairline
boxes, bands and watermarks before any model sees them, so on this set the
look is a safety net; its value is on letterheads, seals and vector
decorations that pass those rules.

**Glossary passages.** The first benchmark pass missed one WHO question, the
definition of "starting material", because the glossary chunk holding three
definitions carried a context that said only "the final portion of the
glossary", so it ranked seventh behind Section 14 passages that mention
starting materials. The context prompt now asks the model to name every term
a passage defines when it reads like a glossary or a definitions section.
After re-processing, that passage's context lists "standard operating
procedure (SOP)", "starting material" and "validation", and it ranks first.

**The benchmark.** `scripts/make_questions.py` writes a labelled set per
document: passages are sampled across the pages and kinds, Sonnet writes a
question a pharmacist, pricing analyst, regulatory officer, QA manager or
lawyer would ask that the passage answers, and names the shortest exact
phrase from the passage that the right answer must contain, at most six
words; a phrase that is not in the passage verbatim, or that already appears
in the question, is rejected and the model is asked once more. The sets are
saved under `scripts/benchmarks/` so a reset does not lose them, and
`scripts/eval.py` runs them through the live search. On 2026-10-15, 98
generated questions plus the 28 hand-written sample questions, over 13
documents:

| Document | questions | recall@5 | MRR |
|---|---|---|---|
| Bharatiya Nyaya Sanhita 2023 | 23 | 100% | 0.96 |
| Bharatiya Nagarik Suraksha Sanhita 2023 | 18 | 94% | 0.90 |
| QC inspection report | 16 | 100% | 0.97 |
| NPPA notice, Apollo | 12 | 100% | 1.00 |
| WHO GMP, TRS 986 Annex 2 | 12 | 92% | 0.78 |
| FDA Humira label | 11 | 100% | 0.84 |
| Pharma price schedule | 9 | 100% | 1.00 |
| NPPA ceiling-price notice 2024 | 8 | 100% | 1.00 |
| Rifaximin monograph | 6 | 100% | 0.83 |
| CDSCO new drugs 2024 | 4 | 100% | 1.00 |
| Pharmacy bills (three) | 7 | 100% | 0.93 |
| All documents | 126 | 98% | 0.93 |

The two misses are instructive rather than alarming. "Which clause of the
BNSS deals with the Directorate of Prosecution" expects the entry in the
arrangement of clauses, and the search returns the section itself, which
answers the question just as well; the label is stricter than a reader would
be. "Which earlier annex does the revised GMP document replace" lives in one
preamble sentence that no passage context mentions. The WHO document's mean
reciprocal rank of 0.78 says the same thing from the other side: long
guideline prose with many near-duplicate clauses is where ranking is weakest,
and the glossary fix above is the kind of change that moves it.

**What the numbers are not.** The questions were written by a model from the
passages, so they are phrased close to the document's own words, which flatters
keyword search; a set written by the people who use these documents would be
harder. The numbers are a floor to regress against, not a ceiling to quote.

