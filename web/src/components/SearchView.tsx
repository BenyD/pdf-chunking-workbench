"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { FileText, Loader2, Search, SearchX, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import type { Chunk, Document, SearchResult, Strategy } from "@/lib/types";
import { STRATEGIES } from "@/lib/types";
import { api, publicAsset } from "@/lib/ui";
import { cn } from "@/lib/utils";
import { StrategyChip, TypeChip } from "./Chips";
import { EmptyState } from "./EmptyState";
import { PageHeader } from "./PageHeader";
import { Panel } from "./Panel";
import { PageSkeleton, ResultsSkeleton } from "./Skeletons";
import { StrategyMulti } from "./StrategyToggle";

type Hit = SearchResult & { page_image_url: string };
type Results = Record<string, Hit[]>;
type Response = { results: Results; embedded: boolean; embed_ms: number; total_ms: number };
type Suggestion = { text: string; document_id: string; document_name: string };

export function SearchView() {
  const sp = useSearchParams();
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [docId, setDocId] = useState<string | null>(sp.get("document_id"));
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const [k, setK] = useState(6);
  const [selected, setSelected] = useState<Strategy[]>([...STRATEGIES]);
  const [weights, setWeights] = useState({ fts: 1, vec: 1 });
  const [showOptions, setShowOptions] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [res, setRes] = useState<Response | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { api<{ documents: Document[] }>("/api/documents").then((r) => setDocs(r.documents.filter((d) => d.status === "ready"))).catch(() => setDocs([])); }, []);
  useEffect(() => {
    setSuggestions(null);
    api<{ suggestions: Suggestion[] }>(`/api/suggestions${docId ? `?document_id=${docId}` : ""}`).then((r) => setSuggestions(r.suggestions)).catch(() => setSuggestions([]));
  }, [docId]);

  async function run(query = q) {
    if (!query.trim()) return;
    setBusy(true); setErr(null); setOpen(null); setAsked(query);
    try {
      setRes(await api<Response>("/api/search", { method: "POST", body: JSON.stringify({ query, strategies: selected, document_id: docId, k, full_text_weight: weights.fts, semantic_weight: weights.vec }) }));
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  const docItems = [{ value: null, label: "All documents" }, ...(docs ?? []).map((d) => ({ value: d.id, label: d.name.replace(/\.pdf$/i, "") }))];
  const noHits = res && selected.every((s) => (res.results[s] ?? []).length === 0);

  const header = <PageHeader title="Search" subtitle="Ask a question and compare what each strategy returns." />;
  if (docs === null) return <>{header}<PageSkeleton panels={0} /></>;
  if (docs.length === 0) {
    return (
      <>{header}<Panel>
        <EmptyState icon={<FileText />} title="Nothing to search yet" hint="Add a document first. Once it finishes processing it shows up here.">
          <Button nativeButton={false} render={<Link href="/" />}>Go to Documents</Button>
        </EmptyState>
      </Panel></>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      {header}
      {/* conversation area */}
      <div className="flex-1">
        {!res && !busy && (
          <div className="mx-auto flex max-w-3xl flex-col items-center justify-center px-2 py-10 text-center sm:py-16">
            <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted"><Search className="size-5" /></div>
            <h2 className="text-lg font-semibold">What do you want to find?</h2>
            <p className="mt-1 text-sm text-muted-foreground">{docId ? "Questions this document can answer" : "A few questions the documents can answer"}</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {suggestions === null && Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-56 rounded-full" />)}
              {suggestions?.map((s, i) => (
                <button key={`${i}-${s.text}`} type="button" onClick={() => { setQ(s.text); run(s.text); }} title={docId ? undefined : s.document_name}
                  className="rounded-full bg-card px-3.5 py-2 text-sm text-foreground/85 ring-1 ring-inset ring-black/10 transition-colors hover:bg-muted hover:text-foreground">
                  {s.text}
                </button>
              ))}
              {suggestions?.length === 0 && <p className="text-sm text-muted-foreground">No suggestions for this document yet. Type a question below.</p>}
            </div>
          </div>
        )}
        {(res || busy) && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
              <h2 className="text-lg font-semibold">{asked}</h2>
              {res && !busy && <span className="text-xs text-muted-foreground">{res.embedded ? `embedded in ${res.embed_ms} ms, ` : "full text only, "}{res.total_ms} ms</span>}
            </div>
            {err && <p className="text-sm text-destructive">{err}</p>}
            {busy && <ResultsSkeleton columns={selected.length} />}
            {res && !busy && noHits && <Panel><EmptyState icon={<SearchX />} title="No matches" hint="Try different words, or widen the search to all documents." /></Panel>}
            {res && !busy && !noHits && (
              <div className={cn("grid gap-4", selected.length === 2 && "md:grid-cols-2", selected.length === 3 && "lg:grid-cols-3")}>
                {selected.map((s) => (
                  <Panel key={s} title={<StrategyChip strategy={s} />} description={`${(res.results[s] ?? []).length} results`} bodyClassName="bg-transparent p-0 shadow-none">
                    <div className="space-y-2">
                      {(res.results[s] ?? []).length === 0 && <div className="rounded-[1.25rem] bg-card p-4 text-center text-xs text-muted-foreground">no results</div>}
                      {(res.results[s] ?? []).map((r, i) => <ResultCard key={r.id} r={r} rank={i + 1} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />)}
                    </div>
                  </Panel>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* composer, pinned to the bottom */}
      <div className="sticky bottom-0 z-20 -mx-4 mt-6 bg-background/95 px-4 pt-3 pb-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="mx-auto max-w-5xl space-y-2">
          <div className="flex flex-wrap items-center gap-2 px-1">
            <span className="text-xs text-muted-foreground">Compare</span>
            <StrategyMulti selected={selected} onChange={setSelected} />
            <button type="button" onClick={() => setShowOptions((o) => !o)} aria-pressed={showOptions} className={cn("ml-auto flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm ring-1 ring-inset transition-colors", showOptions ? "bg-foreground text-background ring-foreground" : "bg-card text-muted-foreground ring-border hover:text-foreground")}>
              <SlidersHorizontal className="size-3.5" />Options
            </button>
          </div>
          {showOptions && (
            <div className="grid gap-3 rounded-[1.25rem] bg-muted/80 p-4 sm:grid-cols-3">
              <label className="flex items-center gap-3 text-sm"><span className="w-24 text-muted-foreground">Results</span><input type="number" min={1} max={30} value={k} onChange={(e) => setK(Number(e.target.value))} className="h-8 w-16 rounded-lg bg-card text-center ring-1 ring-border" /></label>
              <label className="flex items-center gap-3 text-sm"><span className="w-24 text-muted-foreground">Keyword</span><Slider min={0} max={2} step={0.25} value={[weights.fts]} onValueChange={(v) => setWeights({ ...weights, fts: Array.isArray(v) ? v[0] : v })} /><span className="w-8 text-right text-xs">{weights.fts}</span></label>
              <label className="flex items-center gap-3 text-sm"><span className="w-24 text-muted-foreground">Meaning</span><Slider min={0} max={2} step={0.25} value={[weights.vec]} onValueChange={(v) => setWeights({ ...weights, vec: Array.isArray(v) ? v[0] : v })} /><span className="w-8 text-right text-xs">{weights.vec}</span></label>
            </div>
          )}
          <form onSubmit={(e) => { e.preventDefault(); run(); }} className="flex flex-col gap-2 rounded-2xl bg-card p-2 shadow-[0_2px_8px_rgba(16,24,40,0.08)] ring-1 ring-black/10 focus-within:ring-foreground/30 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-2 pl-2">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask something about the documents" className="h-10 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground" />
            </div>
            <div className="flex items-center gap-2 sm:border-l sm:pl-2">
              <Select value={docId} onValueChange={(v) => setDocId(v as string | null)} items={docItems}>
                <SelectTrigger className="h-10 max-w-[55vw] border-0 bg-muted/70 sm:max-w-[16rem]" aria-label="search in"><SelectValue placeholder="All documents" /></SelectTrigger>
                <SelectContent className="min-w-[18rem]" side="top">{docItems.map((it) => <SelectItem key={it.value ?? "all"} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
              </Select>
              <Button type="submit" size="lg" className="h-10 px-4" disabled={busy || !q.trim()}>{busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}Search</Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function ResultCard({ r, rank, open, onToggle }: { r: Hit; rank: number; open: boolean; onToggle: () => void }) {
  type Ctx = { parent: Chunk | null; prev: Chunk | null; next: Chunk | null; children: Chunk[] };
  const [ctx, setCtx] = useState<Ctx | null>(null);
  useEffect(() => { if (open && !ctx) api<Ctx>(`/api/chunks/${r.id}`).then(setCtx).catch(() => {}); }, [open, ctx, r.id]);
  const box = r.bboxes.find((b) => b.page === r.page_start);
  const meta = r.metadata as { image_path?: string };
  return (
    <div className={cn("rounded-[1.25rem] bg-card p-3.5 text-sm shadow-[0_1px_2px_rgba(16,24,40,0.04)] ring-1 ring-inset transition", open ? "ring-foreground" : "ring-black/5 hover:ring-black/15")}>
      <button type="button" onClick={onToggle} className="w-full text-left">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">#{rank}</span><TypeChip type={r.chunk_type} />
          <span className="max-w-[40vw] truncate sm:max-w-[11rem]">{r.document_name?.replace(/\.pdf$/i, "")}</span><span>p.{r.page_start}</span>
          <span className="ml-auto whitespace-nowrap" title="fused score, rank by keywords, rank by meaning">rrf {r.rrf_score.toFixed(3)}, fts {r.fts_rank ?? "–"}, vec {r.vec_rank ?? "–"}</span>
        </div>
        {r.context && <div className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{r.context}</div>}
        <div className={cn("mt-1 whitespace-pre-wrap text-foreground/90", !open && "line-clamp-4")}>{r.raw_text}</div>
      </button>
      {open && (
        <div className="mt-3 space-y-2 border-t pt-3 text-xs">
          {meta.image_path && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={publicAsset(meta.image_path)} alt="figure" className="max-h-56 rounded-xl ring-1 ring-black/5" />
          )}
          {box && (
            <div className="relative overflow-hidden rounded-xl bg-white ring-1 ring-black/5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={r.page_image_url} alt="page" className="block w-full" />
              <div className="absolute border-2 border-foreground bg-foreground/10" style={{ left: `${box.x0 * 100}%`, top: `${box.y0 * 100}%`, width: `${(box.x1 - box.x0) * 100}%`, height: `${(box.y1 - box.y0) * 100}%` }} />
            </div>
          )}
          {!ctx && <div className="space-y-2"><Skeleton className="h-3 w-1/3" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-5/6" /></div>}
          {ctx?.parent && <div className="rounded-xl bg-amber-50 p-3 dark:bg-amber-950/40"><div className="mb-1 font-medium text-amber-800 dark:text-amber-200">Parent table</div><pre className="max-h-48 overflow-auto font-mono text-[11px] whitespace-pre-wrap">{ctx.parent.raw_text}</pre></div>}
          {ctx && (ctx.prev || ctx.next) && (
            <div className="grid gap-2 md:grid-cols-2">
              {ctx.prev && <div className="rounded-xl bg-muted p-3"><div className="mb-1 font-medium">Previous chunk</div><div className="line-clamp-6 whitespace-pre-wrap">{ctx.prev.raw_text}</div></div>}
              {ctx.next && <div className="rounded-xl bg-muted p-3"><div className="mb-1 font-medium">Next chunk</div><div className="line-clamp-6 whitespace-pre-wrap">{ctx.next.raw_text}</div></div>}
            </div>
          )}
          {ctx && ctx.children.length > 0 && <div className="text-muted-foreground">{ctx.children.length} row chunks belong to this table.</div>}
        </div>
      )}
    </div>
  );
}
