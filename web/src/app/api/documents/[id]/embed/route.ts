import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { worker } from "@/lib/worker";

type Ctx = { params: Promise<{ id: string }> };

/** Resume embedding for chunks without a vector (no re-parse, no new model calls). */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const sb = supabaseAdmin();
  const { data: doc } = await sb.from("documents").select("id").eq("id", id).single();
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    return NextResponse.json(await worker("/embed", { document_id: id }));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
