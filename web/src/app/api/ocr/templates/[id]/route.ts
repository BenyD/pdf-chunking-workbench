import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const { data, error } = await supabaseAdmin().from("ocr_templates").select("*, ocr_runs(count)").eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "form not found" }, { status: 404 });
  const { ocr_runs, ...t } = data;
  return NextResponse.json({ template: { ...t, runs: (ocr_runs as { count: number }[] | null)?.[0]?.count ?? 0 } });
}

/** Change a saved form in place, so its past reads stay attached to it. */
export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json()) as { name?: string; document_id?: string | null; fields?: unknown[]; anchors?: unknown[] };
  if (body.fields && (!Array.isArray(body.fields) || body.fields.length === 0)) return NextResponse.json({ error: "at least one field is required" }, { status: 400 });
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.document_id !== undefined) patch.document_id = body.document_id;
  if (body.fields !== undefined) patch.fields = body.fields;
  if (body.anchors !== undefined) patch.anchors = body.anchors;
  const { data, error } = await supabaseAdmin().from("ocr_templates").update(patch).eq("id", id).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ template: data });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const { error } = await supabaseAdmin().from("ocr_templates").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
