# Documentation

This app takes PDFs, splits them into searchable pieces three different ways, and lets you compare the results. It also reads fixed fields off scanned forms. Everything below is written for someone using the app, not building it.

## Documents

The home page is your library.

- **Load sample documents** opens a picker with seven built-in PDFs. Tick the ones you want and load them. Each one is processed in the background and shows up in the table as it finishes.
- **Upload a PDF** takes any PDF up to 150 MB. Scanned PDFs with no text layer are recognised with OCR automatically.
- The status badge shows what is happening right now. The small ring fills as the stage progresses.

| Status | Meaning |
|---|---|
| Queued | Waiting for the worker |
| Rendering pages | Page images are being made for the viewer |
| Parsing layout | Headings, tables and figures are being detected |
| Chunking | The three strategies are being built |
| Writing context | A model writes a short context sentence per chunk and describes each figure |
| Storing chunks | Chunks are written to the database |
| Embedding | Vectors are computed for semantic search |
| Ready | Done, searchable |
| Failed | Something went wrong; the message says what |

Row actions, right to left: delete the document, embed any chunks that still have no vector, and re-ingest from scratch. Re-ingest repeats the model calls; re-embed does not.

## Chunk explorer

Click a document name to open it. The page shows one rendered page at a time with every chunk drawn on it.

- The three cards at the top are the strategies. Click one, or use the tabs above the page, to switch.
- Boxes on the page are chunks, coloured by type. Click a box or a card on the right to read the chunk.
- **Show row chunks** also draws one box per table row. They are hidden by default so the table outline stays readable.
- The detail panel shows the text that was stored, the context that was put in front of it before embedding, and for figures, the image and the description the vision model wrote.

### The three strategies

- **Naive** cuts the text into fixed windows of about 450 tokens with a small overlap. It does not know where headings, tables or figures are, so a window can start mid-sentence and cut through a table.
- **Structural** cuts at headings and keeps tables and figures whole. Each chunk gets a breadcrumb such as "Chapter V > 90. Death caused by act done with intent to cause miscarriage" in front of it. Big tables are split by rows with the header repeated in every part, and every row is also its own small chunk written as "Column: value" pairs. No model is involved.
- **Contextual** uses the same cuts as Structural and adds two things a model writes once per document: a sentence saying what each chunk is about and where it sits, and a description of each figure that names every arrow, label and what it points at.

### Chunk types

| Type | What it is |
|---|---|
| text | A passage of prose under one heading |
| table | A whole table, or one part of a big one, as a markdown table |
| row | One table row flattened to "Header: value" pairs |
| figure | A picture with its caption, the text on it, and the sentences that refer to it |
| record | Fields extracted by zonal OCR from a form |

## Search

Type a question, or click one of the example questions.

- The document selector limits the search to one document. The number next to it is how many results each strategy returns.
- Each strategy gets its own column, so you can see what Naive, Structural and Contextual return for the same question.
- Every result shows its page and three numbers. **rrf** is the combined score. **fts** is its rank by keyword match and **vec** its rank by meaning. A result with a vec rank but no fts rank was found by meaning alone, and the other way round.
- The two sliders change how much keyword and meaning matching count. Leave them at 1 unless you are experimenting.
- Click a result to expand it. For a row you see its whole table; for a passage you see the chunks before and after it; for a figure you see the image. The page image shows where the chunk sits.

## Zonal OCR

Use this for forms that always look the same, such as a pharmacy bill. You draw the fields once and run the template on every new scan.

1. Pick the clean sample in **Template** and keep the page at 1.
2. With **draw field** selected, drag a box around each value you want. Give each one a name, a type (text, date, amount or integer) and optionally a pattern the value must match.
3. Switch to **draw anchor** and drag boxes around two or three printed words that never change, such as the clinic name. Anchors are how the app finds the form again on a shifted or crooked scan. Click **detect words** first to see which words the OCR engine can read.
4. **Save template**. Saved templates can be loaded again from the dropdown.
5. In **Run**, pick the target document and press **Run template**.

The result table lists each field with the value, the raw text the OCR engine read, its confidence, and the source. Source **tesseract** means the deterministic OCR engine read it. Source **llm** means the confidence was too low or the pattern did not match, so a vision model read that field instead; the note says why. The run also stores the fields as a record chunk of the target document, so it is searchable straight away.

The sample bills come with a ready template. Load it from the dropdown, pick the scanned bill as the target and run it.

## Evaluation

This page measures how well each strategy finds answers.

- Pick a document. Sample documents come with questions; for your own document, add questions in the last row of the table.
- Each question needs a phrase that the correct chunk must contain, for example "shall be punished with death". The page number is optional and makes the check stricter.
- **Run** searches every question with every strategy and reports **recall@k**, the share of questions where a correct chunk appeared in the top k results, and **MRR**, which rewards the correct chunk being near the top. Expand "top 3" under any cell to see what came back.

## Sample documents

| Document | What it shows |
|---|---|
| Bharatiya Nyaya Sanhita 2023 | A 102-page statute with chapters, numbered sections and margin titles |
| Bharatiya Nagarik Suraksha Sanhita 2023 | 297 pages including a long classification table with no ruling lines |
| Pharma Price Schedule | One ruled table of 4,500 rows across 150 pages |
| QC Inspection Report | Photos of steel utensils with arrows and labels drawn on them |
| Pharmacy bill 1 and 2 | Clean digital invoices with the same layout |
| Pharmacy bill 3 scanned | The same layout as a rotated, shifted, noisy scan |

## Good to know

- Processing a few hundred pages takes several minutes; the page keeps updating by itself.
- Tables that run across pages are stitched back into one table, and the column headers travel with every part.
- Figures are described by a vision model, so a question like "what does the arrow point to" can find them.
- Full-text search needs the exact words; semantic search does not. Combining both is why section numbers and paraphrased questions both work.
