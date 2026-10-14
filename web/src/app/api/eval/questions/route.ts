import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET(req: Request) {
  const docId = new URL(req.url).searchParams.get("document_id");
  const sb = supabaseAdmin();
  let q = sb.from("eval_questions").select("*").order("created_at");
  if (docId) q = q.eq("document_id", docId);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ questions: data });
}

export async function POST(req: Request) {
  const body = (await req.json()) as { document_id: string; question: string; must_contain?: string | null; expected_page?: number | null };
  if (!body.document_id || !body.question?.trim()) return NextResponse.json({ error: "document_id and question required" }, { status: 400 });
  const { data, error } = await supabaseAdmin()
    .from("eval_questions")
    .insert({ document_id: body.document_id, question: body.question.trim(), must_contain: body.must_contain?.trim() || null, expected_page: body.expected_page ?? null })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ question: data });
}
