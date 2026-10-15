import { NextResponse } from "next/server";
import { embedQuery } from "@/lib/embed";
import { rateLimit } from "@/lib/ratelimit";
import { publicUrl, supabaseAdmin } from "@/lib/supabase";
import { STRATEGY } from "@/lib/types";

/**
 * How much AI a search uses. "full" is the app: chunks carrying a model-written context line, keyword and
 * meaning search fused. "embeddings" searches the same chunks cut by the same rules with no generated text,
 * keyword and meaning fused. "keywords" is the same rule-cut chunks with keyword search alone: no model at
 * any step. The last two exist so the Compare page can show what the AI adds.
 */
const MODES = {
  full: { strategy: STRATEGY, meaning: true },
  embeddings: { strategy: "structural", meaning: true },
  keywords: { strategy: "structural", meaning: false },
} as const;
type Mode = keyof typeof MODES;

/** Hybrid search: keyword match and meaning match over the same index, fused. */
export async function POST(req: Request) {
  const limited = rateLimit(req, "search", 30, 60_000);
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as { query?: string; document_id?: string | null; k?: number; mode?: string };
  const query = (body.query ?? "").trim().slice(0, 500);
  if (!query) return NextResponse.json({ error: "Type a question first." }, { status: 400 });
  const k = Math.min(Math.max(body.k ?? 8, 1), 20);

  const mode: Mode = body.mode && body.mode in MODES ? (body.mode as Mode) : "full";
  const { strategy, meaning } = MODES[mode];

  const sb = supabaseAdmin();
  const embedding = meaning ? await embedQuery(query) : null;
  const { data, error } = await sb.rpc("hybrid_search", {
    query_text: query, query_embedding: embedding, p_strategy: strategy,
    p_document_id: body.document_id ?? null, match_count: k, full_text_weight: 1.0, semantic_weight: meaning ? 1.0 : 0,
  });
  if (error) return NextResponse.json({ error: "Search is unavailable right now." }, { status: 502 });
  const results = (data ?? []) as Record<string, unknown>[];

  const docIds = [...new Set(results.map((r) => r.document_id as string))];
  const { data: docs } = docIds.length ? await sb.from("documents").select("id,name").in("id", docIds) : { data: [] };
  const names = new Map((docs ?? []).map((d) => [d.id, d.name]));
  for (const r of results) {
    r.document_name = names.get(r.document_id as string) ?? "";
    r.page_image_url = publicUrl(`documents/${r.document_id}/pages/${r.page_start}.png`);
  }
  return NextResponse.json({ query, mode, embedded: embedding !== null, results });
}
