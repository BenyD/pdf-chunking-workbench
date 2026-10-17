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


## 17. A labelled value is never a heading

**Why.** On the second pharmacy bill the line "Grand Total: Rs. 500.64" is set
bold and a size larger than the body, which is exactly what the heading rules
look for, so it became a level-3 heading: the breadcrumb of the disclaimer
under it carried "Grand Total: Rs. 500.64", and no passage's own text held
the amount. A search for the grand total found the subtotal passage instead.

**Rule.** Before any heading rule runs, a short block that reads as a
labelled value is left as text: a "label: value" line whose label is at most
forty characters and whose value holds a digit, or a line that ends in an
amount (a currency mark or a figure with two decimals). "3. Findings",
"CHAPTER II" and "Dosage and Administration" still become headings; "Invoice
No: SP/2026/04452" and "Subtotal 447.00" never do. After re-processing, the
totals passage of the bill reads subtotal, GST and grand total together.

## 18. What it costs, measured

**Why.** The question a business asks first. The worker now tallies the
tokens of every model call made for a document (a context variable set for
the ingest, read into `stats.llm.tokens`), so each document carries what it
cost, and the README quotes measured figures against the prices read from
the pricing pages on 2026-10-15 rather than remembered ones.

**Two settings changed while measuring.** The one-word look at a figure
was made with a ten-token output budget and low-effort thinking; the
model's short thinking block used the budget and the word never came, so
the look returned "unknown" and the expensive description ran anyway. With
thinking disabled it answers in five tokens. The context line spent 187
output tokens with low-effort thinking and 125 without, for the same two
sentences; output is five times the price of input, so thinking is off for
both bulk calls. The figure description and the OCR fallback keep
medium-effort thinking: they are the judgement calls.

**The shape of the bill.** Text and tables are cheap: a 297-page act is
twelve cents, a 151-page table nine, a one-page bill a twentieth of a cent.
A question on Search is four hundredths of a cent. Figures are the cost:
each Opus description is about a cent and a half, so a 100-page label with
49 illustrated steps is seventy cents, 95% of it figures. The cheap look
before each description only pays when a document carries emblems or
decorations; on photographs it is a tenth of a cent of insurance.

**Levers, in order.** Batch API for bulk imports (50% off every ingest
call, ingest is asynchronous already). Sonnet for figures where callouts do
not matter (half of Opus). Caching by image hash and passage hash so a
re-ingest costs nothing. None of these is switched on: the demo should
show the best reading, and the numbers above are already small.


## 19. Forms: read first, teach second, landmarks taken automatically

**Why.** The three-step page exposed every mechanism at once (values,
landmark words, word outlines, kinds, patterns, templates, scans, the
model fallback) and asked for all of it before anything could be read.
Even its author found it confusing. What people do with it is mostly one
thing, read a scan with a form already taught, and only sometimes teach.

**Shape.** The page opens on "Read a scan": pick the form, pick the scan,
press Read. The values come back as a plain list, each with a check word,
and a sentence on what happened to the scan. "Teach a new form" and "Edit
this form" open the one other view: a clean copy to drag boxes on, a hint
on the page until the first box is drawn, and a list where each box gets a
name and a kind, with the name box taking the focus as soon as the box is
drawn. The printed label beside each drawn value (the word to its left on
the same line, read once from the page by OCR) becomes the landmark the
form is found by on a scan, so landmarks are never explained unless a
person opens "Change the words". Patterns and word outlines left the
screen; the data keeps them. The sample form's values are named in plain
words ("Invoice number", "Grand total") rather than keys.

## 20. One box over a block of values, and many scans at once

**Why.** Drawing and naming one box per value is slow when a form has a
header block of eight labelled lines, and reading one scan at a time is not
what anyone does with a form template.

**Splitting a box.** The printed words of the clean copy are already read
once per page while teaching. A drawn box is now split by them: the words
inside are grouped into lines, a line is cut into columns at wide gaps
(never right after a label's colon, since a label and its value can sit
far apart), and each piece is split into label and value at the colon or
its widest gap. Every value becomes a field named by its label, with the
kind the value's shape suggests (a date pattern, an amount with decimals or
a currency mark, a bare integer, else text), and every label becomes a
landmark word. Two drags over the sample bill, the header block and the
totals block, yield Invoice No (text), Date (date), Patient, Patient ID,
Subtotal, GST 12% and Grand Total (amounts), found by six printed words;
read against the crooked scan and a second bill they come back 7 of 7
checked on both. A box that holds no label is still one plain value to
name, with the label beside it as its landmark, as before.

**Many scans.** The read view takes a list of ticked scans rather than one,
reads them two at a time with the same form, and fills one table as each
lands: a row per scan, a column per value, a check count, and a "Show" that
puts that scan's page with its boxes and sentence underneath. The table
downloads as a CSV. A saved form can be deleted behind an alert dialog.

## 21. Forms, rebuilt as four steps after looking at the field

**Why.** Every rewrite of the Forms page so far kept one screen doing
everything. Even its author called it confusing. Before rebuilding it a
third time, the established document-capture products were read for how
they structure the same job.

**What they do.** Microsoft's AI Builder walks through define the fields,
group documents into collections, let it analyse them, tag by drawing a
rectangle and picking the field, then train and publish
(learn.microsoft.com/ai-builder/create-form-processing-model). UiPath's
Template Manager asks for a document type, a name "that reflects the
version or layout", a sample document, zones with field names and data
types, anchors with a tolerance, then test and publish
(docs.uipath.com, data-extraction-form-extractor). Nanonets defines fields
with descriptions, uploads samples, annotates, trains, and reviews per file
with Approve or Review buttons, then exports (docs.nanonets.com, interface
overview). Rossum's validation screen puts the value, its confidence, the
source and the document side by side, marks fields it has already checked
with a grey tick, and routes by threshold so a reviewer fixes only the
flagged fields (knowledge-base.rossum.ai; lilting.ch on confidence-based
review). The zonal-OCR explainers (ABBYY, Klippa, Lido, OpenKM) agree on
the sequence: sample, zones named and typed, anchors, test, publish, and
warn that layout drift is the main failure mode.

**The shape chosen.** A forms list, a four-step wizard, and a reading page,
each with its own address so the browser's back button works and a step
can be linked to.

1. *Clean copy*: name the form, pick the document it is taught on, see the
   page. One name per layout, as UiPath advises.
2. *Values*: "Find the values for me" turns every "label: value" line on
   the page into a named, typed field in one press; a drag over a value or
   a block of them does the same for that region; a drag over a bare value
   gives one field to name. Labels become the words the form is found by.
   The anchor tools stay behind "Change the words".
3. *Test*: read one scan, see each value with its check word and the boxes
   on the scan, go back if a box is off. The test does not store a record.
4. *Save*: a summary of name, copy, values, words and the test, then one
   button. Editing a saved form walks the same steps and saves in place,
   so its past reads stay attached; deletion sits here behind an alert.

The reading page is the Rossum pattern made small: tick scans, read them
two at a time into one table with a check count per row, a "Show" that
puts the scan with its boxes beside the list of values and their check
words, and a CSV download. Inline correction of a read value, with the
correction saved, is the next step this layout leaves room for.

## 22. What the AI adds, measured against the chunking Bedrock offers

**Why.** The interviewers asked why AI is needed at all, suggested
hierarchical chunking on Amazon Bedrock, and want any AI justified by
showing the cheaper approaches failing. `scripts/compare_chunking.py`
chunks every benchmark document each way, embeds them all with the same
model (voyage-4) and runs every question through the same Postgres search,
so the chunking is the only thing that differs. A hit is the expected
phrase in the document's own words (never in a model-written sentence) on
the expected page, in the top five.

| Setup (129 questions, 14 documents) | recall@5 | MRR | tokens in top 5 |
|---|---|---|---|
| Fixed-size 300 tokens, meaning search (Bedrock default) | 84% | 0.78 | 1,324 |
| Fixed-size 300 tokens, hybrid search | 83% | 0.73 | 1,331 |
| Semantic chunking (Bedrock semantic) | 82% | 0.73 | 1,045 |
| Hierarchical 1,500 / 300 (Bedrock hierarchical), meaning | 88% | 0.84 | 3,461 |
| Hierarchical 1,500 / 300, hybrid | 90% | 0.82 | 3,545 |
| Structure-aware, keywords only: no AI at any step | 85% | 0.69 | 1,596 |
| Structure-aware + embeddings: nothing generated | 95% | 0.84 | 1,355 |
| Structure-aware + model context, keywords only | 90% | 0.77 | 1,978 |
| Structure-aware + model context + embeddings (the app) | 98% | 0.88 | 1,790 |

**What it shows.**
- Tables are where generic chunking breaks. On the 4,500-row price
  schedule, fixed-size windows find 33%, semantic chunking 11% and
  hierarchical 44 to 78%; cutting at rows finds 100% even with no AI.
- Hierarchical chunking is the best of Bedrock's options, but partly by
  handing back 1,500-token parents: a reader, or the model writing the
  answer, gets through twice as many tokens for it. Bedrock's own docs
  also advise against hierarchical chunking on its cheapest vector store
  (S3 Vectors).
- With no AI at all, cutting along the document's structure (85%) already
  matches the Bedrock defaults. Adding an embedding model, which generates
  nothing and can run on our own server, takes it to 95%.
- Generated text earns its keep in two places: figures (the Humira label
  goes from 64% to 91%, the maintenance manual from 67% to 100%) and
  isolated rows and passages, through the context line.
- The benchmark questions were written by Sonnet from the app's own
  passages, and five of the expected phrases use the "Header: value" form
  of a table row, which favours our chunking a little. The real Bedrock
  service was not run (the AWS session had expired); the methods are
  rebuilt from Bedrock's documented settings, with our embedding model.

## 23. A bare label on a figure, bound to a key elsewhere

**Why.** Manuals mark parts with a lone letter or number and explain them
somewhere else: "Table 6. Key to Figure 4" two pages on. On its own the
figure says "A, B, C, D" and the table never says where the part is.

**Decision.** `worker/app/chunk/legend.py`. The labels are the short tokens
printed on the figure (A, (b), 3, but never the 4 in "Figure 4" or a lone
"a"). A key is any table whose first or second column holds those labels,
or a run of "A - text" items in the text. It must share at least two
labels and cover most of them; one that names the figure wins; then the
nearest. Bare numbers are everywhere (row numbers, axis ticks), so a
numbered key must name the figure or sit on the same page. The key is
written into the figure's passage, every key row records which figure it
labels, and the key goes to the vision model, which then names each arrow
by it ("arrow C points to the lower punch").

Letters printed as PDF text bind with no model at all. Letters drawn into a
photo are not text; Tesseract could not read circled digits, so they bind
only after the vision model reads them, through the same lookup. The
synthetic tablet press manual has one of each: Figure 4 (printed letters)
is found with no AI; Figure 5 (numbers in the photo) only with it.

## 24. An SOP checked line by line against 21 CFR Part 211

**Why.** The interviewers' example: thousands of company SOPs, each to be
checked against the regulation sentence by sentence, saying what is
missing and why, as cheaply as possible.

**Decision.** `scripts/gap_check.py`, shown on the SOP check page.
- The regulation comes from the eCFR's XML, where each paragraph carries
  its marker, so every sentence is cut at its exact citation (211.170(b),
  sentence 4) and keeps its parents' lead-ins: hierarchical chunking
  driven by the document's own numbering. Declarative sentences count ("The
  reserve sample consists of at least twice the quantity..."); lead-ins
  that only introduce a list do not. A section with no paragraph markers at
  all (211.192, 211.182, 211.204 and 17 others) used to be dropped; it is
  now one requirement. A section that opens with an unmarked paragraph
  ("Written procedures ... They shall include:") passes it to (a), (b)...
  as their lead-in (section 30). Part 211 is 420 sentences in 59 sections.
- Which sections apply to an SOP is measured, not given (below).
- Each requirement's three closest SOP passages are its evidence (below for
  how they are picked).
- Rules decide what they can with no model: lines for products the SOP's
  scope excludes, and lines whose terms are plainly present or absent.
- A small model returns met, partly met, not met or not applicable, the
  SOP's words it relied on, and one sentence saying why.
- Every verdict is kept under its evidence, so a line whose evidence has
  not changed is never paid for twice, and `--batch` sends the rest through
  the Message Batches API at half price.

**Measured** on a synthetic SOP written with known gaps (no reserve
samples of active ingredients, no yearly visual examination, six months'
retention where the rule says a year, a tentative expiry with no
verification), 41 requirement sentences across 211.137, 211.166 and
211.170, the sections now chosen automatically:

| Judge | right | cost for this SOP |
|---|---|---|
| Rules, no AI | 13 of the 15 it was sure of (26 left unsure) | $0 |
| Claude Haiku 5.5, the app's search as evidence (before) | 34 to 36 of 41 over four runs | $0.0075 |
| Claude Haiku 5.5, evidence from the SOP's own words (now) | 34 or 35 of 41 over five runs | $0.0076, or $0.0038 through the Batch API |
| Claude Sonnet 5.5 | 38 of 41 | $0.146 |

Haiku's misses are "partly met" or "not applicable" where "not met" was
expected, with the reason still right ("applies to finished product rather
than active ingredient"). Haiku cannot be run at temperature 0 (it rejects
sampling settings), so the same evidence gives a line or two either way
between runs. Judging a sentence without its paragraph cost three more
misses: the same binding problem as in chunking.

**Which sections apply.** Every requirement sentence is compared with every
passage of the SOP: the sentences' vectors are the ones the check needs
anyway (embedded once for the whole Part and cached), the passages' are the
ones stored at ingest. A section scores the mean of its two closest
sentences and is in scope at 0.65 or more. No model call, and nothing to
pay per SOP.

| Document | sections in scope | next below the line |
|---|---|---|
| SOP-QC-014, the sample | 211.170 (0.71), 211.137 (0.68), 211.166 (0.68), the three it was written against | 211.194 Laboratory records (0.62) |
| SOP-QC-014 revision B | the same three | 211.22 (0.62) |
| SOP-PR-021 equipment cleaning, written after the line was set | 211.182 Equipment cleaning and use log (0.77), 211.67 Equipment cleaning and maintenance (0.67) | 211.105 Equipment identification (0.64) |
| WHO GMP guide (TRS 986 Annex 2) | 33 sections: it covers all of GMP | |
| Maintenance manual, inspection report, monograph, bills, price list, CV | none (best 0.60) | |

Embedding each whole section as one text was tried first and failed: on the
sample 211.137 Expiration dating (0.737) and 211.142 Warehousing (0.723)
came out level, and Distribution records topped even a pharmacy bill. A
whole section holds the vocabulary of all of GMP, so every section looks a
bit like every pharma document; one sentence is specific. Subtracting each
section's usual score in the other documents made it worse (expiry dates
are on every label and price list, so 211.137 fell out of the top seven).
The mean of the two best sentences, not the best one, keeps a long section
from getting in on one stray sentence.

**Held out.** The sample set the line, so five more SOPs were written after
it (complaints, batch record review, incoming materials, label issuance and
line clearance, returned goods), with the sections each should get written
down before any was ingested: core sections that must be chosen, and
neighbours a reviewer would accept. Over all seven SOPs:

| Line | core sections found | accepted neighbours | other extras |
|---|---|---|---|
| 0.68 | 9 of 13 | 0 | 0 |
| 0.65 | 12 of 13 | 1 | 0 |
| 0.62 | 13 of 13 | 11 | 6 |

The miss at 0.65 is 211.82 Receipt and storage on the incoming-materials SOP
(0.633), under 211.110 in-process sampling (0.643), which shares the word
sampling. Lowering the line looks cheap, since an extra section only adds
lines, but it is not: checked at 0.62 through one batch, Haiku called 25 of
the 39 lines from unexpected sections gaps, and 55 of the 78 from accepted
neighbours ("the batch record review SOP says nothing about destroying
excess labels"). It judges each SOP alone and cannot know another SOP
covers the point, so every extra section is gaps a reviewer has to dismiss.
0.65 stays. The cure for both the miss and the false gaps is to check a
company's whole SOP library at once (a requirement is a gap only when no
SOP covers it), not a lower line.

**A verdict kept by its evidence.** The key is (citation, hash of the three
passages and the SOP's scope line, hash of the model, the prompt and the
requirement's wording), in `scripts/benchmarks/gap-cache.sqlite`. Same
evidence, same verdict; a new model, prompt or regulation text never gets
an old one. The key does not include the SOP, so another site's copy of the
same template costs nothing, and a revision only pays for the lines whose
passages changed.

The app's search could not feed such a cache. It ranks by the context line
Haiku writes for each passage at ingest, and two uploads of the same text
get different lines, so its second and third passages swap. Revision B
(section 6 gains a yearly visual examination, the version line moves on)
kept its evidence on 7 of 41 lines, and in 23 of the other 34 only the
filler passages had traded places. So the evidence is now picked on the
SOP's own words only: the cosine of each passage's text vector (cached by
text) plus 0.3 times
the app's keyword rank (`ts_rank_cd`) on the passage text, added, not fused
by rank, so an unchanged passage scores the same against a requirement in
every revision. The title block is left out (it is never evidence and its
version line changes every time), and passages are shown in the SOP's
order. Cosine alone lost section 4 from 211.137(a) and Haiku said "partly
met" three times in three; the keyword rank brings it back. The cost is
about a line of 41 against the app's search.

| Run | lines from the cache | model calls | paid |
|---|---|---|---|
| SOP-QC-014, first time | 0 | 41 | $0.0076 |
| The same, again | 41 | 0 | $0 |
| Revision B | 17 | 24 | $0.0046 |
| The unchanged SOP uploaded again for a second site (new context lines) | 41 | 0 | $0 |

Every one of the 24 re-judged lines had the edited section among its
passages. Three verdicts changed, the three sentences the revision
addressed: the yearly examination is now met, its investigation and its
record partly met (the SOP points to another SOP and a different log).

**Batch.** `--batch` sends every line not in the cache as one Message Batch
(the custom id is the cache key, results are matched by it) and records the
batch in the cache first, so a run that dies while it is out picks the
results up next time instead of paying again. Measured: the four SOPs
above in one batch (the sample, revision B, the second site's copy and the
cleaning SOP), 138 lines but 80 requests, since
58 lines had the same evidence as a line already in it and were judged
once. It ended after 207 s and cost $0.0075 in all.

| SOP | lines | sent | cost as bought | paid by this run |
|---|---|---|---|---|
| SOP-QC-014 | 41 | 41 | $0.0038 (50,288 tokens in, 5,182 out) | $0.0038 |
| Revision B | 41 | 24 | $0.0039 | $0.0023 |
| Second site's copy | 41 | 0 | $0.0038 | $0 |
| SOP-PR-021 cleaning | 15 | 15 | $0.0014 | $0.0014 |

The sample's $0.0038 is exactly half of the $0.0076 the same calls cost one
by one, and Haiku got 35 of 41 through the batch, as it does directly. The
same command run again sent nothing.

**What it costs.** A new SOP like the sample costs $0.0038 through the batch
API, about $0.00009 a line, and its scope sets the bill: 6 to 21 lines for
the six held-out SOPs ($0.0006 to $0.0018 each, measured), 41 for the
sample, 420 if an SOP touched every section of the Part. 5,000 SOPs like
the sample come to about $19 through the batch API ($38 one by one); 5,000
like the held-out ones (15 lines on average), about $6. After that a
revision pays only for the lines whose passages it touched (24 of 41 here,
as the edited section was evidence for every reserve-sample line), and
copies of one template at other sites pay nothing. Choosing the sections
calls no model; embedding a new SOP's passages by their own words costs
about $0.0001 (voyage-4), again only for passages not seen before.

The SOP check page still shows the snapshot of the hand-scoped run;
`--publish` replaces it with the latest run of the sample.

Not built yet: a run over real SOPs (these seven are synthetic and one
page or two each). The library-level check is section 25. Prompt caching
does not apply: the instructions are about 170 tokens, far below the
smallest cacheable prefix.

## 25. A company's SOPs checked as one library

**Why.** Section 24 judges each SOP alone, so a requirement that another
SOP covers comes back as a gap. That kept the scope line at 0.65, which
misses 211.82 Receipt and storage on the incoming-materials SOP. At 0.62,
on the five held-out SOPs, Haiku called 25 of the 39 lines from
unexpected sections gaps, and 55 of the 78 from accepted neighbours.

**Decision.** `gap_check.py --library`. The library is the `--sop` list,
or every ready document whose name starts with `SOP-`, keeping the newest
document of each SOP number (an old revision would meet what the current
one dropped).
- A section is the library's when any SOP scores it at 0.62. Its owner is
  the SOP that scores it highest. (By score, not by place in each SOP's
  ranking: the two differ on 1 of 24 sections here, 211.134, at 0.626
  against 0.625.)
- Each requirement is asked of its owner first. Only if the owner does not
  meet it, it is asked of up to two more SOPs, and only of SOPs whose
  closest passage scores at least the owner's, closest first. The asking
  goes in rounds, one batch each, and stops at the first "met" or at the
  owner's "not applicable".
- The verdict: met if any SOP asked meets it; else not applicable if the
  owner's scope rules it out; else partly met if any SOP goes part of the
  way; else a gap, with the owner's reason. It is reported once, against
  the owner.
- A line asked of an SOP is the same line the per-SOP mode builds (same
  passages, scope line and prompt), so it has the same cache key. A library
  whose SOPs were already checked one by one costs only the extra SOPs
  asked.
- Gaps come in two lists. Line by line: gaps in sections some SOP is
  clearly about (its owner scores 0.65, one SOP's own line, or more). By
  section: the sections no SOP is clearly about (owner between 0.62 and
  0.65), since a gap there more likely means the library has no SOP for
  the section than that the owner falls short.

**Measured** on seven synthetic SOPs: the sample, SOP-PR-021 and the five
held-out ones. That gives 24 sections and 214 requirements. The verdicts
are the cached ones the per-SOP runs used, so only the grouping differs.

Where the per-SOP false gaps went (the five held-out SOPs, at 0.62):

| Per-SOP gaps | met by the section's owner, another SOP | same requirement as a gap the owner already has | still in the line-by-line list | moved to the by-section list |
|---|---|---|---|---|
| 25 in unexpected sections | 7 | 6 | 0 | 12 |
| 55 in accepted neighbours | 6 | 0 | 12 | 37 |

- 13 of the 80 disappear outright, for example the label lines the batch
  record review SOP picked up, which the label SOP meets.
- 6 more were the label SOP's own gaps found a second time; they are now
  reported once, against the label SOP.
- The 12 that stay are 211.186 Master production and control records,
  owned by the batch record review SOP (0.661). The per-SOP run at 0.65
  showed them too.
- The line-by-line list is exactly the per-SOP gap list at 0.65: the same
  59 requirements with the same owners. The lower line adds nothing to it.
  The other 60 gaps sit in the by-section list, 11 sections.

Only 13 disappear because sections barely overlap in this set: 6 of the 24
are in two SOPs' scope. Most neighbour gaps are things no SOP here does at
all: laboratory records, testing and release, records retention,
retesting. They are real gaps of a seven-SOP library. A company's full
library would have SOPs that own those sections, and a section no SOP
scores at 0.65 is the sign of that. No gap on a core line was hidden by
another SOP. Four more SOPs test this claim below.

**The sample's known gaps** still show: 8 of the 9 on the cached verdicts,
7 on fresh ones. The ones missing are Haiku's own misses on the sample
(211.170(a) sentence 2 "met" in both runs, 211.166(b) sentence 2 "met" in
one), not a neighbour's doing. No other SOP's passages came closer than
the sample's on any of its 41 lines, so the sample alone answered all of
them.

**211.82** is now checked. Its owner is the incoming-materials SOP (0.633,
the only SOP near it), and it sits in the by-section list. 1 of its 3
lines is met (quarantine until released). 2 are partly met: the receiving
check never looks at "labeling as to contents" and is not said to come
before acceptance, and storage is not said to conform to 211.80. Fresh
verdicts said the same. No line on the score can lift it into the main
list: 211.110 in-process sampling scores higher on the same SOP (0.643)
and is not its topic (10 of its 13 lines are not applicable).

**Who else is asked.** 177 of the 214 requirements were asked of their
owner only, 37 of a second or third SOP, and 1 of those was met elsewhere.
Asking the two next-closest SOPs whatever their score was tried: 450
verdicts against 268 ($0.0379 against $0.0228 as bought), and 3 more
"met". Two of those borrow a clause from another procedure: a complaint
investigation is "met" by the batch review SOP's deviation records, and a
returned-goods investigation by the complaints SOP. Each hides a core gap.
So only SOPs with closer passages are asked.

**The cache, by library.**

| Library | model calls | paid |
|---|---|---|
| The sample and six others, after the per-SOP runs | 66 (the extra SOPs asked, and 19 lines of sections the sample and SOP-PR-021 had never been checked on) | $0.0054 |
| The same, run again | 0 | $0 |
| The Pune site copy in place of the sample | 0 | $0 |
| Revision B in place of the sample | 15 | $0.0014 |

Revision B changes what section 24 says it should: the yearly examination
is met, its investigation and its record partly met. The by-section list
moves a little between uploads of the same text. 211.194 scores 0.621 on
the sample but under 0.62 on the Pune copy, because the stored vectors
carry each upload's context lines, and revision B brings in 211.22
instead. The line-by-line list stayed the same for the Pune copy, and for
revision B it changed only on lines whose evidence the revision changed.

**What it costs**, through the batch API, for the seven SOPs:

| Mode | lines judged | cost |
|---|---|---|
| Per SOP at 0.65 | 128 | $0.0113 |
| Library at 0.65 | 130 | $0.0115 |
| Per SOP at 0.62 | 254 | $0.0218 |
| Library at 0.62, empty cache | 266, in 3 rounds of 214, 37 and 15 | $0.0226 |
| Library at 0.62, the two next-closest always asked | 450 | $0.0379 |

The run on an empty cache waited 620 s over three batches, against about
200 to 290 s for one. Sending every SOP that might be asked in one batch
would be 282 lines here, 6% more, for one wait.

Here the library costs what the per-SOP check costs, because each SOP has
its own topic. Its cost grows with the number of requirements, not of
SOPs: each requirement is asked of at most three SOPs. A whole library,
however many SOPs it holds, is at most 420 × 3 = 1,260 lines, about $0.11
through the batch API at $0.000085 a line, and near 420 lines when owners
meet their requirements. The per-SOP check pays once for every SOP that
touches a section. That bound is arithmetic. It was not measured on a real
library.

**Four more SOPs, to test the fuller library.** Four more synthetic SOPs,
one page each, were written for topics none of the seven covers: laboratory
records (211.194), finished product testing and release for distribution
(211.165), records retention (211.180) and master production records
(211.186). Before any was ingested, the section each should own and its
lines were written down: 38 lines it should meet and 10 known gaps (no
calibration records, no test for objectionable microorganisms, component
records kept two years from receipt, no calculated excess in the master
record, and others). The same person wrote the SOPs and the expected
results, so this tests the grouping, not how real SOPs are worded.

| Section | owner with seven SOPs | owner with eleven |
|---|---|---|
| 211.186 Master production and control records | batch record review, 0.661 | master records SOP, 0.745 |
| 211.194 Laboratory records | stability (sample), 0.621, by section | laboratory records SOP, 0.740 |
| 211.165 Testing and release for distribution | batch record review, 0.635, by section | finished product testing SOP, 0.731 |
| 211.180 Records, general requirements | complaints, 0.635, by section | records retention SOP, 0.683 |
| 211.110 In-process sampling and testing | incoming materials, 0.643, by section | finished product testing SOP, 0.652 |
| 211.22 Quality control unit | not in the library | finished product testing SOP, 0.625, by section |

The first four went as predicted. The last two were not predicted.

- Of the 60 by-section gaps, 23 are now met and 11 moved to the
  line-by-line list under a new owner. The other 26 did not change. They are
  in the 7 sections no new SOP covers (211.122, 211.105, 211.208, 211.82,
  211.184, 211.87, 211.134).
- In the three sections the new SOPs were written for, 22 of the 31 gaps
  are met. The 9 left are the 7 known gaps there, plus 2 lines Haiku calls
  partly met (211.194(a)(2) sentence 2, 211.165(d) sentence 2).
- Of the 12 gaps in 211.186, 8 are met. The 4 left are the 2 known gaps,
  plus 211.186(b)(4) sentences 1 and 2, which Haiku calls partly met (it
  reads "kilograms or grams" as allowing mixed weight systems).
- All 10 known gaps of the new SOPs show. 6 of their 38 lines to meet came
  back partly met: section 24's miss again, where Haiku wants the
  requirement's own words. One of them, 211.194(e), was met before by the
  stability SOP. It is now asked of its new owner first, and Haiku finds
  that owner's "results are recorded in the stability database" too thin.
  The stability SOP has no closer passage, so it is not asked.
- No core gap of the original seven is hidden. The 47 line-by-line gaps
  outside 211.186 keep their owner and verdict. A new SOP was asked as a
  second SOP on one old line, 211.122(g)(3) sentence 2, and neither SOP
  meets it. The records SOP's "one year after the expiry date" was never
  asked about reserve samples. The sample still gets 35 of 41 right and
  shows 8 of its 9 known gaps.
- The by-section list went from 11 sections and 60 gaps to 8 and 30: the
  26 unchanged, plus 4 in 211.22.
- The line-by-line list went from 59 to 70: 47 unchanged, 16 against the
  four new SOPs (10 known, 6 Haiku's), and 7 in 211.110.

**211.110 shows a limit of the score.** The finished product testing SOP
scores in-process sampling at 0.652, just over the line, so the section
moved into the line-by-line list with 7 gaps against an SOP about finished
product ("only of finished product at end of packing, with no written
in-process controls"). With seven SOPs, the incoming-materials SOP called
10 of its 13 lines not applicable. Neither result is right. The library has
no SOP for in-process controls, which is a real gap of the library, and it
is now reported against the wrong SOP. So a score of 0.65 means only that
some SOP comes nearest to the section, not that the SOP is written about
it.

**What the four cost.** 78 new verdicts through the batch API, $0.0071,
in 3 rounds of 71, 5 and 2 lines (517 s of waiting); 171 came from the
cache. Ingesting the four pages cost about $0.003, for the context lines
Haiku writes. The whole library now takes 249 verdicts as bought ($0.0222),
against 268 ($0.0228) with seven SOPs: owners meet more lines themselves,
so fewer requirements go on to a second or third SOP (196 of 219 asked of
the owner only, against 177 of 214). Checking the eleven one by one at 0.62
would be 340 lines. Adding SOPs did not add cost here, which fits the claim
above that cost follows the requirements, not the number of SOPs.

Not built: a library made from the document control system's current
versions (the newest by SOP number in the name stands in for it), a run on
a real company's SOPs, and the library on the SOP check page.

## 26. No generative AI by default, and meaning search on our own server

**Why.** Quescenta's people do not want AI in the pipeline and want to pay
as little as possible: chunking that is only rules, and no calls to an
outside model. The chunking always was rules (sections 2 to 5); the AI sat
on top of it. The question was what meaning search costs without an API.

**Decision.** Two switches, both defaulting to "no AI":
- Worker `PURE=true`: passages are stored exactly as the rules cut them
  (strategy "structural"); no context line, no figure description, no
  suggested questions, no OCR fallback. Every passage is embedded by
  snowflake-arctic-embed-s, a small open-source model run on the CPU through
  ONNX (fastembed) and baked into the Docker image. Its vectors (384 numbers)
  live in their own column with their own search function, beside the API
  model's.
- Web `NEXT_PUBLIC_AI` unset: search reads those passages, the question is
  embedded by the same local model through the worker's /embed-query, and
  no answer is written: the matching passages, highlighted on their pages,
  are the result. The built-in samples carry a few fixed questions instead
  of model-written ones. If the worker cannot answer in 20 seconds, search
  runs on keywords alone.

**Which model.** `scripts/compare_local_models.py` scores candidates on the
same 129 questions, fused with the app's own keyword ranking:

| Local model | recall@5 | MRR |
|---|---|---|
| snowflake-arctic-embed-s (384) | 93% | 0.78 |
| bge-small-en-v1.5 (384) | 90% | 0.77 |
| either, plus a local cross-encoder re-ranker | 90 to 91% | 0.79 |

Four more candidates (granite-embedding-small, all-MiniLM-L6, bge-base,
nomic-embed) were not finished: their downloads from HuggingFace kept
failing. The re-ranker helped bge-small by a point and cost arctic three,
so it is left out.

**Measured in the app's own search** (`compare_chunking.py`, HNSW index):
92% recall@5, MRR 0.78, 1,371 tokens in the top five; 93% once labels drawn
into figure images are read (section 27). That is above every
Bedrock-style method (fixed-size 84%, semantic 82%, hierarchical 88 to
90%) and between keywords alone (85%) and the full generative setup (98%).
The gap to 98% is figures and lone table rows, sections 22 and 23.

**Cost.** No per-use bill. Indexing the 7,000 benchmark passages took 4.5
minutes on a laptop CPU; on the half-CPU container a 100-page document takes
a few minutes. A question's vector takes a few milliseconds once the model
is loaded; the first question after the container wakes waits a few
seconds.

## 27. Callout labels drawn into an image, read without a model

**Why.** Section 23 bound a figure's labels to their key, but only labels
printed as PDF text; a "2" drawn into a photo or a scanned drawing is
pixels, and only the vision model could read it. With generative AI off,
those figures lost their key.

**What others do.** Auto-ballooning tools for engineering drawings (High
QA, DISCUS) and the published work on circular callouts in drawings
(Maity et al., 2018) and on OCR of engineering drawings (eDOCr, 2023) all
find candidate markers with image processing first and then run OCR on
each crop. Tesseract's own guidance: single-character mode (--psm 10), a
small white border, and enough pixels per character. Contour shape filters
with a tight size range hold up better on photos than Hough circles.

**Decision.** `worker/app/parse/callouts.py`, OpenCV and Tesseract only:
- Markers: closed shapes 20 to 130 px wide, circular or square (4 pi area
  / perimeter^2 of at least 0.70), with some ink inside but not full of it.
  A filled badge touches its arrow, so disc and line merge; a morphological
  opening with a disc wider than a line erases the line and keeps the disc.
- Free labels: a coloured glyph counts only if it stands alone (no letter
  beside it, so not part of a word like "STEP 1") and a leader line of the
  same colour starts right next to it.
- Reading: the inside is cropped past the ring, binarised, enlarged to 64 px,
  bordered, and read as one character or word restricted to A-Z and 0-9, at
  confidence 60 or more. A figure with a single reading has none: callouts
  come in sets, and a key needs two labels to bind.
- `legend.bind_all` reads the image only when the printed labels found no
  key.

**Measured.** `scripts/callout_testset.py` draws ten figures (circled
digits on a photo, black balloons, boxed letters, two-digit numbers, small
markers, plain red letters, filled badges, a serif font, and two figures
with no labels); `scripts/test_callouts.py` reads 28 of 28 labels with none
wrong. On real figures it reads nothing in the inspection report (its
labels are text already) and nothing in the Humira label's 49 illustrations,
which have no callouts; the first version read stray letters out of "STEP
1" and "2.1 mm" there, which is what the stand-alone and leader-line tests
fixed. The manual's numbered photo now binds with no AI: pure mode goes
from 67% to 100% on that document and from 92% to 93% overall. The whole
manual is chunked in 0.4 seconds.

**Not covered.** A bare arrow with no label and no caption still says
nothing without a model looking at the picture. No real manual with drawn
callouts has been tested yet; the interviewers' own files are the next
test.

## 28. When the answer is somewhere else: the document's own links

**Why.** A question matches the passage that names the thing, but the
answer is often in the one it points at. Figure 1 shows the dented bowl;
what was done about it is in a table row two pages on. A section says
"see Table 2". An FDA label says "[see Warnings and Precautions (5.1)]".
A unit number appears in the findings and again in the defect register.
Search finds the first passage and stops.

**What others do.** RegulaRAG (2026) resolves a regulation's
cross-references by rules and follows them at query time. GraphRAG-style
knowledge graphs, built by an LLM, cost far more to build and are not
reliably better than plain RAG for lookups like these (Han et al., 2025).
The document already says where its answers are, so its own references
are the graph.

**Decision.** `worker/app/chunk/references.py`, rules only, at ingest:
- `ref`: a passage's own reference to a figure, table, section, step,
  note, annex or schedule (including the FDA's bracketed form), resolved to
  the first passage carrying that anchor in the same document.
- `key`: a figure's labels and the key rows that explain them (section 23
  and 27), now stored both ways.
- `shared`: a rare identifier (a code such as B-220 or CAPA-0091, or a unit,
  batch, lot, sample or invoice number) found in two to four passages.
  A code on every page links nothing.
- Contents pages are neither source nor target: they name sections without
  being them.
- Links sit in each passage's metadata on both ends, at most eight per
  passage. `scripts/relink.py` rebuilds them for stored documents without
  reading them again.

At search time, the linked passages of the top five results are ranked
against the question (`rank_linked`: local vector, else API vector, else
keyword rank), and up to five are shown under the result that points to
them: "Points to Table 1", "Refers to Figure 1", "Also about Unit 117".
Taking the first two links per result instead missed answers; ranking them
against the question is what makes the links pay.

**Measured.** `scripts/make_crossref_questions.py` drafts questions from
the links: a reader at passage R asks something answered only in the
passage T that R points to. A draft is kept only if its answer phrase is in
T, not in R and not in the question. The first set (29 questions) leaked T's
words into the questions, so search found T directly and links showed
nothing; the hard set also rejects any question with more than one content
word that only T has. 36 hard questions over six documents
(`scripts/eval_links.py`, right passage among those shown):

| Setup | top 5 | top 10 | top 5 + links (passages read) |
|---|---|---|---|
| Keywords only | 69% | 78% | 78% (8.1) |
| The app: local model, no API | 75% | 81% | 86% (7.6) |
| With generative AI context lines | 78% | 83% | 100% (7.6) |

- Links beat showing more results: 86% from 7.6 passages against 81% from
  10.
- On the 129-question set links change nothing (93% for the app, 98% with
  AI): they are only added under results, never in place of one.
- The app's 5 misses with links are all the same kind: the passage that
  points to the answer is not in the top five, so there is nothing to
  follow. With the AI context line on each passage, the referring passage
  is found every time and the link does the rest.

**Is the AI justified here?** Only as an option. Links alone take the app
from 75% to 86% at no cost. The context line adds the last 14 points on
these questions, for about 10 cents per 300 pages, written once at ingest;
nothing is generated per search. If the documents are full of "see Table
7" answers and a missed answer costs more than that, it is worth turning
on. Otherwise links with no AI are the default.

**Not covered.**
- References to another document ("per SOP-QC-021") are not followed:
  links stay inside one document.
- Vague references ("the table above", "the previous step") are not
  resolved.
- A table with no caption and no number cannot be a target.
- The questions were drawn from links the rules found, so a reference
  the rules miss is not counted as a miss here.

## 29. Passages with no text of their own stop coming first

**Why.** The local model scores a short or list-like passage close to many
questions it does not answer. On the live site, "What action was decided
for the bowl in Figure 1 given its rim dent?" across all documents put the
WHO guide's contents line "15. Documentation 115 General 115 Documents
required 116" first, tied with the inspection report's Figure 1. The
chunker cuts the WHO contents pages at their numbered headings, so each
entry is a passage of its own (18 of them), each looking like the start of
its section. A lone "A" left by the layout and a figure whose only text is
"Figure J" do the same.

**Measured first.** `scripts/eval_hubs.py` runs the 129 questions through
pure-mode search and counts, in the top five, contents passages (at least
half "Title ... page" entries) and passages under 40 characters. Before the
change, 32 of the in-document top-five slots were contents passages, and in
9 questions one came first without being the answer; 18 slots held a
passage under 40 characters.

`_is_toc` in `references.py` was not usable as the signal: it needs three
entries in one passage, so it misses 13 of the 18 WHO entries, the
"15. Documentation" line among them, and it flags two Humira results tables
and three passages of prose.

**Decision.** A prior in `hybrid_search_local`, at search time, in SQL
(migration 20261019000000). Nothing is stored and nothing deleted.
- `own_text_length(raw_text)` is a passage's length once contents entries
  are taken out: a title starting with a capital, with no digit or full
  stop, then a page number of up to three digits, then the next entry or
  the end. "15. Documentation 115 ..." keeps 45 characters (its number and
  the page footer). The WHO contents passage that also holds a footnote
  ("previously published in ... No. 961, 2011, Annex 3") keeps 207, and
  that footnote answers a benchmark question.
- A text or figure passage with fewer than 200 characters of its own has
  its fused score scaled by 1 − 0.8 × (1 − own / 200): down to a fifth for
  a passage with none. Tables, rows and records keep their score; a row is
  short by nature and is often the answer.
- When the question mentions a page, contents entries count as the
  passage's own text: "On which page does the subsection on reference
  standards begin?" is answered by the contents page.
- A multiplier, not a rank penalty. Fused scores sit close together (1/61
  for first place, 1/65 for fifth), and a hub that is in both lists gets
  two shares; pushing its rank down 40 places in each list still left 17
  to 20 contents passages in the top five.
- In SQL rather than a flag written at ingest, so every stored passage on
  production is covered without reading documents again or redeploying the
  worker. It runs only on the fused candidates (at most 64 rows); the
  query took 25 ms locally.
- Tried offline on the candidate lists first: limits of 60 to 300
  characters, weights of 0.3 to 0.9. 300 characters lost up to 6
  questions (real short passages pushed out); 200 with 0.8 lost none.

**Result.** 129 questions, top five, pure mode (`scripts/eval_hubs.py`;
production through its API with `--base`):

| | local before | local after | production before | production after |
|---|---|---|---|---|
| Recall@5, in the question's document | 93.8% | 94.6% | 92.2% | 93.8% |
| MRR, in the question's document | 0.774 | 0.795 | 0.767 | 0.802 |
| Recall@5, across all documents | 86.8% | 89.9% | 89.9% | 93.0% |
| MRR, across all documents | 0.713 | 0.753 | 0.722 | 0.769 |
| Contents passages in the top five, in-document | 32 | 3 | 34 | 3 |
| ... ranked first without being the answer | 9 | 0 | 9 | 0 |
| Under 40 characters in the top five, in-document | 18 | 0 | 22 | 0 |
| Contents passages in the top five, all documents | 42 | 3 | 44 | 3 |
| Under 40 characters in the top five, all documents | 39 | 0 | 30 | 0 |

Local and production differ a little because the local copy is an older
ingest (it still has the BNSS "5" and "A" fragments). The three contents
passages left are answers (the footnote and the "which page" question). No
question left the top five. Questions that moved (the full list prints
from `eval_hubs.py` with no arguments):
- Up in their own document, on both: eight WHO questions (record
  retention, pest control, what a label shows, who releases contract
  production, how to alter an entry, the reference-standards page, the
  term for "the totality of systematic actions", the earlier annex), half
  of them from second place to first, one from outside the top five.
- Up across all documents: the BNSS compounding question and the
  maintenance manual's "arrow marked D" come into the top five; Figure 1's
  red arrow and the scanned bill's grand total move to first.
- Down: locally, "How is cheating defined?" (BNS) went from first to
  second in its document, and one rifaximin question from first to second
  across all documents. Nothing went down on production.

The reference links still pay as before: with links, 97% on the first
cross-reference set and 86% on the hard set, both unchanged. On the hard
set the plain top five went from 75% to 72%: one question's labelled
answer is the WHO contents line "Good manufacturing practices for
pharmaceutical products 90", which the "Section 2" link points at; it is
still found through that link. Both are fixed since (next).

**The links use the same rule (2026-10-18).** `_is_toc` in
`references.py`, which keeps contents out of the reference links, now
takes a text passage for contents when at most half of it is left once
`own_text_length`'s entries are taken out, or when it opens with
"Contents". A second entry pattern, a section number then its title with
no page ("5.1 Serious Infections 5.2 Malignancies"), covers the Humira
label's contents. Of the 7,087 local passages it flags 20: the 18 WHO
entries and the two Humira ones. None of the old rule's five false
positives are flagged: two Humira results tables, the BNSS clause notes
on pages 288 and 292, and a Humira paragraph on page 27. The WHO passage
with the footnote keeps 197 of its 449 characters, so it is contents
here. It is no link's source or target, and search still finds it,
because search does not read this flag. `scripts/relink.py`, run locally
and with `--rest` on production, changed the same links on both:
- "Section 2" in the introduction (page 3) now leads to section 2's first
  passage (page 14), not to its contents line (page 1). "Section 11"
  (page 15) leads to page 27, not page 2.
- The BNSS clause notes now link to the sections they name, and the two
  Humira tables are targets for "Table 4" and "Table 7". No link was
  dropped.
- The hard question on Section 2's title is relabelled with section 2's
  first passage ("GMP is that part of quality management which ensures
  ...", page 14). The heading itself sits in that passage's breadcrumb,
  which the benchmark does not read.

With links, the app scores 97% on the first set, 86% on the hard set and
93% on the 129 questions, all unchanged. The plain top five on the hard
set changes through the relabelled question alone. The app now finds
section 2's start directly (72% to 75%). The generative setup found the
contents line by its words and now reaches section 2 only through the
link (78% to 75%; still 100% with links). `eval_hubs.py` (run "relinked")
gives the same in-document recall@5 (94.6%) and MRR as "after".

**Not covered.**
- Contents without page numbers (the BNSS "Arrangement of clauses", the
  Humira label's numbered contents) are not caught by the search prior.
  The links catch the Humira one (above). Neither showed up as a hub on
  the benchmark.
- The Hindi passages of the NPPA notices are the next hubs: the model reads
  English only, so their vectors sit near everything. Across all documents
  they take 19 top-five slots in 8 questions, before and after.

**Re-run of the comparison (2026-10-18).** The prior works inside the
candidates the SQL draws, four times the results asked for, so the count
asked for now changes the order. `compare_chunking.py` asked for 5; the
search page asks for 8. At 5 the app scored 95%, at 8 it scores 93% (120 of
129), the same as before the prior, with the right passage ranked higher
(MRR 0.78 to 0.81). Every setup in the comparison is now searched with 8
and scored on its top five, so the numbers are the ones a user of the
search page gets:

| Setup | recall@5 | MRR | tokens read |
|---|---|---|---|
| Fixed-size 300, meaning / hybrid | 84% / 78% | 0.78 / 0.72 | 1,324 / 1,331 |
| Semantic chunking | 82% | 0.73 | 1,045 |
| Hierarchical 1,500 / 300, meaning / hybrid | 89% / 87% | 0.84 / 0.80 | 4,372 / 4,490 |
| Our structure, keywords only | 86% | 0.70 | 1,597 |
| The app: local model, no API | 93% | 0.81 | 1,511 |
| Our structure + embeddings API | 95% | 0.85 | 1,371 |
| With generative AI | 98% | 0.87 | 1,802 |

Hierarchical reads more than before (3,461 tokens at 5) because eight
children bring in more distinct parents. The cross-reference sets are
unchanged: the app 75% to 86% with links on the hard set, 93% on the main
set with or without them.

## 30. The SOP check with no AI, measured

**Why.** The SOP check (sections 24 and 25) was the last feature that still
needed AI: voyage-4 embeddings, through an API, chose each SOP's sections
and its evidence, and Claude Haiku judged every line. The interviewers want
no AI and the lowest cost. Two questions: what does pure mode cost in
accuracy, and how many lines still need a person?

**Decision.** `gap_check.py --local`, and `--judge` to pick who decides.
- The SOP's passages are the ones pure mode stores (strategy 'structural',
  exactly as the rules cut them). An SOP ingested with AI on gets them built
  from its PDF by the worker's own chunker, with no model.
- Vectors come from snowflake-arctic-embed-s on this machine's CPU: the
  stored `embedding_local` for scope, and the passages' own words for
  evidence, as in section 24.
- `--judge rules`, the default with `--local`, calls no model. `--judge
  cascade` keeps the rules' sure verdicts and sends only the lines they leave
  unsure to Haiku (through the Batch API with `--batch`). `--judge model` is
  Haiku on every line, the default without `--local`, as before.
- `scripts/gap_modes.py` runs every mode on the same 14 SOPs and prints what
  each decides, gets right, leaves for a person and costs.

**Choosing sections with the local model.** Its cosines are squeezed: every
section of Part 211 scores 0.67 to 0.84 against every SOP, so no line
separates an SOP's topic from GMP vocabulary in general. Two changes fixed
it, neither calling a model:
- A words score: the cosine of the SOP's tf-idf vector with each section's
  (the section's title counted three times plus all its sentences, cut to
  six-letter stems, idf over the 59 sections).
- A background: each section's usual score over every other stored
  document, leaving out copies and revisions of the same SOP number, is
  subtracted.

The score is words + 2 × meaning − usual, in scope at 0.275 for one SOP and
0.20 for a library. The line was set on the seven SOPs of section 24, then
checked on the four of section 25, on three SOPs written after this
section's rules (below), and on nine documents that are not SOPs:

| Scope rule | 7 SOPs: 13 core sections | extras | 4 later SOPs | 3 held out | not SOPs | WHO GMP guide |
|---|---|---|---|---|---|---|
| voyage-4, cosine 0.65 (before) | 12 | 1 neighbour | 4 of 4, 3 extras | 6 of 6, 4 extras | 0 | 34 |
| Local cosine alone, at its best line (0.80) | 13 | 26 | 4 of 4, 23 extras | not run | 24 | 51 |
| Words alone, minus usual | 12 | 5 | 4 of 4, 3 extras | not run | 5 | 8 |
| Words + 2 × local cosine, minus usual (now) | 13 | 2 neighbours, 211.142 | 4 of 4, 1 extra | 6 of 6, 1 extra | 0 | 29 |

The first and last rows are measured with the Part read in full (below,
"Items under an unmarked opening paragraph"); the two in between were
measured before that fix and not run again.

- The local scope finds all 13 core sections. Its one miss before the fix
  was 211.188 Batch production and control records on the batch record
  review SOP (0.19, when the section had 2 sentences; 0.42 with its 17).
  voyage-4's miss is 211.82. The two neighbours are 211.122 on the label
  SOP and 211.208 on the returned goods and salvage SOP, both accepted by a
  reviewer. The extras the fix brought: 211.142 Warehousing procedures on
  the incoming-materials SOP (0.305; it is about finished products, not
  components), and 211.188 on the master record SOP (0.305) and the
  in-process controls and yield SOP (0.31), which a reviewer may accept.
- Revision B and the Pune copy get the sample's three sections.
- Scoring every stored document for the background takes about a second
  per run.

**Evidence.** The passages are the same text in both modes; only the
vectors that pick the three closest differ. On the seven SOPs the local
picks agree with voyage-4's on 81% of the evidence slots, at the same 0.3
keyword weight. More keyword weight gained a few points and was not kept.

**A stronger rules judge.** In order:
1. Not applicable: a sentence that only grants an exemption or a waiver
   (it asks nothing of an SOP that does not claim it); a requirement, or
   the lead-in above it, about a product class the SOP's scope excludes,
   or one that is never a tablet or capsule (sterile, radioactive,
   allergenic, reconstituted) when the SOP covers only those; a requirement
   only for products exempt from expiry dating, when the SOP dates every
   product.
2. Not met: the requirement needs something the SOP never mentions under
   any usual name. A small thesaurus of some 20 GMP words covers this: an
   active ingredient (API, drug substance), a visual examination, an
   investigation, a yearly frequency, deterioration, a calculation and the
   like. A word offered as one of alternatives ("tests, or examinations")
   is needed only when the SOP has none of the others.
3. Numbers: a retention period shorter in the SOP than in the rule ("six
   months after the expiry date" against "1 year"), for the same event and
   the same subject, is partly met. So is "whichever is longer" with only
   one of its events. A period at least as long counts toward met.
4. Words: met when one passage holds 70% of the requirement's terms.
   Forms of a word and synonyms count. The regulation's filler ("to
   assure", "drug"), purpose clauses, exceptions and cross-references are
   left out. It is never met when a listed item ("date, time, product, and
   lot number") is missing from that passage, or when the passage's
   sentence says the thing is not done. Nor for an item under a lead-in
   with one or two terms of its own ("Dates;"; below, "Short items").
5. Lead-ins ending in ":" and items of "one of the following" are left
   unsure, as is everything else.

| Rules judge | sample: decided, right | 324 lines of the 11 SOPs with a cached Haiku verdict: decided, agreeing with Haiku | 3 held-out SOPs: decided, right |
|---|---|---|---|
| Before | 15, 13 | 154, 104 (68%) | not run |
| New, when first frozen | 34, 34 | 106, 98 (92%) | 6, 3 |
| After three fixes the held-out SOPs showed were needed | 34, 34 | 100, 92 (92%) | 2, 2 |

Agreement counts "partly met" and "not met" as the same call, since both
show a gap. Haiku is itself wrong on some of these lines (35 of 41 on the
sample), so 92% is agreement, not accuracy.

**Held out.** The rules were tuned on the sample and checked against
Haiku's verdicts on the others, and the disagreements were read, so
neither number above is clean. Three more synthetic SOPs were written
after the rules were first frozen, each with known gaps, and the verdict
of every line was written down before any of them was ingested
(`scripts/benchmarks/gap-heldout.json`;
`samples/generate/make_gap_heldout.py` makes the PDFs):
- in-process controls and yield (211.110, 211.103),
- personnel training and hygiene (211.25, 211.28),
- production procedures, deviations and reprocessing (211.100, 211.115).

The first run decided 6 of 33 lines and got 3 right. All three misses were
general flaws: "tests, or examinations" read as needing an examination,
"Bioburden is not tested in process" read as met, and a locked reject cage
not seen as quarantine. With those fixed (alternatives, negation, and
segregation and cages counted as quarantine), the rules decide 2 of 33,
both right. That second number is no longer held out.

So the rules are accurate but narrow. They settle what Part 211 says
mechanically: exemptions, excluded products, a missing act, a shorter
period. The sample's three sections are full of those (18 of its 41 lines
are not applicable). Personnel, in-process and procedure sections are not.

**Four ways, measured** (`gap_modes.py`, 14 SOPs, Haiku through the Batch
API and every verdict priced at batch price). Right means the exact status.
Graded on the sample and the three held-out SOPs: 74 lines, 19 known gaps.

| Mode | right | known gaps shown | missed | false gaps | left for a person | per SOP | 5,000 SOPs |
|---|---|---|---|---|---|---|---|
| Rules only, local: no AI, no API | 36 of 74 | 8 of 19 | 0 | 0 | 194 of 278 lines | $0 | $0 |
| Rules first, Haiku on the rest, local | 60 | 17 | 2 | 9 | 0 | $0.0012 | $6.00 |
| Haiku on every line, local evidence | 55 | 16 | 3 | 9 | 0 | $0.0017 | $8.65 |
| Haiku on every line, voyage-4 (current) | 56 | 16 | 3 | 8 | 0 | $0.0020 | $10.17 |

Missed is a known gap shown as met or not applicable; a false gap is a met
or not applicable line shown as a gap. The current mode's cost includes
voyage-4 for the SOP's passages, $0.00006 per SOP.

| Mode | sample, 41 lines | 3 held out, 50 lines, 33 graded | 10 other SOPs, 187 lines |
|---|---|---|---|
| Rules only | 34 decided, all right, 7 left | 5 decided (2 graded, both right), 45 left | 45 decided, 142 left |
| Rules first, then Haiku | 40 right | 20 right | 142 sent to Haiku |
| Haiku, local evidence | 36 right | 19 right | |
| Haiku, voyage-4 | 35 right | 21 right (84 lines asked: 4 extra sections) | |

- On the sample the cascade is right on 40 of 41. The rules take the lines
  Haiku gets wrong (three active-ingredient lines it calls met or partly
  met, a radioactive-product line it calls met), and Haiku takes the 7 the
  rules cannot decide.
- On the held-out SOPs every mode with Haiku gets about 20 of 33. Haiku
  calls 7 of their 21 met lines partly met, the safe side: a reviewer
  dismisses them. It shows 2 gaps as met, one of them planted: a batch
  record completed at the end of the shift, not as each step is done.
- Local evidence costs Haiku nothing measurable: 55 against 56 of 74.

**At 5,000 SOPs**, for SOPs like these (19.9 lines each on average):
- Rules only: no bill. The local model needs 0.07 s of CPU per SOP to embed
  its passages (about 6 minutes for 5,000 on this laptop), and the scoring
  and the rules take milliseconds. But a person reads about 13.9 lines per
  SOP, some 69,300 lines in all, each shown with its three passages and the
  words the rules could not find.
- Rules first, then Haiku: about $6.00, 59% of the current $10.17, and the
  best of the four on these SOPs. It still sends 7 of every 10 lines to a
  generative model.
- The sample, the longest SOP here with the local scope (41 lines): $3.35
  for 5,000 through the cascade, $19.36 with Haiku on every line.

**Items under an unmarked opening paragraph.** `read_part` used to drop the
items of a section whose opening paragraph has no marker. 211.142 opens
"Written procedures describing the warehousing of drug products shall be
established and followed. They shall include:", then (a) "Quarantine of
drug products before release by the quality control unit." The opening
paragraph became a requirement of its own but was not passed down, so (a)
had only the section title as context, no "shall" anywhere, and was left
out. It was found while the held-out SOPs were written, and fixed after the
measurements above were first taken so that one change would not move
both. The opening paragraph is now the lead-in of every item after it. The
scope table's first and last rows and the two tables under "Four ways" are
measured with the fix, and with the rule for short items after it; the
rules judge's table is from before both.
- 26 sentences in 25 paragraphs of 211.130, 211.142, 211.150, 211.184 and
  211.188 are now checked (Part 211: 394 to 420), 15 of them the items of
  211.188, the batch record. 23 lines of 211.101, 211.130 and 211.184 that
  were checked already gain the lead-in, so a cached verdict for them no
  longer matches.
- No graded line moved: the sample's and the held-out SOPs' graded sections
  have no such opening, so right, gaps shown, missed and false gaps are as
  before.
- Scope moved: 211.188 has 17 sentences instead of 2, so its two best come
  closer to more SOPs (the scope table above). The local modes check 278
  lines instead of 220, voyage-4 316 instead of 251. Before the fix the
  rules left 145 of 220 lines for a person, and 5,000 SOPs cost $4.50
  through the cascade, $6.84 with Haiku on local evidence and $8.23 with
  voyage-4. The new lines are mostly 211.188's short items ("Dates;", "Any
  sampling performed;"), which the rules decide less often (14 of 58), so
  the cascade costs 30% more.
- voyage-4 at 0.62 also takes 211.188 on the label and cleaning SOPs: 2 more
  extras in section 24's 0.62 row (its 0.68 and 0.65 rows are unchanged).
  Section 25's library figures were measured before the fix and not run
  again.
- On the 58 new local lines the rules decide 14 and agree with Haiku on 7.
  Five of the seven others are 211.188 lines on the master record SOP that
  the rules call met, because the master record names the same things
  ("Dates;" is all of 211.188(b)(1)); Haiku calls them partly or not met,
  as the SOP covers the master record and never each batch's record. The
  other two are not met where Haiku says not applicable, on a section
  outside the SOP's scope. Two of the five are now left unsure (next).

**Short items.** The words rule called a list item met when one passage
held 70% of its terms, and almost any passage holds an item of one or two
terms: 211.188(b)(1) is "Dates;", (b)(10) "Any sampling performed;". An
item under a lead-in with fewer than three terms of its own, after stop
words and the regulation's filler are left out, is now left unsure even
when one passage holds all of them. A sentence with its own subject is not
touched: 211.100(a)'s "Such procedures shall include all requirements in
this subpart" is still met on "subpart", and right.
- Asking for the lead-in's terms as well was tried first, and does not
  separate the cases. 211.188(b)'s lead-in is "Documentation that each
  significant step in the manufacture, processing, packing, or holding of
  the batch was accomplished". The master record SOP's closest passage
  holds 5 of its 9 terms, since a master record talks about manufacture,
  packing and batches too. The in-process SOP's holds 3 of 9, and there
  Haiku says met. A share of the lead-in high enough to stop the first
  stops the second, so words cannot tell which record an item goes in. The
  line goes to Haiku, which reads the SOP's scope.
- 5 lines move from met to unsure, none of them graded: 211.188(b)(1) and
  (b)(10) on the master record SOP, (b)(10) on the in-process SOP, and
  211.198(b)(2) and (b)(3) on the complaints SOP. Haiku calls 3 of them
  partly met and 2 met, so the rules give up 3 calls Haiku disagreed with
  and 2 it agreed with.
- Graded lines are unchanged in every mode: rules 36 of 74, the cascade 60.
  Rules alone leave 194 of 278 lines for a person (was 189), and 5,000 SOPs
  cost $6.00 through the cascade (was $5.84). The five lines' Haiku
  verdicts were in the cache already, so nothing was spent.
- Two of the five are short by accident: `obligation()` drops the words
  after a cross-reference, so 211.198(b)(2) "Where an investigation under
  § 211.192 is conducted, the written record shall include the findings..."
  keeps only "investigation" (Not covered, below).

**The SOP check page.** Its scores card showed the old rules (sure about 15
of 41) and its cost card assumed the model on every line. Both now read
`web/src/data/gap-modes.json`, written by `gap_modes.py --publish`: rules
only, the cascade and Haiku on the sample and the three held-out SOPs, and
the three costs at 5,000 SOPs. The rows are still the sample's Haiku
verdicts.

**Spent:** $0.014 on 163 Haiku verdicts through the Batch API, about
$0.002 on the held-out SOPs' context lines at ingest, and $0.0086 on 103
more verdicts after the fix for unmarked opening paragraphs.

**Not covered.**
- The words rule cannot tell which record a longer item belongs in either.
  On the master record SOP it still calls three 211.188 lines met
  (sentence 1, (b)(3) "Specific identification of each batch of component
  or in-process material used" and (b)(8) "Complete labeling control
  records"), with 6 to 10 terms each, where Haiku says partly or not met:
  the master record names the same things as each batch's record.
- `obligation()` drops a cross-reference with every lower-case word after
  it: the pattern for "under § 211.192" also takes "is conducted, the
  written record shall include the findings of the investigation and
  followup". 19 lines lose words this way, among them the 3-year periods
  for OTC products exempt from expiry dating (211.170(a)(3), 211.180(a)
  and (b), 211.198(b)), which the numbers step then never sees.
- 211.132 puts its (1) on the same line as the paragraph's heading
  ("Labeling. (1) In order to alert consumers..."), so (b)(1) and (c)(1)
  are cited as (b) and (c), and (c)(1)(i) to (iii) are read as letters and
  dropped: 3 sentences of the OTC tamper-evident packaging section.
- The background for the local scope is whatever else is stored. A
  database of nothing but stability SOPs would raise 211.166's usual score
  and push stability SOPs out of scope; a fixed reference set would make
  it reproducible.
- All 14 SOPs are synthetic, one page each, and one person wrote the SOPs,
  the rules and the expected verdicts.
- The library mode runs with `--local`, but was not measured again.
