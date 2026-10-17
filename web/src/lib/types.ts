import { aiEnabled } from "./flags";

/** The index the app reads: "structural" with generative AI off (the rules' cuts, verbatim), "contextual" with it on. */
export type Strategy = "contextual" | "structural";
export const STRATEGY: Strategy = aiEnabled ? "contextual" : "structural";
export const STRATEGIES: Strategy[] = [STRATEGY];

export type ChunkType = "text" | "table" | "table_row" | "figure" | "record";

export interface Document {
  id: string;
  name: string;
  storage_path: string;
  kind: "upload" | "sample";
  sample_key: string | null;
  page_count: number | null;
  status: "uploading" | "queued" | "processing" | "ready" | "error";
  progress: { stage?: string; done?: number; total?: number; message?: string };
  stats: Record<string, unknown>;
  created_at: string;
}

export interface Page {
  document_id: string;
  page_number: number;
  width: number;
  height: number;
  image_path: string;
  image_url?: string;
  is_scanned: boolean;
  ocr_applied: boolean;
}

export interface BBox { page: number; x0: number; y0: number; x1: number; y1: number }

export interface Chunk {
  id: string;
  document_id: string;
  strategy: Strategy;
  chunk_type: ChunkType;
  ordinal: number;
  content: string;
  raw_text: string;
  context: string | null;
  page_start: number;
  page_end: number;
  bboxes: BBox[];
  parent_id: string | null;
  prev_id: string | null;
  next_id: string | null;
  metadata: Record<string, unknown>;
  token_count: number;
}

/** A passage that a search result links to: a figure's key, the table or section it cites, or one sharing a unit number. */
export interface LinkedPassage {
  id: string;
  document_id: string;
  chunk_type: ChunkType;
  raw_text: string;
  context: string | null;
  page_start: number;
  page_end: number;
  bboxes: BBox[];
  page_image_url?: string;
  /** How the result points at it: "Table 7", "Section 5.1", "Unit 117", "Key: Table 6 ..." */
  label: string;
  /** "doc": in another document, cited by the result or citing it. */
  kind: "ref" | "key" | "shared" | "doc";
  /** "out": the result cites it; "in": it cites the result; "shared": both name the same unit or code. */
  dir: "out" | "in" | "shared";
  /** "search": the result names a document with no place in it, so that document was searched with the question. */
  via?: "search";
  document_name?: string;
}

/** One link stored on a passage (metadata.links), made when the document was processed. */
export interface PassageLink { id: string | null; doc_id?: string; kind: "ref" | "key" | "shared" | "doc"; label: string; dir: "out" | "in" | "shared"; page: number | null; type: ChunkType | null }

export interface SearchResult extends Chunk {
  rrf_score: number;
  fts_rank: number | null;
  vec_rank: number | null;
  document_name?: string;
  /** The passages this result points at, ranked against the question; most results have none. */
  linked?: LinkedPassage[];
}

export interface OcrField {
  name: string;
  type: "text" | "date" | "amount" | "integer";
  page: number;
  box: { x: number; y: number; w: number; h: number };
  pattern?: string;
  description?: string;
}
export interface OcrAnchor { text: string; page: number; box: { x: number; y: number; w: number; h: number } }
export interface OcrTemplate {
  id: string;
  name: string;
  document_id: string | null;
  fields: OcrField[];
  anchors: OcrAnchor[];
  created_at: string;
  /** How many scans have been read with it; set by the templates API. */
  runs?: number;
}

export interface EvalQuestion {
  id: string;
  document_id: string;
  question: string;
  expected_page: number | null;
  must_contain: string | null;
}
