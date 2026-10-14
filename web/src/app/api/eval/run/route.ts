import { NextResponse } from "next/server";
import { embedQuery } from "@/lib/embed";
import { supabaseAdmin } from "@/lib/supabase";
import { STRATEGIES, type Strategy } from "@/lib/types";

interface Hit { strategy: Strategy; rank: number | null; top: { id: string; page_start: number; chunk_type: string; snippet: string }[] }

/**
 * Recall@k per strategy. A question is a hit for a strategy when one of its
 * top-k chunks contains the expected phrase (and sits on the expected page,
 * when one is given). Also reports mean reciprocal rank.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as { document_id: string; k?: number; strategies?: Strategy[] };
  if (!body.document_id) return NextResponse.json({ error: "document_id required" }, { status: 400 });
  const k = Math.min(Math.max(body.k ?? 5, 1), 20);
  const strategies = (body.strategies?.length ? body.strategies : STRATEGIES).filter((s) => STRATEGIES.includes(s));
  const sb = supabaseAdmin();
  const { data: questions, error } = await sb.from("eval_questions").select("*").eq("document_id", body.document_id).order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!questions?.length) return NextResponse.json({ error: "no questions for this document" }, { status: 400 });

  const rows: { question: string; must_contain: string | null; expected_page: number | null; hits: Hit[] }[] = [];
  let embedded = true;
  for (const q of questions) {
    const emb = await embedQuery(q.question);
    if (emb === null) embedded = false;
    const hits: Hit[] = [];
    for (const strategy of strategies) {
      const { data } = await sb.rpc("hybrid_search", {
        query_text: q.question, query_embedding: emb, p_strategy: strategy,
        p_document_id: body.document_id, match_count: k,
      });
      const list = (data ?? []) as { id: string; content: string; page_start: number; page_end: number; chunk_type: string }[];
      const needle = (q.must_contain ?? "").toLowerCase().replace(/\s+/g, " ");
      let rank: number | null = null;
      list.forEach((c, i) => {
        if (rank !== null) return;
        const textOk = !needle || c.content.toLowerCase().replace(/\s+/g, " ").includes(needle);
        const pageOk = q.expected_page == null || (c.page_start <= q.expected_page && q.expected_page <= c.page_end);
        if (textOk && pageOk) rank = i + 1;
      });
      hits.push({
        strategy, rank,
        top: list.slice(0, 3).map((c) => ({ id: c.id, page_start: c.page_start, chunk_type: c.chunk_type, snippet: c.content.slice(0, 160) })),
      });
    }
    rows.push({ question: q.question, must_contain: q.must_contain, expected_page: q.expected_page, hits });
  }
  const summary = strategies.map((s) => {
    const ranks = rows.map((r) => r.hits.find((h) => h.strategy === s)?.rank ?? null);
    const hitCount = ranks.filter((r) => r !== null).length;
    const mrr = ranks.reduce<number>((acc, r) => acc + (r ? 1 / r : 0), 0) / ranks.length;
    return { strategy: s, recall_at_k: hitCount / ranks.length, hits: hitCount, total: ranks.length, mrr: Number(mrr.toFixed(3)) };
  });
  return NextResponse.json({ k, embedded, summary, rows });
}
