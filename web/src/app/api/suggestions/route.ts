import { NextResponse } from "next/server";
import { aiEnabled } from "@/lib/flags";
import { SAMPLES } from "@/lib/samples";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Question suggestions for the search page. With generative AI on, per document they come from the questions a
 * model wrote at ingest. With it off, nothing is generated: the built-in samples carry a few fixed questions each,
 * and an uploaded document has none. For "all documents", a mix across them.
 */
export async function GET(req: Request) {
  const docId = new URL(req.url).searchParams.get("document_id");
  const sb = supabaseAdmin();
  let q = sb.from("documents").select("id,name,stats,sample_key").eq("status", "ready");
  if (docId) q = q.eq("id", docId);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const lists = (data ?? []).map((d) => ({
    id: d.id,
    name: (d.name as string).replace(/\.pdf$/i, ""),
    questions: aiEnabled
      ? (((d.stats as { suggestions?: string[] })?.suggestions) ?? []).filter((s) => typeof s === "string")
      : SAMPLES.find((x) => x.key === d.sample_key)?.questions ?? [],
  })).filter((l) => l.questions.length);
  const out: { text: string; document_id: string; document_name: string }[] = [];
  if (docId) {
    for (const t of lists[0]?.questions ?? []) out.push({ text: t, document_id: lists[0].id, document_name: lists[0].name });
  } else {
    // round-robin so every document contributes; the sample bills ask near-identical questions, so skip repeats
    const seen = new Set<string>();
    for (let i = 0; out.length < 8 && lists.some((l) => l.questions[i]); i++) {
      for (const l of lists) {
        const t = l.questions[i];
        if (!t || out.length >= 8) continue;
        const k = t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ text: t, document_id: l.id, document_name: l.name });
      }
    }
  }
  return NextResponse.json({ suggestions: out.slice(0, 8) });
}
