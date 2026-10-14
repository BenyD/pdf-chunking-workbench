/** The one index the product ships. The name is a leftover of the comparison that chose it. */
export type Strategy = "contextual";
export const STRATEGY: Strategy = "contextual";
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

export interface SearchResult extends Chunk {
  rrf_score: number;
  fts_rank: number | null;
  vec_rank: number | null;
  document_name?: string;
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
}

export interface EvalQuestion {
  id: string;
  document_id: string;
  question: string;
  expected_page: number | null;
  must_contain: string | null;
}
