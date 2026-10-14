import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { worker } from "@/lib/worker";

type Ctx = { params: Promise<{ id: string }> };

/** Step 2 of an upload (and re-ingest): hand the document to the worker. */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const sb = supabaseAdmin();
  const { data: doc } = await sb.from("documents").select("id,status").eq("id", id).single();
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  await sb.from("documents").update({ status: "queued", progress: { stage: "queued" } }).eq("id", id);
  try {
    await worker("/ingest", { document_id: id });
  } catch (e) {
    await sb.from("documents").update({ status: "error", progress: { stage: "error", message: String(e) } }).eq("id", id);
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
