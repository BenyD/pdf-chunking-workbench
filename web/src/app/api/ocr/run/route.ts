import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { worker } from "@/lib/worker";

/** Run a saved (or inline) template against a document page via the worker. */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    document_id: string; page_number?: number; template_id?: string; template?: unknown; fallback?: boolean; save?: boolean;
  };
  if (!body.document_id) return NextResponse.json({ error: "document_id required" }, { status: 400 });
  let template = body.template;
  if (!template && body.template_id) {
    const { data } = await supabaseAdmin().from("ocr_templates").select("*").eq("id", body.template_id).single();
    if (!data) return NextResponse.json({ error: "template not found" }, { status: 404 });
    template = { name: data.name, fields: data.fields, anchors: data.anchors };
  }
  if (!template) return NextResponse.json({ error: "template or template_id required" }, { status: 400 });
  try {
    const out = await worker("/ocr/run", {
      document_id: body.document_id,
      page_number: body.page_number ?? 1,
      template,
      template_id: body.template_id ?? null,
      fallback: body.fallback ?? true,
      save: body.save ?? true,
    });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
