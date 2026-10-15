import { NextResponse } from "next/server";
import { SAMPLE_OCR_TEMPLATE, SAMPLES } from "@/lib/samples";
import { BUCKET, supabaseAdmin } from "@/lib/supabase";
import { worker } from "@/lib/worker";

/**
 * Seed the built-in samples: copy each PDF from /public/samples into storage,
 * create its document row, queue ingestion, and add the sample OCR template
 * and evaluation questions. Idempotent: existing samples are skipped.
 */
export async function POST(req: Request) {
  const sb = supabaseAdmin();
  const origin = new URL(req.url).origin;
  const body = (await req.json().catch(() => ({}))) as { keys?: string[] };
  const wanted = SAMPLES.filter((s) => !body.keys || body.keys.includes(s.key));
  const created: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const s of wanted) {
    const { data: existing } = await sb.from("documents").select("id").eq("sample_key", s.key).maybeSingle();
    if (existing) { skipped.push(s.key); continue; }
    try {
      const res = await fetch(`${origin}/samples/${s.file}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`fetch ${s.file}: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const { data: doc, error } = await sb
        .from("documents")
        .insert({ name: s.name, storage_path: "pending", kind: "sample", sample_key: s.key, status: "uploading" })
        .select("id").single();
      if (error || !doc) throw new Error(error?.message ?? "insert failed");
      const path = `documents/${doc.id}/source.pdf`;
      const { error: upErr } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true });
      if (upErr) throw new Error(upErr.message);
      await sb.from("documents").update({ storage_path: path, status: "queued", progress: { stage: "queued" } }).eq("id", doc.id);
      try {
        await worker("/ingest", { document_id: doc.id });
      } catch (e) {
        // The row would otherwise say "queued" for good; say what went wrong where the list shows it.
        await sb.from("documents").update({ status: "error", progress: { stage: "error", message: String(e) } }).eq("id", doc.id);
        throw e;
      }
      created.push(s.key);
    } catch (e) {
      errors.push(`${s.key}: ${String(e)}`);
    }
  }

  // OCR template bound to the clean bill. The generated file (exact word
  // positions) wins over the hand-written constant.
  let tplDef = SAMPLE_OCR_TEMPLATE;
  try {
    const res = await fetch(`${origin}/samples/ocr-template.json`, { cache: "no-store" });
    if (res.ok) tplDef = (await res.json()) as typeof SAMPLE_OCR_TEMPLATE;
  } catch { /* fall back to constant */ }
  const { data: billDoc } = await sb.from("documents").select("id").eq("sample_key", tplDef.sample_key).maybeSingle();
  if (billDoc) {
    const { data: tpl } = await sb.from("ocr_templates").select("id").eq("name", tplDef.name).maybeSingle();
    if (!tpl) await sb.from("ocr_templates").insert({ name: tplDef.name, document_id: billDoc.id, fields: tplDef.fields, anchors: tplDef.anchors });
  }

  // Eval questions from /public/samples/eval.json: { "<sample_key>": [{question, must_contain, expected_page?}] }
  try {
    const res = await fetch(`${origin}/samples/eval.json`, { cache: "no-store" });
    if (res.ok) {
      const evalSet = (await res.json()) as Record<string, { question: string; must_contain?: string; expected_page?: number }[]>;
      for (const [key, qs] of Object.entries(evalSet)) {
        const { data: d } = await sb.from("documents").select("id").eq("sample_key", key).maybeSingle();
        if (!d) continue;
        const { count } = await sb.from("eval_questions").select("id", { count: "exact", head: true }).eq("document_id", d.id);
        if (count) continue;
        await sb.from("eval_questions").insert(qs.map((q) => ({ document_id: d.id, question: q.question, must_contain: q.must_contain ?? null, expected_page: q.expected_page ?? null })));
      }
    }
  } catch { /* eval set is optional */ }

  return NextResponse.json({ created, skipped, errors });
}
