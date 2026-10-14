import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

type Ctx = { params: Promise<{ id: string }> };

const COLS = "id,document_id,strategy,chunk_type,ordinal,raw_text,context,page_start,page_end,bboxes,parent_id,prev_id,next_id,metadata,token_count";

/**
 * Chunks of one document for one strategy.
 *   ?strategy=structural&page=12   chunks touching page 12 (explorer)
 *   ?strategy=structural&offset=0&limit=200   paged list
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const url = new URL(req.url);
  const strategy = url.searchParams.get("strategy") ?? "contextual";
  const page = url.searchParams.get("page");
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);
  const type = url.searchParams.get("type");

  const sb = supabaseAdmin();
  let q = sb.from("chunks").select(COLS, { count: "exact" }).eq("document_id", id).eq("strategy", strategy).order("ordinal");
  if (page) q = q.lte("page_start", Number(page)).gte("page_end", Number(page));
  if (type) q = q.eq("chunk_type", type);
  q = q.range(offset, offset + limit - 1);
  const { data, error, count } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ chunks: data, total: count });
}
