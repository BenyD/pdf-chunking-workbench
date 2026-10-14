"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Close, Icon, Search } from "@/components/quartz/icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/quartz/ui/alert";
import { Badge } from "@/components/quartz/ui/badge";
import { BreadcrumbTrail } from "@/components/quartz/ui/breadcrumb";
import { Button } from "@/components/quartz/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardMeta, CardTitle } from "@/components/quartz/ui/card";
import { Checkbox } from "@/components/quartz/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyRetry, EmptyStatus, EmptyTitle } from "@/components/quartz/ui/empty-state";
import { Label } from "@/components/quartz/ui/field";
import { Input } from "@/components/quartz/ui/input";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemLink, ItemTitle } from "@/components/quartz/ui/item";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderRow, PageHeaderTitle } from "@/components/quartz/ui/page-header";
import { SkeletonSwap, SkeletonText } from "@/components/quartz/ui/skeleton";
import { Status } from "@/components/quartz/ui/status";
import type { Chunk, Document, Page } from "@/lib/types";
import { STRATEGY } from "@/lib/types";
import { api, fmtNum, publicAsset, stageLabel } from "@/lib/ui";
import { chunkKind, PageViewer, typeLabel, type Overlay } from "./PageViewer";

export function Explorer({ id }: { id: string }) {
  const sp = useSearchParams();
  const [doc, setDoc] = useState<Document | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [pageNo, setPageNo] = useState(Math.max(1, Number(sp.get("page")) || 1));
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
    api<{ chunks: Chunk[] }>(`/api/documents/${id}/chunks?strategy=${STRATEGY}&page=${pageNo}&limit=1000`)
      .then((r) => { setChunks(r.chunks); setSelected(null); })
      .catch((e) => setErr(String(e)));
  }, [id, pageNo, doc]);

  const page = pages.find((p) => p.page_number === pageNo);
  const visible = useMemo(() => (chunks ?? []).filter((c) => showRows || c.chunk_type !== "table_row"), [chunks, showRows]);
  const overlays: Overlay[] = useMemo(() => visible.flatMap((c) => c.bboxes.filter((b) => b.page === pageNo).map((b, i) => ({
    id: `${c.id}:${i}`, type: c.chunk_type, box: b, selected: selected === c.id, label: `${typeLabel[c.chunk_type]} passage on page ${pageNo}`,
  }))), [visible, pageNo, selected]);
  const sel = chunks?.find((c) => c.id === selected) ?? null;
  const total = doc?.page_count ?? 1;
  const title = doc ? doc.name.replace(/\.pdf$/i, "") : "";
  const go = (n: number) => setPageNo(Math.min(Math.max(1, n), total));

  return (
    <>
      <BreadcrumbTrail items={[{ label: "Documents", href: "/" }, { label: title || "Document" }]} renderLink={(href) => <Link href={href} />} />
      {err && <Alert status="fail"><AlertTitle>The page could not load</AlertTitle><AlertDescription>{err}</AlertDescription></Alert>}
      <SkeletonSwap
        loading={!doc}
        label="Loading document"
        fallback={<div className="flex flex-col gap-2"><SkeletonText type="heading-lg" className="w-72" /><SkeletonText type="body" className="w-24" /></div>}
      >
        {doc && (
          <>
            <PageHeader size="sm">
              <PageHeaderRow>
                <PageHeaderContent>
                  <PageHeaderTitle>{title}</PageHeaderTitle>
                  <PageHeaderDescription>
                    {doc.page_count ? `${fmtNum(doc.page_count)} ${doc.page_count === 1 ? "page" : "pages"}` : null}
                    {doc.status === "processing" && <> <Status status="running" live>{stageLabel(doc.progress.stage)}</Status></>}
                  </PageHeaderDescription>
                </PageHeaderContent>
                <PageHeaderActions>
                  <Button variant="secondary" nativeButton={false} render={<Link href={`/search?document_id=${doc.id}`} />}><Icon icon={Search} />Search this document</Button>
                </PageHeaderActions>
              </PageHeaderRow>
            </PageHeader>

            {doc.status !== "ready" && doc.status !== "error" && (
              <p className="type-body text-text-2">
                {stageLabel(doc.progress.stage)}{doc.progress.total ? `, ${doc.progress.done ?? 0} of ${doc.progress.total}` : ""}. This page updates by itself.
              </p>
            )}
            {doc.status === "error" && (
              <Empty reason="error">
                <EmptyHeader>
                  <EmptyStatus>Failed</EmptyStatus>
                  <EmptyTitle>Processing failed</EmptyTitle>
                  <EmptyDescription>{doc.progress.message ?? "Unknown error"}</EmptyDescription>
                </EmptyHeader>
                <EmptyRetry onRetry={() => api(`/api/documents/${doc.id}/ingest`, { method: "POST" }).then(loadDoc)} />
              </Empty>
            )}

            {doc.status === "ready" && (
              <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Page {pageNo} of {total}</CardTitle>
                    <CardAction>
                      <Label className="flex items-center gap-2"><Checkbox checked={showRows} onCheckedChange={(c) => setShowRows(!!c)} />Table rows</Label>
                      <Button variant="ghost" size="icon-xs" aria-label="Previous page" disabled={pageNo <= 1} onClick={() => go(pageNo - 1)}><Icon icon={ChevronLeft} /></Button>
                      <Input mode="number" size="sm" aria-label="Page number" min={1} max={total} value={pageNo} onValueChange={(v) => { if (v !== null) go(v); }} className="w-20" />
                      <Button variant="ghost" size="icon-xs" aria-label="Next page" disabled={pageNo >= total} onClick={() => go(pageNo + 1)}><Icon icon={ChevronRight} /></Button>
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    {page && <PageViewer imageUrl={page.image_url ?? publicAsset(page.image_path)} alt={`Page ${pageNo} of ${title}`} overlays={overlays} onSelect={(oid) => setSelected(oid.split(":")[0])} />}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Passages</CardTitle>
                    <CardMeta>{chunks === null ? "Loading" : `${visible.length} on this page`}</CardMeta>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-col gap-4 lg:max-h-(--field-max-height) lg:overflow-y-auto">
                      {sel && <PassageDetail chunk={sel} onClose={() => setSelected(null)} />}
                      <SkeletonSwap
                        loading={chunks === null}
                        label="Loading passages"
                        fallback={<ItemGroup><ul>{Array.from({ length: 5 }, (_, i) => <li key={i}><Item><ItemContent><SkeletonText type="label" className="w-24" /><SkeletonText type="body-sm" lines={2} /></ItemContent></Item></li>)}</ul></ItemGroup>}
                      >
                        {chunks !== null && visible.length === 0 && (
                          <Empty variant="plain" size="sm">
                            <EmptyHeader>
                              <EmptyTitle>Nothing on this page</EmptyTitle>
                              <EmptyDescription>This page has no text we could read, or only table rows. Tick Table rows to show those.</EmptyDescription>
                            </EmptyHeader>
                          </Empty>
                        )}
                        {visible.length > 0 && (
                          <ItemGroup>
                            <ul>
                              {visible.map((c) => (
                                <li key={c.id}>
                                  <Item kind={chunkKind[c.chunk_type]} selected={selected === c.id}>
                                    <ItemContent>
                                      <ItemTitle>
                                        <Badge kind={chunkKind[c.chunk_type]} label={typeLabel[c.chunk_type]} />
                                        <ItemLink href="#passage" aria-current={selected === c.id ? "true" : undefined} onClick={(e) => { e.preventDefault(); setSelected(c.id); }}>
                                          {c.page_end !== c.page_start ? `Pages ${c.page_start} to ${c.page_end}` : `Page ${c.page_start}`}
                                        </ItemLink>
                                      </ItemTitle>
                                      <ItemDescription>{c.raw_text}</ItemDescription>
                                    </ItemContent>
                                  </Item>
                                </li>
                              ))}
                            </ul>
                          </ItemGroup>
                        )}
                      </SkeletonSwap>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </>
        )}
      </SkeletonSwap>
    </>
  );
}

function PassageDetail({ chunk, onClose }: { chunk: Chunk; onClose: () => void }) {
  const meta = chunk.metadata as { image_path?: string; vision?: { subject?: string; description?: string; annotations?: { marker: string; points_to: string; text: string }[] }; header?: string[]; row_count?: number; parts?: number; part?: number };
  const code = chunk.chunk_type === "table" || chunk.chunk_type === "table_row" || chunk.chunk_type === "record";
  return (
    <section id="passage" aria-label="Selected passage" className="well flex flex-col gap-3 rounded-soft p-3">
      <div className="flex items-center gap-2">
        <Badge kind={chunkKind[chunk.chunk_type]} label={typeLabel[chunk.chunk_type]} />
        <span className="type-body-sm text-text-2">Page {chunk.page_start}</span>
        <Button variant="ghost" size="icon-xs" aria-label="Close passage" onClick={onClose} className="ms-auto"><Icon icon={Close} /></Button>
      </div>
      {meta.image_path && (
        <div className="frame bg-paper">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={publicAsset(meta.image_path)} alt={meta.vision?.subject ?? "Figure"} className="block max-h-64 w-auto" />
        </div>
      )}
      {chunk.context && <p className="type-body-sm text-text-2">{chunk.context}</p>}
      {meta.vision && (
        <div className="flex flex-col gap-1">
          <p className="type-label">{meta.vision.subject}</p>
          <p className="type-body-sm">{meta.vision.description}</p>
          {meta.vision.annotations?.length ? (
            <ul className="type-body-sm">
              {meta.vision.annotations.map((a, i) => <li key={i}>{a.marker}: {a.points_to}{a.text ? `, "${a.text}"` : ""}</li>)}
            </ul>
          ) : null}
        </div>
      )}
      {chunk.chunk_type === "table" && <p className="type-body-sm text-text-2">{meta.row_count} rows{meta.parts && meta.parts > 1 ? `, part ${meta.part} of ${meta.parts}` : ""}, {meta.header?.length} columns</p>}
      <pre className={code ? "max-h-80 overflow-auto type-code-sm whitespace-pre-wrap" : "max-h-80 overflow-auto type-body whitespace-pre-wrap"}>{chunk.raw_text}</pre>
    </section>
  );
}
