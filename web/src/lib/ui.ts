import type { ChunkType, Strategy } from "./types";

/** Semantic colours for chunk types. Used for badges and page overlays. */
export const TYPE_STYLE: Record<ChunkType, { chip: string; box: string; label: string }> = {
  text:      { chip: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",             box: "border-sky-500 bg-sky-500/10 hover:bg-sky-500/20",            label: "text" },
  table:     { chip: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200", box: "border-amber-500 bg-amber-500/10 hover:bg-amber-500/20",      label: "table" },
  table_row: { chip: "border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200", box: "border-orange-400 bg-orange-400/5 hover:bg-orange-400/20", label: "row" },
  figure:    { chip: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-800 dark:border-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-200", box: "border-fuchsia-500 bg-fuchsia-500/10 hover:bg-fuchsia-500/20", label: "figure" },
  record:    { chip: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200", box: "border-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20", label: "record" },
};

export const STRATEGY_INFO: Record<Strategy, { label: string; chip: string; blurb: string }> = {
  naive:      { label: "Naive", chip: "bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-100", blurb: "Fixed ~450-token windows with overlap. No idea where tables, headings or figures are." },
  structural: { label: "Structural", chip: "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200", blurb: "Cuts follow headings, tables and figures. Breadcrumb prepended. Tables atomic plus one chunk per row. Zero model calls." },
  contextual: { label: "Contextual", chip: "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200", blurb: "Structural cuts plus a model-written situating sentence per chunk and a vision description per figure. Paid once at ingest." },
};

export function fmtNum(n: number | undefined | null): string {
  if (n == null) return "–";
  return n.toLocaleString();
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

export function publicAsset(path: string): string {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/chunklab/${path}`;
}
