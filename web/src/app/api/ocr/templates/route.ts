import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET() {
  const sb = supabaseAdmin();
  const { data, error } = await sb.from("ocr_templates").select("*").order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ templates: data });
}

export async function POST(req: Request) {
  const body = (await req.json()) as { name: string; document_id?: string | null; fields: unknown[]; anchors?: unknown[] };
  if (!body.name || !Array.isArray(body.fields) || body.fields.length === 0)
    return NextResponse.json({ error: "name and at least one field are required" }, { status: 400 });
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("ocr_templates")
    .insert({ name: body.name, document_id: body.document_id ?? null, fields: body.fields, anchors: body.anchors ?? [] })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ template: data });
}
