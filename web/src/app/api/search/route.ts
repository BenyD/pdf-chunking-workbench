import { NextResponse } from "next/server";
import { embedQuery } from "@/lib/embed";
import { rateLimit } from "@/lib/ratelimit";
import { publicUrl, supabaseAdmin } from "@/lib/supabase";
import { STRATEGY } from "@/lib/types";

/** Hybrid search: keyword match and meaning match over the same index, fused. */
export async function POST(req: Request) {
  const limited = rateLimit(req, "search", 30, 60_000);
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as { query?: string; document_id?: string | null; k?: number };
  const query = (body.query ?? "").trim().slice(0, 500);
  if (!query) return NextResponse.json({ error: "Type a question first." }, { status: 400 });
  const k = Math.min(Math.max(body.k ?? 8, 1), 20);

  const sb = supabaseAdmin();
  const embedding = await embedQuery(query);
  const { data, error } = await sb.rpc("hybrid_search", {
    query_text: query, query_embedding: embedding, p_strategy: STRATEGY,
    p_document_id: body.document_id ?? null, match_count: k, full_text_weight: 1.0, semantic_weight: 1.0,
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
  return NextResponse.json({ query, embedded: embedding !== null, results });
}
