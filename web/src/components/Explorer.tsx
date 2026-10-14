"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, FlaskConical, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Chunk, Document, Page, Strategy } from "@/lib/types";
import { api, fmtNum, publicAsset, stageLabel, STRATEGY_INFO } from "@/lib/ui";
import { cn } from "@/lib/utils";
import { StatusBadge, TypeChip } from "./Chips";
import { Donut } from "./Donut";
import { EmptyState } from "./EmptyState";
import { PageHeader } from "./PageHeader";
import { PageViewer, type Overlay } from "./PageViewer";
import { Panel } from "./Panel";
import { ChunkListSkeleton, ExplorerSkeleton } from "./Skeletons";
import { StrategyTabs } from "./StrategyToggle";

type Stats = { strategies?: Record<Strategy, { chunks: number; avg_tokens: number; by_type: Record<string, number> }> };

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
  const st = stats.strategies?.[strategy];
  const total = doc?.page_count ?? 1;
  const pct = doc?.progress.total ? Math.round(((doc.progress.done ?? 0) / doc.progress.total) * 100) : null;

  if (err) return <p className="text-sm text-destructive">{err}</p>;
  if (!doc) return <ExplorerSkeleton />;

  return (
    <div className="space-y-4">
      <PageHeader
        parent={{ label: "Documents", href: "/" }}
        title={doc.name.replace(/\.pdf$/i, "")}
        subtitle={<span className="flex flex-wrap items-center gap-2">{doc.page_count ? `${fmtNum(doc.page_count)} pages` : null}{doc.status !== "ready" && <StatusBadge status={doc.status} detail={doc.status === "processing" ? stageLabel(doc.progress.stage) : undefined} progress={pct} />}</span>}
        actions={<>
          <Button variant="outline" nativeButton={false} render={<Link href={`/search?document_id=${doc.id}`} />}><Search data-icon="inline-start" />Search</Button>
          <Button variant="outline" nativeButton={false} render={<Link href={`/eval?document_id=${doc.id}`} />}><FlaskConical data-icon="inline-start" />Evaluate</Button>
        </>}
      />
      <div className="flex flex-wrap items-center gap-3">
        <StrategyTabs value={strategy} onChange={setStrategy} />
        {st && <span className="text-sm text-muted-foreground">{fmtNum(st.chunks)} chunks</span>}
        <span className="hidden text-sm text-muted-foreground md:inline">{STRATEGY_INFO[strategy].blurb}</span>
      </div>

      {doc.status !== "ready" && doc.status !== "error" && (
        <Panel>
          <EmptyState icon={<Donut value={pct} size={24} stroke={3} />} title="Processing this document" hint={`${stageLabel(doc.progress.stage)}${doc.progress.total ? `, ${doc.progress.done ?? 0} of ${doc.progress.total}` : ""}. This page updates by itself.`} />
        </Panel>
      )}
      {doc.status === "error" && (
        <Panel>
          <EmptyState icon={<AlertCircle />} title="Processing failed" hint={doc.progress.message ?? "Unknown error"}>
            <Button variant="outline" onClick={() => api(`/api/documents/${doc.id}/ingest`, { method: "POST" }).then(loadDoc)}>Try again</Button>
          </EmptyState>
        </Panel>
      )}

      {doc.status === "ready" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title={`Page ${pageNo} of ${total}`}
            action={
              <div className="flex items-center gap-2">
                <Label className="flex items-center gap-1.5 text-xs text-muted-foreground"><Checkbox checked={showRows} onCheckedChange={(c) => setShowRows(!!c)} /> table rows</Label>
                <Button variant="ghost" size="icon-sm" onClick={() => setPageNo((p) => Math.max(1, p - 1))} aria-label="previous page"><ChevronLeft /></Button>
                <Input type="number" min={1} max={total} value={pageNo} onChange={(e) => setPageNo(Math.min(Math.max(1, Number(e.target.value) || 1), total))} className="h-7 w-14 bg-card text-center" />
                <Button variant="ghost" size="icon-sm" onClick={() => setPageNo((p) => Math.min(total, p + 1))} aria-label="next page"><ChevronRight /></Button>
              </div>
            }
            bodyClassName="p-2"
          >
            {page ? <PageViewer imageUrl={page.image_url ?? publicAsset(page.image_path)} overlays={overlays} onSelect={(oid) => setSelected(oid.split(":")[0])} className="rounded-[1rem] border-0 ring-1 ring-black/5" /> : <ChunkListSkeleton count={1} />}
          </Panel>

          <Panel title="Chunks" description={chunks === null ? "Loading" : `${visible.length} on this page`} bodyClassName="bg-transparent p-0 shadow-none">
            <div className="space-y-2 lg:max-h-[78vh] lg:overflow-y-auto">
              {sel && <ChunkDetail chunk={sel} onClose={() => setSelected(null)} />}
              {chunks === null && <ChunkListSkeleton />}
              {chunks !== null && visible.length === 0 && <div className="rounded-[1.25rem] bg-card"><EmptyState icon={<Search />} title="No chunks on this page" hint="Nothing in this strategy lands here, or only hidden table rows do." className="py-8" /></div>}
              {visible.map((c) => (
                <button key={c.id} type="button" onClick={() => setSelected(c.id)} className={cn("block w-full rounded-[1.25rem] bg-card p-3.5 text-left text-sm shadow-[0_1px_2px_rgba(16,24,40,0.04)] ring-1 ring-inset transition", selected === c.id ? "ring-foreground" : "ring-black/5 hover:ring-black/15")}>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <TypeChip type={c.chunk_type} /><span>p.{c.page_start}{c.page_end !== c.page_start ? `–${c.page_end}` : ""}</span><span className="ml-auto">{c.token_count} tokens</span>
                  </div>
                  {c.context && <div className="mt-1.5 truncate text-xs text-muted-foreground">{c.context.split("\n").slice(-1)[0]}</div>}
                  <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-foreground/90">{c.raw_text}</div>
                </button>
              ))}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

function ChunkDetail({ chunk, onClose }: { chunk: Chunk; onClose: () => void }) {
  const meta = chunk.metadata as { image_path?: string; vision?: { subject?: string; description?: string; annotations?: { marker: string; points_to: string; text: string }[] }; header?: string[]; row_count?: number; parts?: number; part?: number };
  return (
    <div className="relative rounded-[1.25rem] bg-card p-4 text-sm shadow-[0_1px_2px_rgba(16,24,40,0.04)] ring-2 ring-inset ring-foreground">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><TypeChip type={chunk.chunk_type} /><span>p.{chunk.page_start}</span><span>{chunk.token_count} tokens</span></div>
      <Button variant="ghost" size="icon-xs" className="absolute top-3 right-3" onClick={onClose} aria-label="close"><X /></Button>
      <div className="mt-3 space-y-2">
        {meta.image_path && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={publicAsset(meta.image_path)} alt="figure" className="max-h-64 rounded-xl ring-1 ring-black/5" />
        )}
        {chunk.context && (
          <div className="rounded-xl bg-muted p-3 text-xs">
            <div className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Context</div>
            <div className="whitespace-pre-wrap">{chunk.context}</div>
          </div>
        )}
        {meta.vision && (
          <div className="rounded-xl bg-fuchsia-50 p-3 text-xs text-fuchsia-950 dark:bg-fuchsia-950/40 dark:text-fuchsia-100">
            <div className="mb-1 text-[10px] font-medium tracking-wide text-fuchsia-600 uppercase">Figure description</div>
            <div className="font-medium">{meta.vision.subject}</div>
            <div className="mt-1">{meta.vision.description}</div>
            {meta.vision.annotations?.length ? <ul className="mt-1 list-disc pl-4">{meta.vision.annotations.map((a, i) => <li key={i}><b>{a.marker}</b> → {a.points_to}{a.text ? ` — “${a.text}”` : ""}</li>)}</ul> : null}
          </div>
        )}
        {chunk.chunk_type === "table" && <div className="text-xs text-muted-foreground">{meta.row_count} rows{meta.parts && meta.parts > 1 ? `, part ${meta.part} of ${meta.parts}` : ""}, {meta.header?.length} columns</div>}
        <pre className="max-h-80 overflow-auto rounded-xl bg-muted p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{chunk.raw_text}</pre>
      </div>
    </div>
  );
}
