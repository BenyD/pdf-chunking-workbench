"use client";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import type { Chunk, Document, SearchResult, Strategy } from "@/lib/types";
import { STRATEGIES } from "@/lib/types";
import { api, publicAsset } from "@/lib/ui";
import { cn } from "@/lib/utils";
import { StrategyChip, TypeChip } from "./Chips";
import { StrategyMulti } from "./StrategyToggle";
import { ResultsSkeleton } from "./Skeletons";

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
  const [docs, setDocs] = useState<Document[]>([]);
  const [docId, setDocId] = useState<string | null>(sp.get("document_id"));
  const [q, setQ] = useState("");
  const [k, setK] = useState(6);
  const [selected, setSelected] = useState<Strategy[]>([...STRATEGIES]);
  const [weights, setWeights] = useState({ fts: 1, vec: 1 });
  const [res, setRes] = useState<Response | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { api<{ documents: Document[] }>("/api/documents").then((r) => setDocs(r.documents.filter((d) => d.status === "ready"))).catch(() => {}); }, []);

  async function run(query = q) {
    if (!query.trim()) return;
    setBusy(true); setErr(null); setOpen(null);
    try {
      setRes(await api<Response>("/api/search", { method: "POST", body: JSON.stringify({ query, strategies: selected, document_id: docId, k, full_text_weight: weights.fts, semantic_weight: weights.vec }) }));
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  const docItems = [{ value: null, label: "All documents" }, ...docs.map((d) => ({ value: d.id, label: d.name }))];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Search</h1>
        <p className="mt-1 text-sm text-muted-foreground">Ask a question and compare what each strategy returns.</p>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); run(); }} className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask something about the documents…" className="flex-1" />
        <div className="flex flex-wrap gap-2">
          <Select value={docId} onValueChange={(v) => setDocId(v as string | null)} items={docItems}>
            <SelectTrigger className="w-full sm:w-56"><SelectValue placeholder="All documents" /></SelectTrigger>
            <SelectContent>{docItems.map((it) => <SelectItem key={it.value ?? "all"} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
          </Select>
          <Input type="number" min={1} max={30} value={k} onChange={(e) => setK(Number(e.target.value))} className="w-16 text-center" aria-label="results per strategy" />
          <Button type="submit" disabled={busy} className="flex-1 sm:flex-none">{busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Search data-icon="inline-start" />}Search</Button>
        </div>
      </form>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <StrategyMulti selected={selected} onChange={setSelected} />
        <div className="flex items-center gap-2 text-xs text-muted-foreground sm:w-48"><span className="w-16 shrink-0">full text</span><Slider min={0} max={2} step={0.25} value={[weights.fts]} onValueChange={(v) => setWeights({ ...weights, fts: Array.isArray(v) ? v[0] : v })} /><span className="w-6">{weights.fts}</span></div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground sm:w-48"><span className="w-16 shrink-0">semantic</span><Slider min={0} max={2} step={0.25} value={[weights.vec]} onValueChange={(v) => setWeights({ ...weights, vec: Array.isArray(v) ? v[0] : v })} /><span className="w-6">{weights.vec}</span></div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map((ex) => <Badge key={ex} variant="outline" className="cursor-pointer hover:bg-muted" render={<button type="button" onClick={() => { setQ(ex); run(ex); }} />}>{ex}</Badge>)}
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      {busy && <ResultsSkeleton columns={selected.length} />}

      {res && !busy && (
        <>
          <p className="text-xs text-muted-foreground">{res.embedded ? `Embedded in ${res.embed_ms} ms, ` : "Full-text only, "}{res.total_ms} ms total</p>
          <div className={cn("grid gap-3", selected.length === 2 && "md:grid-cols-2", selected.length === 3 && "lg:grid-cols-3")}>
            {selected.map((s) => (
              <div key={s} className="space-y-2">
                <div className="flex items-center gap-2"><StrategyChip strategy={s} /><span className="text-xs text-muted-foreground">{(res.results[s] ?? []).length} results</span></div>
                {(res.results[s] ?? []).length === 0 && <p className="text-xs text-muted-foreground">no results</p>}
                {(res.results[s] ?? []).map((r, i) => <ResultCard key={r.id} r={r} rank={i + 1} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />)}
              </div>
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
    <div className={cn("rounded-xl border bg-card p-3 text-sm transition", open ? "border-foreground" : "border-border")}>
      <button type="button" onClick={onToggle} className="w-full text-left">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">#{rank}</span><TypeChip type={r.chunk_type} />
          <span className="max-w-[40vw] truncate sm:max-w-[12rem]">{r.document_name}</span><span>p.{r.page_start}</span>
          <span className="ml-auto whitespace-nowrap" title="fused score, rank in full-text list, rank in vector list">rrf {r.rrf_score.toFixed(4)}, fts {r.fts_rank ?? "–"}, vec {r.vec_rank ?? "–"}</span>
        </div>
        {r.context && <div className="mt-1 line-clamp-2 text-xs text-indigo-700 dark:text-indigo-300">{r.context}</div>}
        <div className={cn("mt-1 whitespace-pre-wrap text-foreground/90", !open && "line-clamp-4")}>{r.raw_text}</div>
      </button>
      {open && (
        <div className="mt-3 space-y-2 border-t pt-2 text-xs">
          {meta.image_path && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={publicAsset(meta.image_path)} alt="figure" className="max-h-56 rounded-lg border" />
          )}
          {box && (
            <div className="relative overflow-hidden rounded-lg border bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={r.page_image_url} alt="page" className="block w-full" />
              <div className="absolute border-2 border-indigo-600 bg-indigo-500/10" style={{ left: `${box.x0 * 100}%`, top: `${box.y0 * 100}%`, width: `${(box.x1 - box.x0) * 100}%`, height: `${(box.y1 - box.y0) * 100}%` }} />
            </div>
          )}
          {ctx?.parent && <div className="rounded-lg bg-amber-50 p-2 dark:bg-amber-950/40"><div className="mb-1 font-medium text-amber-800 dark:text-amber-200">parent table (retrieved small, expanded big)</div><pre className="max-h-48 overflow-auto font-mono text-[11px] whitespace-pre-wrap">{ctx.parent.raw_text}</pre></div>}
          {ctx && (ctx.prev || ctx.next) && (
            <div className="grid gap-2 md:grid-cols-2">
              {ctx.prev && <div className="rounded-lg bg-muted p-2"><div className="mb-1 font-medium">← previous chunk</div><div className="line-clamp-6 whitespace-pre-wrap">{ctx.prev.raw_text}</div></div>}
              {ctx.next && <div className="rounded-lg bg-muted p-2"><div className="mb-1 font-medium">next chunk →</div><div className="line-clamp-6 whitespace-pre-wrap">{ctx.next.raw_text}</div></div>}
            </div>
          )}
          {ctx && ctx.children.length > 0 && <div className="text-muted-foreground">{ctx.children.length} row chunks belong to this table.</div>}
        </div>
      )}
    </div>
  );
}
