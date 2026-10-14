"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowUp, FileText, Loader2, Search, SearchX, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import type { Chunk, Document, SearchResult, Strategy } from "@/lib/types";
import { STRATEGIES } from "@/lib/types";
import { api, publicAsset } from "@/lib/ui";
import { cn } from "@/lib/utils";
import { StrategyChip, TypeChip } from "./Chips";
import { EmptyState } from "./EmptyState";
import { Panel } from "./Panel";
import { ResultsSkeleton } from "./Skeletons";
import { StrategyMulti } from "./StrategyToggle";

type Hit = SearchResult & { page_image_url: string };
type Results = Record<string, Hit[]>;
type Response = { results: Results; embedded: boolean; embed_ms: number; total_ms: number };

const EXAMPLES = [
  "What is the punishment for murder?",
  "Is theft cognizable and bailable?",
  "Which utensil had a dent on the rim and how deep was it?",
  "ceiling price of Atorvastatin 10 mg tablets",
  "what did the crack look like on the spoon",
];

export function SearchView() {
  const sp = useSearchParams();
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [docId, setDocId] = useState<string | null>(sp.get("document_id"));
  const [q, setQ] = useState("");
  const [k, setK] = useState(6);
  const [selected, setSelected] = useState<Strategy[]>([...STRATEGIES]);
  const [weights, setWeights] = useState({ fts: 1, vec: 1 });
  const [showOptions, setShowOptions] = useState(false);
  const [res, setRes] = useState<Response | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { api<{ documents: Document[] }>("/api/documents").then((r) => setDocs(r.documents.filter((d) => d.status === "ready"))).catch(() => setDocs([])); }, []);

  async function run(query = q) {
    if (!query.trim()) return;
    setBusy(true); setErr(null); setOpen(null);
    try {
      setRes(await api<Response>("/api/search", { method: "POST", body: JSON.stringify({ query, strategies: selected, document_id: docId, k, full_text_weight: weights.fts, semantic_weight: weights.vec }) }));
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  const docItems = [{ value: null, label: "All documents" }, ...(docs ?? []).map((d) => ({ value: d.id, label: d.name.replace(/\.pdf$/i, "") }))];
  const noHits = res && selected.every((s) => (res.results[s] ?? []).length === 0);

  if (docs && docs.length === 0) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <Panel>
          <EmptyState icon={<FileText />} title="Nothing to search yet" hint="Add a document first. Once it finishes processing it shows up here.">
            <Button nativeButton={false} render={<Link href="/" />}>Go to Documents</Button>
          </EmptyState>
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <p className="mt-1 text-sm text-muted-foreground">Ask a question and compare what each strategy returns.</p>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); run(); }} className="flex items-center gap-2 bg-card p-1.5 pl-4 shadow-[0_1px_2px_rgba(16,24,40,0.06)] ring-1 ring-black/10 focus-within:ring-foreground/40">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask something about the documents" className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground" />
        <Button type="submit" size="icon-lg" disabled={busy || !q.trim()} aria-label="search">{busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}</Button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={docId} onValueChange={(v) => setDocId(v as string | null)} items={docItems}>
          <SelectTrigger size="sm" className="max-w-[60vw] bg-card sm:max-w-xs"><SelectValue placeholder="All documents" /></SelectTrigger>
          <SelectContent>{docItems.map((it) => <SelectItem key={it.value ?? "all"} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
        </Select>
        <StrategyMulti selected={selected} onChange={setSelected} />
        <button type="button" onClick={() => setShowOptions((o) => !o)} aria-pressed={showOptions} className={cn("flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm ring-1 ring-inset transition-colors", showOptions ? "bg-foreground text-background ring-foreground" : "bg-card text-muted-foreground ring-border hover:text-foreground")}>
          <SlidersHorizontal className="size-3.5" />Options
        </button>
      </div>
      {showOptions && (
        <div className="grid gap-3 rounded-[1.25rem] bg-muted/80 p-4 sm:grid-cols-3">
          <label className="flex items-center gap-3 text-sm"><span className="w-24 text-muted-foreground">Results</span><input type="number" min={1} max={30} value={k} onChange={(e) => setK(Number(e.target.value))} className="h-8 w-16 bg-card text-center ring-1 ring-border" /></label>
          <label className="flex items-center gap-3 text-sm"><span className="w-24 text-muted-foreground">Keyword</span><Slider min={0} max={2} step={0.25} value={[weights.fts]} onValueChange={(v) => setWeights({ ...weights, fts: Array.isArray(v) ? v[0] : v })} /><span className="w-8 text-right text-xs">{weights.fts}</span></label>
          <label className="flex items-center gap-3 text-sm"><span className="w-24 text-muted-foreground">Meaning</span><Slider min={0} max={2} step={0.25} value={[weights.vec]} onValueChange={(v) => setWeights({ ...weights, vec: Array.isArray(v) ? v[0] : v })} /><span className="w-8 text-right text-xs">{weights.vec}</span></label>
        </div>
      )}
      {!res && !busy && (
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => <button key={ex} type="button" onClick={() => { setQ(ex); run(ex); }} className="rounded-full bg-muted px-3 py-1.5 text-sm text-foreground/80 transition-colors hover:bg-accent hover:text-foreground">{ex}</button>)}
        </div>
      )}
      {err && <p className="text-sm text-destructive">{err}</p>}
      {busy && <ResultsSkeleton columns={selected.length} />}

      {res && !busy && noHits && <Panel><EmptyState icon={<SearchX />} title="No matches" hint="Try different words, or widen the search to all documents." /></Panel>}
      {res && !busy && !noHits && (
        <>
          <p className="px-1 text-xs text-muted-foreground">{res.embedded ? `Embedded in ${res.embed_ms} ms, ` : "Full text only, "}{res.total_ms} ms total</p>
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
        </>
      )}
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
