"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, FileText, Loader2, Search, SearchX, Sparkle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { Chunk, Document, SearchResult } from "@/lib/types";
import { api, publicAsset } from "@/lib/ui";
import { cn } from "@/lib/utils";
import { TypeChip } from "./Chips";
import { EmptyState } from "./EmptyState";
import { PageHeader } from "./PageHeader";
import { Panel } from "./Panel";
import { PageSkeleton } from "./Skeletons";

type Hit = SearchResult & { page_image_url: string };
type Suggestion = { text: string; document_id: string; document_name: string };

export function SearchView() {
  const sp = useSearchParams();
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [docId, setDocId] = useState<string | null>(sp.get("document_id"));
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({});

  useEffect(() => { api<{ documents: Document[] }>("/api/documents").then((r) => setDocs(r.documents.filter((d) => d.status === "ready"))).catch(() => setDocs([])); }, []);
  useEffect(() => {
    setSuggestions(null);
    api<{ suggestions: Suggestion[] }>(`/api/suggestions${docId ? `?document_id=${docId}` : ""}`).then((r) => setSuggestions(r.suggestions)).catch(() => setSuggestions([]));
  }, [docId]);

  async function run(query = q) {
    if (!query.trim()) return;
    setBusy(true); setErr(null); setOpen(null); setAsked(query); setAnswer(null); setHits(null);
    let found: Hit[] = [];
    try {
      const r = await api<{ results: Hit[] }>("/api/search", { method: "POST", body: JSON.stringify({ query, document_id: docId, k: 8 }) });
      found = r.results; setHits(found);
    } catch (e) { setErr(String(e)); setHits([]); } finally { setBusy(false); }
    if (!found.length) return;
    setAnswerBusy(true);
    try {
      const passages = found.slice(0, 6).map((h, i) => ({ n: i + 1, text: h.raw_text, document_name: h.document_name?.replace(/\.pdf$/i, "") ?? "", page: h.page_start }));
      const r = await api<{ answer: string }>("/api/answer", { method: "POST", body: JSON.stringify({ query, passages }) });
      setAnswer(r.answer);
    } catch { setAnswer(""); } finally { setAnswerBusy(false); }
  }

  function jump(n: number) { cardRefs.current[n]?.scrollIntoView({ behavior: "smooth", block: "center" }); }

  const docItems = [{ value: null, label: "All documents" }, ...(docs ?? []).map((d) => ({ value: d.id, label: d.name.replace(/\.pdf$/i, "") }))];
  const header = <PageHeader title="Search" subtitle="Ask a question across your documents." />;
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
      <div className="flex-1">
        {!asked && (
          <div className="mx-auto flex max-w-3xl flex-col items-center justify-center px-2 py-10 text-center sm:py-16">
            <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted"><Search className="size-5" /></div>
            <h2 className="text-lg font-semibold">What do you want to know?</h2>
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
        {asked && (
          <div className="mx-auto max-w-4xl space-y-4">
            <h2 className="px-1 text-lg font-semibold">{asked}</h2>
            {err && <p className="px-1 text-sm text-destructive">{err}</p>}

            {(busy || answerBusy || answer) && (
              <div className="rounded-[1.25rem] bg-card p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)] ring-1 ring-inset ring-black/5">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Sparkle className="size-3.5" />Answer</div>
                {(busy || answerBusy) && <div className="space-y-2"><Skeleton className="h-4 w-11/12" /><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>}
                {!busy && !answerBusy && answer && <Answer text={answer} onJump={jump} />}
              </div>
            )}

            {busy && <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-[1.25rem]" />)}</div>}
            {!busy && hits && hits.length === 0 && <Panel><EmptyState icon={<SearchX />} title="No matches" hint="Try different words, or widen the search to all documents." /></Panel>}
            {!busy && hits && hits.length > 0 && (
              <div className="space-y-2">
                <div className="px-1 text-xs font-medium text-muted-foreground">Sources</div>
                {hits.map((r, i) => (
                  <div key={r.id} ref={(el) => { cardRefs.current[i + 1] = el; }}>
                    <ResultCard r={r} n={i + 1} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="sticky bottom-0 z-20 -mx-4 mt-6 bg-background/95 px-4 pt-3 pb-3 backdrop-blur sm:-mx-6 sm:px-6">
        <form onSubmit={(e) => { e.preventDefault(); run(); }} className="mx-auto flex max-w-4xl flex-col gap-2 rounded-2xl bg-card p-2 shadow-[0_2px_8px_rgba(16,24,40,0.08)] ring-1 ring-black/10 focus-within:ring-foreground/30 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-2 pl-2">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} placeholder="Ask something about the documents" className="h-10 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground" />
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
  );
}

/** Answer text with [n] citations rendered as small jump buttons. */
function Answer({ text, onJump }: { text: string; onJump: (n: number) => void }) {
  const parts = text.split(/(\[\d+\](?:\[\d+\])*)/g);
  return (
    <p className="text-[15px] leading-relaxed">
      {parts.map((part, i) => {
        const nums = part.match(/\d+/g);
        if (/^(\[\d+\])+$/.test(part) && nums) {
          return nums.map((n) => (
            <button key={`${i}-${n}`} type="button" onClick={() => onJump(Number(n))} className="mx-0.5 inline-flex size-5 -translate-y-px items-center justify-center rounded-full bg-muted align-middle text-[11px] font-medium text-foreground/80 ring-1 ring-inset ring-black/10 hover:bg-foreground hover:text-background">{n}</button>
          ));
        }
        return <span key={i}>{part}</span>;
      })}
    </p>
  );
}

function ResultCard({ r, n, open, onToggle }: { r: Hit; n: number; open: boolean; onToggle: () => void }) {
  type Ctx = { parent: Chunk | null; prev: Chunk | null; next: Chunk | null; children: Chunk[] };
  const [ctx, setCtx] = useState<Ctx | null>(null);
  useEffect(() => { if (open && !ctx) api<Ctx>(`/api/chunks/${r.id}`).then(setCtx).catch(() => {}); }, [open, ctx, r.id]);
  const box = r.bboxes.find((b) => b.page === r.page_start);
  const meta = r.metadata as { image_path?: string };
  return (
    <div className={cn("rounded-[1.25rem] bg-card p-3.5 text-sm shadow-[0_1px_2px_rgba(16,24,40,0.04)] ring-1 ring-inset transition", open ? "ring-foreground" : "ring-black/5 hover:ring-black/15")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-foreground/80 ring-1 ring-inset ring-black/10">{n}</span>
        <TypeChip type={r.chunk_type} />
        <span className="max-w-[40vw] truncate sm:max-w-[14rem]">{r.document_name?.replace(/\.pdf$/i, "")}</span><span>p.{r.page_start}</span>
        <Link href={`/documents/${r.document_id}?page=${r.page_start}`} className="ml-auto inline-flex items-center gap-0.5 whitespace-nowrap hover:text-foreground">Open page<ArrowUpRight className="size-3.5" /></Link>
      </div>
      <button type="button" onClick={onToggle} className="mt-1 w-full text-left">
        {r.context && <div className="line-clamp-2 text-xs text-muted-foreground">{r.context}</div>}
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
          {ctx?.parent && <div className="rounded-xl bg-amber-50 p-3 dark:bg-amber-950/40"><div className="mb-1 font-medium text-amber-800 dark:text-amber-200">The whole table</div><pre className="max-h-48 overflow-auto font-mono text-[11px] whitespace-pre-wrap">{ctx.parent.raw_text}</pre></div>}
          {ctx && (ctx.prev || ctx.next) && (
            <div className="grid gap-2 md:grid-cols-2">
              {ctx.prev && <div className="rounded-xl bg-muted p-3"><div className="mb-1 font-medium">Before</div><div className="line-clamp-6 whitespace-pre-wrap">{ctx.prev.raw_text}</div></div>}
              {ctx.next && <div className="rounded-xl bg-muted p-3"><div className="mb-1 font-medium">After</div><div className="line-clamp-6 whitespace-pre-wrap">{ctx.next.raw_text}</div></div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
