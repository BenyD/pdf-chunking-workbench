import { NextResponse } from "next/server";
import { BUCKET, supabaseAdmin } from "@/lib/supabase";

/**
 * Step 1 of an upload. The browser PUTs the file straight to Supabase Storage
 * using a signed URL, so the PDF never passes through a Vercel function (which
 * caps request bodies at a few MB).
 */
export async function POST(req: Request) {
  const { name, size } = (await req.json()) as { name?: string; size?: number };
  if (!name || !name.toLowerCase().endsWith(".pdf")) return NextResponse.json({ error: "PDF files only" }, { status: 400 });
  if (size && size > 150 * 1024 * 1024) return NextResponse.json({ error: "File too large (150 MB max)" }, { status: 400 });

  const sb = supabaseAdmin();
  const { data: doc, error } = await sb
    .from("documents")
    .insert({ name, storage_path: "pending", kind: "upload", status: "uploading", progress: { stage: "uploading" } })
    .select("id")
    .single();
  if (error || !doc) return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });

  const path = `documents/${doc.id}/source.pdf`;
  await sb.from("documents").update({ storage_path: path }).eq("id", doc.id);
  const { data: signed, error: sErr } = await sb.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (sErr || !signed) return NextResponse.json({ error: sErr?.message ?? "sign failed" }, { status: 500 });
  // the browser uploads through this site (next.config.ts rewrites), never to supabase.co directly
  const via = signed.signedUrl.replace(/^https?:\/\/[^/]+\/storage\/v1\//, "/storage/");
  return NextResponse.json({ id: doc.id, path, signedUrl: via, token: signed.token });
}
