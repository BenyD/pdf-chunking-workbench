import { NextResponse } from "next/server";
import { embedQuery, embedQueryLocal } from "@/lib/embed";
import { aiEnabled } from "@/lib/flags";
import { rateLimit } from "@/lib/ratelimit";
import { publicUrl, supabaseAdmin } from "@/lib/supabase";

/**
 * How much AI a search uses.
 * - "keywords": the passages exactly as the rules cut them, keyword search alone. No model at any step.
 * - "pure": the same passages, with meaning search from a small open-source model inside our worker. No API call
 *   and nothing generated: the default while generative AI is off.
 * - "full": passages carrying a model-written context line, meaning search from an embedding API. The default
 *   with NEXT_PUBLIC_AI=1, and the "with AI" column of the Compare page.
 */
const MODES = {
  keywords: { strategy: "structural", vectors: null },
  pure: { strategy: "structural", vectors: "local" },
  full: { strategy: "contextual", vectors: "api" },
} as const;
type Mode = keyof typeof MODES;

/** The sections, tables and figures a question names ("section 67", "Table 7", "Figure B"), as patterns that match a
 * link's label ("Bharatiya Nyaya Sanhita, section 67", "Table 7"). */
function namedTargets(query: string): RegExp[] {
  const words: Record<string, string> = { fig: "figure", "fig.": "figure", appendix: "annex" };
  return [...query.matchAll(/\b(section|table|figure|fig\.?|annex|appendix|step|note)s?\s+(\d{1,3}(?:\.\d{1,3})*[A-Z]?|[A-Z])\b/gi)].map((m) => {
    const word = words[m[1].toLowerCase()] ?? m[1].toLowerCase();
    return new RegExp(`\\b${word}\\s+${m[2].replaceAll(".", "\\.")}(?![\\w.])`, "i");
  });
}

/** Hybrid search: keyword match and meaning match over the same index, fused. */
export async function POST(req: Request) {
  const limited = rateLimit(req, "search", 30, 60_000);
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as { query?: string; document_id?: string | null; k?: number; mode?: string };
  const query = (body.query ?? "").trim().slice(0, 500);
  if (!query) return NextResponse.json({ error: "Type a question first." }, { status: 400 });
  const k = Math.min(Math.max(body.k ?? 8, 1), 20);

  const mode: Mode = body.mode && body.mode in MODES ? (body.mode as Mode) : aiEnabled ? "full" : "pure";
  const { strategy, vectors } = MODES[mode];

  const sb = supabaseAdmin();
  const embedding = vectors === "api" ? await embedQuery(query) : vectors === "local" ? await embedQueryLocal(query) : null;
  const { data, error } = await sb.rpc(vectors === "local" ? "hybrid_search_local" : "hybrid_search", {
    query_text: query, query_embedding: embedding, p_strategy: strategy,
    p_document_id: body.document_id ?? null, match_count: k, full_text_weight: 1.0, semantic_weight: embedding ? 1.0 : 0,
  });
  if (error) return NextResponse.json({ error: "Search is unavailable right now." }, { status: 502 });
  const results = (data ?? []) as Record<string, unknown>[];

  // Where the answer is somewhere else: the passages the top results link to (the table or section they cite,
  // a figure's key, a passage sharing a unit number), ranked against the question by the same vectors, or by
  // keywords when there are none. Each is attached to the first result that points at it.
  const top = results.slice(0, 5);
  const shown = new Set(results.map((r) => r.id as string));
  type Link = { id: string | null; doc_id?: string; kind: "ref" | "key" | "shared" | "doc"; label: string; dir: string };
  const linksOf = (r: Record<string, unknown>) => (r.metadata as { links?: Link[] })?.links ?? [];
  const linkIds = [...new Set(top.flatMap((r) => linksOf(r).map((l) => l.id)).filter((id): id is string => !!id && !shown.has(id)))];
  if (linkIds.length) {
    const { data: ranked } = await sb.rpc("rank_linked", {
      p_ids: linkIds, query_text: query,
      q_local: vectors === "local" ? embedding : null, q_api: vectors === "api" ? embedding : null, p_limit: linkIds.length,
    });
    // A question that names a section, table or figure ("what does section 67 say") wants that one: links whose
    // label names it come first, the rest in the order the vectors gave. Five at most.
    const named = namedTargets(query);
    const labelOf = (id: unknown) => top.flatMap(linksOf).find((l) => l.id === id)?.label ?? "";
    const linked = ((ranked ?? []) as Record<string, unknown>[])
      .map((t, i) => ({ t, i, named: named.some((n) => n.test(labelOf(t.id))) }))
      .sort((a, b) => Number(b.named) - Number(a.named) || a.i - b.i).slice(0, 5).map((x) => x.t);
    for (const t of linked) {
      const owner = top.find((r) => linksOf(r).some((l) => l.id === t.id));
      const link = owner && linksOf(owner).find((l) => l.id === t.id);
      if (!owner || !link) continue;
      const list = ((owner.linked as unknown[]) ?? []);
      list.push({
        id: t.id, document_id: t.document_id, chunk_type: t.chunk_type, raw_text: t.raw_text, context: t.context,
        page_start: t.page_start, page_end: t.page_end, bboxes: t.bboxes, label: link.label, kind: link.kind, dir: link.dir,
        page_image_url: publicUrl(`documents/${t.document_id}/pages/${t.page_start}.png`),
      });
      owner.linked = list;
    }
  }

  // A result that cites another document with no section to point at ("as per SOP-QA-040"): that document is
  // searched with the same question and its best passage shown under the result. Two documents at most.
  const docLinks = top.flatMap((r) => linksOf(r).filter((l) => l.kind === "doc" && !l.id && l.doc_id).map((l) => ({ owner: r, link: l })))
    .filter((x, i, all) => all.findIndex((y) => y.link.doc_id === x.link.doc_id) === i).slice(0, 2);
  await Promise.all(docLinks.map(async ({ owner, link }) => {
    const { data: found } = await sb.rpc(vectors === "local" ? "hybrid_search_local" : "hybrid_search", {
      query_text: query, query_embedding: embedding, p_strategy: strategy,
      p_document_id: link.doc_id, match_count: 3, full_text_weight: 1.0, semantic_weight: embedding ? 1.0 : 0,
    });
    const t = ((found ?? []) as Record<string, unknown>[]).find((x) => !shown.has(x.id as string));
    if (!t) return;
    shown.add(t.id as string);
    owner.linked = [...((owner.linked as unknown[]) ?? []), {
      id: t.id, document_id: t.document_id, chunk_type: t.chunk_type, raw_text: t.raw_text, context: t.context,
      page_start: t.page_start, page_end: t.page_end, bboxes: t.bboxes, label: link.label, kind: "doc", dir: "out", via: "search",
      page_image_url: publicUrl(`documents/${t.document_id}/pages/${t.page_start}.png`),
    }];
  }));

  const linkedAll = results.flatMap((r) => (r.linked as Record<string, unknown>[] | undefined) ?? []);
  const docIds = [...new Set([...results, ...linkedAll].map((r) => r.document_id as string))];
  const { data: docs } = docIds.length ? await sb.from("documents").select("id,name").in("id", docIds) : { data: [] };
  const names = new Map((docs ?? []).map((d) => [d.id, d.name]));
  for (const r of results) {
    r.document_name = names.get(r.document_id as string) ?? "";
    r.page_image_url = publicUrl(`documents/${r.document_id}/pages/${r.page_start}.png`);
  }
  for (const l of linkedAll) l.document_name = names.get(l.document_id as string) ?? "";
  return NextResponse.json({ query, mode, embedded: embedding !== null, results });
}
