import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET() {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("documents")
    .select("id,name,kind,sample_key,page_count,status,progress,stats,created_at")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ documents: data });
}
