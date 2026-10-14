"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Database, FileText, Loader2, Orbit, RefreshCw, Trash2, Upload } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Document } from "@/lib/types";
import { api, fmtNum, stageLabel } from "@/lib/ui";
import { StatusBadge } from "./Chips";
import { DocumentsSkeleton } from "./Skeletons";
import { EmptyState } from "./EmptyState";
import { SamplePicker } from "./SamplePicker";
import { PageHeader } from "./PageHeader";

export function DocumentsHome() {
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [pending, setPending] = useState<Record<string, "ingest" | "embed" | "delete">>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { setDocs((await api<{ documents: Document[] }>("/api/documents")).documents); }
    catch (e) { setError(String(e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!docs?.some((d) => !["ready", "error"].includes(d.status))) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [docs, load]);

  async function seed(keys: string[]) {
    setBusy("Loading samples…"); setError(null);
    try {
      const r = await api<{ errors: string[] }>("/api/samples", { method: "POST", body: JSON.stringify({ keys }) });
      if (r.errors.length) setError(r.errors.join("\n"));
      await load();
    } catch (e) { setError(String(e)); } finally { setBusy(null); }
  }

  async function upload(file: File) {
    setBusy(`Uploading ${file.name}…`); setError(null);
    try {
      const { id, signedUrl } = await api<{ id: string; signedUrl: string }>("/api/documents/upload-url", { method: "POST", body: JSON.stringify({ name: file.name, size: file.size }) });
      const put = await fetch(signedUrl, { method: "PUT", body: file, headers: { "content-type": "application/pdf", "x-upsert": "true" } });
      if (!put.ok) throw new Error(`storage upload failed: ${put.status}`);
      await api(`/api/documents/${id}/ingest`, { method: "POST" });
      await load();
    } catch (e) { setError(String(e)); } finally { setBusy(null); if (fileRef.current) fileRef.current.value = ""; }
  }

  async function act(d: Document, what: "ingest" | "embed" | "delete") {
    if (what === "delete" && !confirm(`Delete "${d.name}" and all its chunks?`)) return;
    setPending((p) => ({ ...p, [d.id]: what }));
    try {
      if (what === "delete") await api(`/api/documents/${d.id}`, { method: "DELETE" });
      else await api(`/api/documents/${d.id}/${what}`, { method: "POST" });
      await load();
    } catch (e) { setError(String(e)); }
    finally { setPending((p) => { const n = { ...p }; delete n[d.id]; return n; }); }
  }

  const loaded = new Set((docs ?? []).map((d) => d.sample_key).filter((k): k is string => !!k));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documents"
        subtitle="Upload a PDF or load the sample set. Each document is chunked three ways and ready to search within minutes."
        actions={docs !== null && docs.length > 0 ? (
          <>
            {busy && <span className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{busy}</span>}
            <Button variant="outline" disabled={!!busy} nativeButton={false} render={<label />}>
              <Upload data-icon="inline-start" />Upload a PDF
              <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            </Button>
            <Button onClick={() => setPicker(true)} disabled={!!busy}><Database data-icon="inline-start" />Load samples</Button>
          </>
        ) : busy ? <span className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{busy}</span> : undefined}
      />
      {error && <Alert variant="destructive"><AlertTitle>Something failed</AlertTitle><AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription></Alert>}

      <section className="space-y-2">
        <h2 className="px-1 text-sm font-medium text-muted-foreground">Library</h2>
        {docs === null ? (
          <DocumentsSkeleton />
        ) : docs.length === 0 ? (
          <div className="rounded-[1.25rem] bg-card ring-1 ring-black/5">
            <EmptyState icon={<FileText />} title="No documents yet" hint="Load the sample set to see every feature working, or upload your own PDF.">
              <Button onClick={() => setPicker(true)} disabled={!!busy}><Database data-icon="inline-start" />Load sample documents</Button>
              <Button variant="outline" disabled={!!busy} nativeButton={false} render={<label />}>
                <Upload data-icon="inline-start" />Upload a PDF
                <input type="file" accept="application/pdf" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              </Button>
            </EmptyState>
          </div>
        ) : (
          <ul className="space-y-2">
            {docs.map((d) => {
              const pct = d.progress?.total ? Math.round(((d.progress.done ?? 0) / d.progress.total) * 100) : null;
              return (
                <li key={d.id} className="flex items-center gap-3 rounded-[1.25rem] bg-card px-4 py-3 shadow-[0_1px_2px_rgba(16,24,40,0.04)] ring-1 ring-black/5">
                  <div className="min-w-0 flex-1">
                    <Link href={`/documents/${d.id}`} className="block truncate font-medium hover:underline">{d.name.replace(/\.pdf$/i, "")}</Link>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      {d.page_count ? <span>{fmtNum(d.page_count)} {d.page_count === 1 ? "page" : "pages"}</span> : null}
                      {d.kind === "sample" && <span>sample</span>}
                      {d.status === "error" && <span className="truncate text-destructive" title={d.progress?.message}>{d.progress?.message}</span>}
                    </div>
                  </div>
                  <StatusBadge status={d.status} progress={pct} detail={d.status === "processing" ? stageLabel(d.progress.stage) : undefined} />
                  <div className="hidden items-center gap-0.5 sm:inline-flex">
                    <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" disabled={!!pending[d.id]} onClick={() => act(d, "ingest")} />}>{pending[d.id] === "ingest" ? <Loader2 className="animate-spin" /> : <RefreshCw />}</TooltipTrigger><TooltipContent>Re-ingest (parse, chunk, context, embed)</TooltipContent></Tooltip>
                    <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" disabled={!!pending[d.id]} onClick={() => act(d, "embed")} />}>{pending[d.id] === "embed" ? <Loader2 className="animate-spin" /> : <Orbit />}</TooltipTrigger><TooltipContent>Embed chunks that have no vector yet</TooltipContent></Tooltip>
                    <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="text-destructive" disabled={!!pending[d.id]} onClick={() => act(d, "delete")} />}>{pending[d.id] === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 />}</TooltipTrigger><TooltipContent>Delete document</TooltipContent></Tooltip>
                  </div>
                  <Button variant="ghost" size="icon-sm" className="text-destructive sm:hidden" disabled={!!pending[d.id]} onClick={() => act(d, "delete")} aria-label="delete">{pending[d.id] === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 />}</Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <SamplePicker open={picker} onOpenChange={setPicker} loaded={loaded} onLoad={seed} />
    </div>
  );
}
