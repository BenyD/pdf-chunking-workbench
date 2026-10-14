import { NextResponse } from "next/server";
import { publicUrl, supabaseAdmin } from "@/lib/supabase";

type Ctx = { params: Promise<{ id: string }> };
const COLS = "id,document_id,strategy,chunk_type,ordinal,content,raw_text,context,page_start,page_end,bboxes,parent_id,prev_id,next_id,metadata,token_count";

/** One chunk with its neighbourhood: parent (table for a row), prev/next, and
 *  first children (rows of a table). This is the "retrieve small, show big" step. */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const sb = supabaseAdmin();
  const { data: chunk, error } = await sb.from("chunks").select(COLS).eq("id", id).single();
  if (error || !chunk) return NextResponse.json({ error: "not found" }, { status: 404 });
  const ids = [chunk.parent_id, chunk.prev_id, chunk.next_id].filter(Boolean) as string[];
  const [{ data: related }, { data: children }, { data: page }] = await Promise.all([
    ids.length ? sb.from("chunks").select(COLS).in("id", ids) : Promise.resolve({ data: [] as never[] }),
    sb.from("chunks").select(COLS).eq("parent_id", id).order("ordinal").limit(50),
    sb.from("pages").select("page_number,width,height,image_path").eq("document_id", chunk.document_id).eq("page_number", chunk.page_start).maybeSingle(),
  ]);
  const byId = new Map((related ?? []).map((c) => [c.id, c]));
  return NextResponse.json({
    chunk,
    parent: chunk.parent_id ? byId.get(chunk.parent_id) ?? null : null,
    prev: chunk.prev_id ? byId.get(chunk.prev_id) ?? null : null,
    next: chunk.next_id ? byId.get(chunk.next_id) ?? null : null,
    children: children ?? [],
    page: page ? { ...page, image_url: publicUrl(page.image_path) } : null,
  });
}
