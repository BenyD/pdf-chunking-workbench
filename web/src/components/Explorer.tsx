"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowLeft, ChevronLeft, ChevronRight, FlaskConical, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ChunkListSkeleton, ExplorerSkeleton } from "./Skeletons";
import { EmptyState } from "./EmptyState";
import { Progress } from "@/components/ui/progress";
import type { Chunk, Document, Page, Strategy } from "@/lib/types";
import { api, fmtNum, publicAsset, STRATEGY_INFO } from "@/lib/ui";
import { cn } from "@/lib/utils";
import { StatusBadge, TypeChip } from "./Chips";
import { PageViewer, type Overlay } from "./PageViewer";
import { StrategyTabs } from "./StrategyToggle";

type Stats = {
  strategies?: Record<Strategy, { chunks: number; tokens: number; avg_tokens: number; by_type: Record<string, number> }>;
  llm?: Record<string, number>; seconds?: number; scanned_pages?: number; embedding_model?: string;
};

export function Explorer({ id }: { id: string }) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [pageNo, setPageNo] = useState(1);
  const [strategy, setStrategy] = useState<Strategy>("structural");
  const [chunks, setChunks] = useState<Chunk[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showRows, setShowRows] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadDoc = useCallback(async () => {
    const r = await api<{ document: Document; pages: Page[] }>(`/api/documents/${id}`);
    setDoc(r.document); setPages(r.pages);
  }, [id]);

  useEffect(() => { loadDoc().catch((e) => setErr(String(e))); }, [loadDoc]);
  useEffect(() => {
    if (!doc || ["ready", "error"].includes(doc.status)) return;
    const t = setInterval(() => loadDoc().catch(() => {}), 2500);
    return () => clearInterval(t);
  }, [doc, loadDoc]);
  useEffect(() => {
    if (!doc || doc.status !== "ready") return;
    setChunks(null);
    api<{ chunks: Chunk[] }>(`/api/documents/${id}/chunks?strategy=${strategy}&page=${pageNo}&limit=1000`)
      .then((r) => { setChunks(r.chunks); setSelected(null); })
      .catch((e) => setErr(String(e)));
  }, [id, strategy, pageNo, doc]);

  const page = pages.find((p) => p.page_number === pageNo);
  const visible = useMemo(() => (chunks ?? []).filter((c) => showRows || c.chunk_type !== "table_row"), [chunks, showRows]);
  const overlays: Overlay[] = useMemo(() => visible.flatMap((c) => c.bboxes.filter((b) => b.page === pageNo).map((b, i) => ({
    id: `${c.id}:${i}`, type: c.chunk_type, box: b, selected: selected === c.id, label: `${c.chunk_type}, ${c.token_count} tokens`,
  }))), [visible, pageNo, selected]);
  const sel = chunks?.find((c) => c.id === selected) ?? null;
  const stats = (doc?.stats ?? {}) as Stats;
  const total = doc?.page_count ?? 1;

  if (err) return <p className="text-sm text-destructive">{err}</p>;
  if (!doc) return <ExplorerSkeleton />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/" />}><ArrowLeft data-icon="inline-start" />Documents</Button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold sm:text-xl">{doc.name}</h1>
        <StatusBadge status={doc.status} />
        {doc.status === "processing" && <span className="text-xs text-muted-foreground">{doc.progress.stage} {doc.progress.total ? `${doc.progress.done ?? 0} of ${doc.progress.total}` : ""}</span>}
        {doc.status === "error" && <span className="text-xs text-destructive">{doc.progress.message}</span>}
        <div className="flex w-full gap-2 sm:ml-auto sm:w-auto">
          <Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/search?document_id=${doc.id}`} />}><Search data-icon="inline-start" />Search</Button>
          <Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/eval?document_id=${doc.id}`} />}><FlaskConical data-icon="inline-start" />Evaluate</Button>
        </div>
      </div>

      {stats.strategies && (
        <div className="grid gap-3 md:grid-cols-3">
          {(Object.keys(STRATEGY_INFO) as Strategy[]).map((s) => {
            const st = stats.strategies?.[s];
            if (!st) return null;
            return (
              <button key={s} type="button" onClick={() => setStrategy(s)} className={cn("rounded-xl border bg-card p-4 text-left text-sm transition hover:bg-muted/40", strategy === s ? "border-foreground shadow-sm" : "border-border")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{STRATEGY_INFO[s].label}</span>
                  <span className="text-xs text-muted-foreground">{fmtNum(st.chunks)} chunks, avg {st.avg_tokens} tokens</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {Object.entries(st.by_type).map(([t, n]) => <TypeChip key={t} type={t as Chunk["chunk_type"]} count={n} />)}
                </div>

              </button>
            );
          })}
        </div>
      )}
      {stats.llm && (
        <p className="text-xs text-muted-foreground">
          {doc.page_count} pages{stats.scanned_pages ? ` (${stats.scanned_pages} scanned)` : ""}, {stats.llm.context_calls ?? 0} context calls, {stats.llm.vision_calls ?? 0} vision calls{stats.llm.errors ? `, ${stats.llm.errors} model errors` : ""}, processed in {stats.seconds}s
        </p>
      )}

      {doc.status !== "ready" && doc.status !== "error" && (
        <EmptyState icon={<Loader2 className="animate-spin" />} title="Processing this document" hint={`${doc.progress.stage ?? "queued"}${doc.progress.total ? `, ${doc.progress.done ?? 0} of ${doc.progress.total}` : ""}. This page updates by itself.`}>
          {doc.progress.total ? <Progress value={Math.round(((doc.progress.done ?? 0) / doc.progress.total) * 100)} className="w-64" /> : null}
        </EmptyState>
      )}
      {doc.status === "error" && (
        <EmptyState icon={<AlertCircle />} title="Processing failed" hint={doc.progress.message ?? "Unknown error"}>
          <Button variant="outline" onClick={() => api(`/api/documents/${doc.id}/ingest`, { method: "POST" }).then(loadDoc)}>Try again</Button>
        </EmptyState>
      )}
      {doc.status === "ready" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <StrategyTabs value={strategy} onChange={setStrategy} />
              <div className="ml-auto flex items-center gap-1">
                <Button variant="outline" size="icon-sm" onClick={() => setPageNo((p) => Math.max(1, p - 1))} aria-label="previous page"><ChevronLeft /></Button>
                <Input type="number" min={1} max={total} value={pageNo} onChange={(e) => setPageNo(Math.min(Math.max(1, Number(e.target.value) || 1), total))} className="h-7 w-16 text-center" />
                <span className="text-xs text-muted-foreground">/ {total}</span>
                <Button variant="outline" size="icon-sm" onClick={() => setPageNo((p) => Math.min(total, p + 1))} aria-label="next page"><ChevronRight /></Button>
              </div>
            </div>
            {page ? (
              <PageViewer imageUrl={page.image_url ?? publicAsset(page.image_path)} overlays={overlays} onSelect={(oid) => setSelected(oid.split(":")[0])} />
            ) : <Skeleton className="aspect-[1/1.41] w-full" />}
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>{chunks === null ? "loading chunks…" : `${visible.length} ${strategy} chunks on this page`}{page?.is_scanned ? ", scanned page, text from OCR" : ""}</span>
              <Label className="ml-auto flex items-center gap-1.5 text-xs"><Checkbox checked={showRows} onCheckedChange={(c) => setShowRows(!!c)} /> show row chunks</Label>
            </div>
          </div>

          <div className="space-y-2 lg:max-h-[82vh] lg:overflow-y-auto lg:pr-1">
            {sel && <ChunkDetail chunk={sel} onClose={() => setSelected(null)} />}
            {chunks === null && <ChunkListSkeleton />}
            {chunks !== null && visible.length === 0 && <EmptyState icon={<Search />} title="No chunks on this page" hint="This page has no text in this strategy, or only row chunks that are hidden." className="py-8" />}
            {visible.map((c) => (
              <button key={c.id} type="button" onClick={() => setSelected(c.id)} className={cn("block w-full rounded-xl border bg-card p-3 text-left text-sm transition hover:bg-muted/40", selected === c.id ? "border-foreground" : "border-border")}>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <TypeChip type={c.chunk_type} /><span>#{c.ordinal}</span><span>p.{c.page_start}{c.page_end !== c.page_start ? `–${c.page_end}` : ""}</span><span className="ml-auto">{c.token_count} tok</span>
                </div>
                {c.context && <div className="mt-1 truncate text-xs text-primary">{c.context.split("\n").slice(-1)[0]}</div>}
                <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-foreground/90">{c.raw_text}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChunkDetail({ chunk, onClose }: { chunk: Chunk; onClose: () => void }) {
  const meta = chunk.metadata as { image_path?: string; vision?: { subject?: string; description?: string; annotations?: { marker: string; points_to: string; text: string }[] }; header?: string[]; row_count?: number; parts?: number; part?: number };
  return (
    <Card size="sm" className="border-foreground">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xs font-normal text-muted-foreground"><TypeChip type={chunk.chunk_type} /><span>#{chunk.ordinal}</span><span>{chunk.token_count} tokens</span></CardTitle>
        <CardDescription className="sr-only">Selected chunk</CardDescription>
        <Button variant="ghost" size="icon-xs" className="absolute top-3 right-3" onClick={onClose} aria-label="close"><X /></Button>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {meta.image_path && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={publicAsset(meta.image_path)} alt="figure" className="max-h-64 rounded-lg border" />
        )}
        {chunk.context && (
          <div className="rounded-lg bg-primary/5 p-2 text-xs text-foreground">
            <div className="mb-1 text-[10px] font-medium tracking-wide text-primary uppercase">context prepended before embedding</div>
            <div className="whitespace-pre-wrap">{chunk.context}</div>
          </div>
        )}
        {meta.vision && (
          <div className="rounded-lg bg-fuchsia-50 p-2 text-xs text-fuchsia-950 dark:bg-fuchsia-950/40 dark:text-fuchsia-100">
            <div className="mb-1 text-[10px] font-medium tracking-wide text-fuchsia-500 uppercase">vision model description</div>
            <div className="font-medium">{meta.vision.subject}</div>
            <div className="mt-1">{meta.vision.description}</div>
            {meta.vision.annotations?.length ? <ul className="mt-1 list-disc pl-4">{meta.vision.annotations.map((a, i) => <li key={i}><b>{a.marker}</b> → {a.points_to}{a.text ? ` — “${a.text}”` : ""}</li>)}</ul> : null}
          </div>
        )}
        {chunk.chunk_type === "table" && <div className="text-xs text-muted-foreground">{meta.row_count} rows{meta.parts && meta.parts > 1 ? `, part ${meta.part} of ${meta.parts}, header repeated` : ""}, {meta.header?.length} columns</div>}
        <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{chunk.raw_text}</pre>
        <div className="flex gap-3 text-xs text-muted-foreground">
          {chunk.parent_id && <span>has parent table</span>}{chunk.prev_id && <span>← prev</span>}{chunk.next_id && <span>next →</span>}
        </div>
      </CardContent>
    </Card>
  );
}
