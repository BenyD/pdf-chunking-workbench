"use client";
import { useCallback, useEffect, useState } from "react";
import { Checkmark, DocumentPdf, ErrorOutline, Icon, OverflowMenuHorizontal, Renew, Time, Upload } from "@/components/quartz/icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/quartz/ui/alert";
import { AttachmentDrop, AttachmentDropTrigger, rejectionReason, type FileRejection } from "@/components/quartz/ui/attachment";
import { Badge } from "@/components/quartz/ui/badge";
import { Button } from "@/components/quartz/ui/button";
import { Dialog, DialogAction, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/quartz/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/quartz/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/quartz/ui/empty-state";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemLink, ItemStatus, ItemTitle } from "@/components/quartz/ui/item";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderRow, PageHeaderTitle } from "@/components/quartz/ui/page-header";
import { SkeletonSwap, SkeletonText } from "@/components/quartz/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/quartz/ui/tooltip";
import { SAMPLES } from "@/lib/samples";
import type { Document } from "@/lib/types";
import { api, fmtNum, stageLabel } from "@/lib/ui";
import { SamplePicker } from "./SamplePicker";

const title = (d: Document) => d.name.replace(/\.pdf$/i, "");

/** The processing state as a status word. */
function docStatus(d: Document): { status: "queued" | "running" | "ok" | "fail"; word: string } {
  if (d.status === "ready") return { status: "ok", word: "Ready" };
  if (d.status === "error") return { status: "fail", word: "Failed" };
  if (d.status === "processing") return { status: "running", word: stageLabel(d.progress?.stage) };
  if (d.status === "uploading") return { status: "queued", word: "Uploading" };
  return { status: "queued", word: "Queued" };
}

/** The state as a badge with a mark: a tick once it is ready, the fail line when it failed, a clock while it waits. Running keeps the turning arc. */
function DocBadge({ d }: { d: Document }) {
  const s = docStatus(d);
  if (s.status === "running") return <ItemStatus status="running">{s.word}</ItemStatus>;
  if (s.status === "fail") return <Badge status="fail"><Icon icon={ErrorOutline} size={12} data-icon="inline-start" />{s.word}</Badge>;
  if (s.status === "queued") return <Badge variant="outline"><Icon icon={Time} size={12} data-icon="inline-start" />{s.word}</Badge>;
  return <Badge><Icon icon={Checkmark} size={12} data-icon="inline-start" />{s.word}</Badge>;
}

export function DocumentsHome() {
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [busy, setBusy] = useState<"samples" | "upload" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const openPicker = (key: string | null = null) => { setPreviewKey(key); setPicker(true); };
  const [toDelete, setToDelete] = useState<Document | null>(null);
  const [pending, setPending] = useState<Record<string, "ingest" | "embed" | "delete">>({});

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
    setBusy("samples"); setError(null);
    try {
      const r = await api<{ errors: string[] }>("/api/samples", { method: "POST", body: JSON.stringify({ keys }) });
      if (r.errors.length) setError(r.errors.join("\n"));
      await load();
    } catch (e) { setError(String(e)); } finally { setBusy(null); }
  }

  async function upload(file: File) {
    setBusy("upload"); setError(null);
    try {
      const { id, signedUrl } = await api<{ id: string; signedUrl: string }>("/api/documents/upload-url", { method: "POST", body: JSON.stringify({ name: file.name, size: file.size }) });
      const put = await fetch(signedUrl, { method: "PUT", body: file, headers: { "content-type": "application/pdf", "x-upsert": "true" } });
      if (!put.ok) throw new Error(`storage upload failed: ${put.status}`);
      await api(`/api/documents/${id}/ingest`, { method: "POST" });
      await load();
    } catch (e) { setError(String(e)); } finally { setBusy(null); }
  }

  async function act(d: Document, what: "ingest" | "embed" | "delete") {
    setPending((p) => ({ ...p, [d.id]: what }));
    try {
      if (what === "delete") await api(`/api/documents/${d.id}`, { method: "DELETE" });
      else await api(`/api/documents/${d.id}/${what}`, { method: "POST" });
      await load();
    } catch (e) { setError(String(e)); }
    finally { setPending((p) => { const n = { ...p }; delete n[d.id]; return n; }); }
  }

  const loaded = new Set((docs ?? []).map((d) => d.sample_key).filter((k): k is string => !!k));
  const hasDocs = !!docs && docs.length > 0;
  const limit = 150 * 1024 * 1024;
  const rejected = (rs: FileRejection[]) => setError(rs.map((r) => `${r.file.name}: ${rejectionReason(r, { accept: "application/pdf,.pdf", maxSize: limit })}`).join("\n"));

  return (
    <AttachmentDrop accept="application/pdf,.pdf" maxSize={limit} multiple={false} onFiles={(files) => upload(files[0])} onReject={rejected} overlayLabel="Drop the PDF to upload it" className="flex min-h-0 flex-1 flex-col gap-6">
      <PageHeader>
        <PageHeaderRow>
          <PageHeaderContent>
            <PageHeaderTitle>Documents</PageHeaderTitle>
            <PageHeaderDescription>Upload a PDF or load the samples. Each document is read, split into passages and searchable within minutes.</PageHeaderDescription>
          </PageHeaderContent>
          {hasDocs && (
            <PageHeaderActions>
              <AttachmentDropTrigger size="default" pending={busy === "upload"} pendingLabel="Uploading"><Icon icon={Upload} />Upload a PDF</AttachmentDropTrigger>
              <Button onClick={() => openPicker()} pending={busy === "samples"} pendingLabel="Loading samples">Load samples</Button>
            </PageHeaderActions>
          )}
        </PageHeaderRow>
      </PageHeader>

      {error && (
        <Alert status="fail">
          <AlertTitle>The last action failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <SkeletonSwap
        loading={docs === null}
        label="Loading documents"
        fallback={
          <ItemGroup>
            <ul>
              {Array.from({ length: 6 }, (_, i) => (
                <li key={i}>
                  <Item>
                    <ItemContent>
                      <SkeletonText type="body" className="w-64" />
                      <SkeletonText type="body-sm" className="w-32" />
                    </ItemContent>
                  </Item>
                </li>
              ))}
            </ul>
          </ItemGroup>
        }
      >
        {docs && docs.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia><Icon icon={DocumentPdf} /></EmptyMedia>
              <EmptyTitle>No documents yet</EmptyTitle>
              <EmptyDescription>Load the samples, or drop a PDF anywhere on this page.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" onClick={() => openPicker()} pending={busy === "samples"} pendingLabel="Loading samples">Load samples</Button>
              <AttachmentDropTrigger pending={busy === "upload"} pendingLabel="Uploading">Upload a PDF</AttachmentDropTrigger>
            </EmptyContent>
            {/* The first page of each sample, so what "Load samples" brings is in view before anything is loaded.
                Clicking one opens the picker on that sample, where every page can be looked through. */}
            <div className="flex w-full flex-col gap-2 pt-2">
              <p className="type-label text-text-2">The samples. Click one to look through it.</p>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                {SAMPLES.map((s) => (
                  <li key={s.key} className="min-w-0">
                    <a href={`/samples/${s.file}`} onClick={(e) => { e.preventDefault(); openPicker(s.key); }} className="flex min-w-0 flex-col gap-1 rounded-soft">
                      <span className="frame block overflow-hidden bg-paper">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/samples/previews/${s.key}.png`} alt="" className="block h-28 w-full object-cover object-top" loading="lazy" />
                      </span>
                      <span className="truncate type-label-sm text-text-1">{s.name.replace(/\.pdf$/i, "")}</span>
                      <span className="type-body-sm text-text-3">{fmtNum(s.pages)} {s.pages === 1 ? "page" : "pages"}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </Empty>
        )}
        {hasDocs && (
          <ItemGroup>
            <ul>
              {docs.map((d) => {
                const facts = [
                  d.page_count ? `${fmtNum(d.page_count)} ${d.page_count === 1 ? "page" : "pages"}` : null,
                  d.kind === "sample" ? "Sample" : null,
                  d.status === "error" ? d.progress?.message : null,
                ].filter(Boolean).join(", ");
                return (
                  <li key={d.id}>
                    <Item>
                      <ItemContent>
                        <ItemTitle><ItemLink href={`/documents/${d.id}`}>{title(d)}</ItemLink></ItemTitle>
                        {facts && <ItemDescription>{facts}</ItemDescription>}
                      </ItemContent>
                      <DocBadge d={d} />
                      <ItemActions>
                        <Tooltip>
                          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Process ${title(d)} again`} pending={pending[d.id] === "ingest"} onClick={() => act(d, "ingest")} />}>
                            <Icon icon={Renew} />
                          </TooltipTrigger>
                          <TooltipContent>Process again: read the PDF afresh and rebuild its passages</TooltipContent>
                        </Tooltip>
                        <DropdownMenu>
                          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${title(d)}`} pending={pending[d.id] === "embed" || pending[d.id] === "delete"} />}>
                            <Icon icon={OverflowMenuHorizontal} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => act(d, "embed")}>Finish indexing</DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={() => setToDelete(d)}>Delete document</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </ItemActions>
                    </Item>
                  </li>
                );
              })}
            </ul>
          </ItemGroup>
        )}
      </SkeletonSwap>

      <SamplePicker open={picker} onOpenChange={setPicker} loaded={loaded} onLoad={seed} initialPreview={previewKey} />

      <Dialog role="alertdialog" open={toDelete !== null} onOpenChange={(open) => { if (!open) setToDelete(null); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Delete {toDelete ? title(toDelete) : "document"}?</DialogTitle>
            <DialogDescription>Its pages and passages are deleted for good.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose>Keep document</DialogClose>
            <DialogAction variant="destructive" pendingLabel="Deleting" onAction={async () => { if (toDelete) await act(toDelete, "delete"); setToDelete(null); }}>Delete document</DialogAction>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AttachmentDrop>
  );
}
