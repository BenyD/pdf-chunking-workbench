"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Database, FileText, Loader2, Orbit, RefreshCw, Trash2, Upload } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Document } from "@/lib/types";
import { api, fmtNum, stageLabel } from "@/lib/ui";
import { StatusBadge } from "./Chips";
import { DocumentsSkeleton } from "./Skeletons";
import { EmptyState } from "./EmptyState";
import { SamplePicker } from "./SamplePicker";

type Stats = { strategies?: Record<string, { chunks: number }>; seconds?: number; llm?: { context_calls: number; vision_calls: number } };

export function DocumentsHome() {
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
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
    try {
      if (what === "delete") await api(`/api/documents/${d.id}`, { method: "DELETE" });
      else await api(`/api/documents/${d.id}/${what}`, { method: "POST" });
      await load();
    } catch (e) { setError(String(e)); }
  }

  const loaded = new Set((docs ?? []).map((d) => d.sample_key).filter((k): k is string => !!k));

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Documents</h1>
        <p className="text-sm text-muted-foreground sm:text-base">Upload a PDF or load the sample set. Each document is chunked three ways and ready to search within minutes.</p>
        {docs !== null && docs.length > 0 && <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setPicker(true)} disabled={!!busy}><Database data-icon="inline-start" />Load sample documents</Button>
          <Button variant="outline" disabled={!!busy} nativeButton={false} render={<label />}>
            <Upload data-icon="inline-start" />Upload a PDF
            <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </Button>
          {busy && <span className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{busy}</span>}
        </div>}
        {docs !== null && docs.length === 0 && busy && <span className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{busy}</span>}
        {error && <Alert variant="destructive"><AlertTitle>Something failed</AlertTitle><AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription></Alert>}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Library</CardTitle>
          <CardDescription>Status updates automatically while a document is processing.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          {docs === null ? (
            <DocumentsSkeleton />
          ) : docs.length === 0 ? (
            <div className="px-6 sm:px-0">
              <EmptyState icon={<FileText />} title="No documents yet" hint="Load the sample set to see every feature working, or upload your own PDF.">
                <Button onClick={() => setPicker(true)} disabled={!!busy}><Database data-icon="inline-start" />Load sample documents</Button>
                <Button variant="outline" disabled={!!busy} nativeButton={false} render={<label />}>
                  <Upload data-icon="inline-start" />Upload a PDF
                  <input type="file" accept="application/pdf" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
                </Button>
              </EmptyState>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Document</TableHead>
                    <TableHead className="hidden sm:table-cell">Pages</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Chunks</TableHead>
                    <TableHead className="hidden lg:table-cell">Ingest</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {docs.map((d) => {
                    const st = (d.stats ?? {}) as Stats;
                    const pct = d.progress?.total ? Math.round(((d.progress.done ?? 0) / d.progress.total) * 100) : null;
                    return (
                      <TableRow key={d.id}>
                        <TableCell className="max-w-[46vw] sm:max-w-xs">
                          <Link href={`/documents/${d.id}`} className="block truncate font-medium hover:underline">{d.name}</Link>
                          {d.kind === "sample" && <span className="text-[11px] text-muted-foreground">sample</span>}
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground sm:table-cell">{fmtNum(d.page_count)}</TableCell>
                        <TableCell>
                          <div className="inline-flex flex-col items-start gap-1">
                            <StatusBadge status={d.status} progress={pct} detail={d.status === "processing" ? stageLabel(d.progress.stage) : undefined} />
                            {d.status === "error" && <span className="max-w-[40vw] truncate text-xs text-destructive sm:max-w-xs" title={d.progress?.message}>{d.progress?.message}</span>}
                          </div>
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground md:table-cell">
                          {st.strategies ? `${fmtNum(st.strategies.naive?.chunks)}, ${fmtNum(st.strategies.structural?.chunks)}, ${fmtNum(st.strategies.contextual?.chunks)}` : "–"}
                        </TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                          {d.status === "ready" && st.seconds ? `${st.seconds}s${st.llm ? `, ${st.llm.context_calls + st.llm.vision_calls} model calls` : ""}` : "–"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex gap-0.5">
                            <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => act(d, "ingest")} />}><RefreshCw /></TooltipTrigger><TooltipContent>Re-ingest (parse, chunk, context, embed)</TooltipContent></Tooltip>
                            <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => act(d, "embed")} />}><Orbit /></TooltipTrigger><TooltipContent>Embed chunks that have no vector yet</TooltipContent></Tooltip>
                            <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => act(d, "delete")} />}><Trash2 /></TooltipTrigger><TooltipContent>Delete document</TooltipContent></Tooltip>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <SamplePicker open={picker} onOpenChange={setPicker} loaded={loaded} onLoad={seed} />
    </div>
  );
}
