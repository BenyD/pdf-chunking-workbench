import { NextResponse } from "next/server";
import { embedQuery } from "@/lib/embed";
import { publicUrl, supabaseAdmin } from "@/lib/supabase";
import { STRATEGIES, type Strategy } from "@/lib/types";

/**
 * Hybrid search. One query embedding, then one RPC per requested strategy so
 * the UI can show strategies side by side for the same question.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    query: string; strategies?: Strategy[]; document_id?: string | null; k?: number;
    full_text_weight?: number; semantic_weight?: number;
  };
  const query = (body.query ?? "").trim();
  if (!query) return NextResponse.json({ error: "empty query" }, { status: 400 });
  const strategies = (body.strategies?.length ? body.strategies : STRATEGIES).filter((s) => STRATEGIES.includes(s));
  const k = Math.min(Math.max(body.k ?? 8, 1), 50);

  const sb = supabaseAdmin();
  const t0 = Date.now();
  const embedding = await embedQuery(query);
  const tEmbed = Date.now() - t0;

  const results: Record<string, unknown[]> = {};
  await Promise.all(
    strategies.map(async (strategy) => {
      const { data, error } = await sb.rpc("hybrid_search", {
        query_text: query,
        query_embedding: embedding,
        p_strategy: strategy,
        p_document_id: body.document_id ?? null,
        match_count: k,
        full_text_weight: body.full_text_weight ?? 1.0,
        semantic_weight: body.semantic_weight ?? 1.0,
      });
      if (error) throw new Error(`${strategy}: ${error.message}`);
      results[strategy] = data ?? [];
    }),
  );

  // decorate with document names and page images
  const docIds = [...new Set(Object.values(results).flat().map((r) => (r as { document_id: string }).document_id))];
  const { data: docs } = docIds.length ? await sb.from("documents").select("id,name").in("id", docIds) : { data: [] };
  const names = new Map((docs ?? []).map((d) => [d.id, d.name]));
  for (const list of Object.values(results)) {
    for (const r of list as Record<string, unknown>[]) {
      r.document_name = names.get(r.document_id as string) ?? "";
      r.page_image_url = publicUrl(`documents/${r.document_id}/pages/${r.page_start}.png`);
    }
  }
  return NextResponse.json({ query, embedded: embedding !== null, embed_ms: tEmbed, total_ms: Date.now() - t0, results });
}
