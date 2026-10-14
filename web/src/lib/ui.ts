import type { ChunkType } from "./types";

/** Semantic colours for chunk types. Used for badges and page overlays. */
export const TYPE_STYLE: Record<ChunkType, { chip: string; box: string; label: string }> = {
  text:      { chip: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",             box: "border-sky-500 bg-sky-500/10 hover:bg-sky-500/20",            label: "Text" },
  table:     { chip: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200", box: "border-amber-500 bg-amber-500/10 hover:bg-amber-500/20",      label: "Table" },
  table_row: { chip: "border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200", box: "border-orange-400 bg-orange-400/5 hover:bg-orange-400/20", label: "Table row" },
  figure:    { chip: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-800 dark:border-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-200", box: "border-fuchsia-500 bg-fuchsia-500/10 hover:bg-fuchsia-500/20", label: "Figure" },
  record:    { chip: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200", box: "border-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20", label: "Form" },
};

/** Human labels for the worker's pipeline stages. */
export function stageLabel(stage?: string | null): string {
  const map: Record<string, string> = {
    queued: "Queued", download: "Fetching", render: "Reading pages", parse: "Finding tables and figures", chunk: "Splitting into passages",
    context: "Describing passages", store: "Saving", embed: "Indexing", done: "Done", error: "Failed",
  };
  if (!stage) return "Queued";
  if (stage.startsWith("embed")) return "Indexing";
  return map[stage] ?? stage;
}

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
