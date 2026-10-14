import { NextResponse } from "next/server";
import { BUCKET, publicUrl, supabaseAdmin } from "@/lib/supabase";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const sb = supabaseAdmin();
  const [{ data: doc, error }, { data: pages }] = await Promise.all([
    sb.from("documents").select("*").eq("id", id).single(),
    sb.from("pages").select("*").eq("document_id", id).order("page_number"),
  ]);
  if (error || !doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    document: doc,
    pages: (pages ?? []).map((p) => ({ ...p, image_url: publicUrl(p.image_path) })),
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const sb = supabaseAdmin();
  // remove every object under documents/<id>/ (pages, figures, source)
  for (const folder of ["", "pages", "figures"]) {
    const prefix = folder ? `documents/${id}/${folder}` : `documents/${id}`;
    const { data: files } = await sb.storage.from(BUCKET).list(prefix, { limit: 1000 });
    const names = (files ?? []).filter((f) => f.id).map((f) => `${prefix}/${f.name}`);
    if (names.length) await sb.storage.from(BUCKET).remove(names);
  }
  const { error } = await sb.from("documents").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
