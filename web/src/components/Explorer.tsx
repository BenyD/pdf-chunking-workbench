"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Add, ChevronDown, ChevronLeft, ChevronRight, Close, Icon, Search, Subtract } from "@/components/quartz/icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/quartz/ui/alert";
import { Badge } from "@/components/quartz/ui/badge";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/quartz/ui/breadcrumb";
import { Button } from "@/components/quartz/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/quartz/ui/button-group";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardMeta, CardTitle } from "@/components/quartz/ui/card";
import { Checkbox } from "@/components/quartz/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLinkItem, DropdownMenuTrigger } from "@/components/quartz/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyRetry, EmptyStatus, EmptyTitle } from "@/components/quartz/ui/empty-state";
import { Input } from "@/components/quartz/ui/input";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemLink, ItemTitle } from "@/components/quartz/ui/item";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderRow, PageHeaderTitle } from "@/components/quartz/ui/page-header";
import { Progress, ProgressLabel, ProgressStep, ProgressStepDescription, ProgressStepIndicator, ProgressStepSeparator, ProgressStepText, ProgressStepTitle, ProgressStepTrigger, ProgressSteps, ProgressValue } from "@/components/quartz/ui/progress";
import { SkeletonSwap, SkeletonText } from "@/components/quartz/ui/skeleton";
import { Status } from "@/components/quartz/ui/status";
import type { Chunk, Document, Page } from "@/lib/types";
import { STRATEGY } from "@/lib/types";
import { api, fmtNum, publicAsset, stageLabel } from "@/lib/ui";
import { chunkKind, PageViewer, typeLabel, type Overlay } from "./PageViewer";

/** The widths a page can be shown at, as a share of the viewer; 1 fits the width. */
const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3];

/** The four things that happen to a document, in the words a reader needs; the worker's finer stages map onto them. */
const STEPS = [
  { title: "Read the pages", detail: "Fetch the file and render every page" },
  { title: "Find the layout", detail: "Tables, figures, headings and scans" },
  { title: "Describe the passages", detail: "A line of context for each one" },
  { title: "Index", detail: "Make it searchable" },
];
function stepOf(stage?: string | null): number {
  if (!stage || stage === "queued" || stage === "download" || stage === "render") return 1;
  if (stage === "parse" || stage === "chunk") return 2;
  if (stage === "context" || stage === "store") return 3;
  if (stage.startsWith("embed")) return 4;
  return 5;
}
const docTitle = (d: Document) => d.name.replace(/\.pdf$/i, "");

export function Explorer({ id }: { id: string }) {
  const sp = useSearchParams();
  const [doc, setDoc] = useState<Document | null>(null);
  const [others, setOthers] = useState<Document[]>([]);   // the other documents, for the switcher in the breadcrumb
  const [pages, setPages] = useState<Page[]>([]);
  const [pageNo, setPageNo] = useState(Math.max(1, Number(sp.get("page")) || 1));
  const [chunks, setChunks] = useState<Chunk[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showRows, setShowRows] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  // The viewer mounts a beat after the document arrives (SkeletonSwap holds its children until its
  // skeleton has had its turn), so the effects that need its elements key on this state, not on the data.
  const [viewer, setViewer] = useState<HTMLDivElement | null>(null);
  const viewerRef = useCallback((el: HTMLDivElement | null) => { scroller.current = el; setViewer(el); }, []);
  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const wanted = useRef(Math.max(1, Number(sp.get("page")) || 1));

  /** Scroll the viewer so a page sits at the top. */
  const scrollTo = useCallback((n: number, smooth = true) => {
    const el = pageEls.current.get(n);
    const sc = scroller.current;
    if (el && sc) sc.scrollTo({ top: el.offsetTop - 12, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const loadDoc = useCallback(async () => {
    const r = await api<{ document: Document; pages: Page[] }>(`/api/documents/${id}`);
    setDoc(r.document); setPages(r.pages);
  }, [id]);

  useEffect(() => { loadDoc().catch((e) => setErr(String(e))); }, [loadDoc]);
  useEffect(() => { api<{ documents: Document[] }>("/api/documents").then((r) => setOthers(r.documents.filter((d) => d.id !== id && d.status === "ready"))).catch(() => {}); }, [id]);
  useEffect(() => {
    if (!doc || ["ready", "error"].includes(doc.status)) return;
    const t = setInterval(() => loadDoc().catch(() => {}), 2500);
    return () => clearInterval(t);
  }, [doc, loadDoc]);
  // The passages of the page in view. A short wait lets a scroll settle before fetching.
  useEffect(() => {
    if (!doc || doc.status !== "ready") return;
    setChunks(null);
    const t = setTimeout(() => {
      api<{ chunks: Chunk[] }>(`/api/documents/${id}/chunks?strategy=${STRATEGY}&page=${pageNo}&limit=1000`)
        .then((r) => { setChunks(r.chunks); setSelected(null); })
        .catch((e) => setErr(String(e)));
    }, 150);
    return () => clearTimeout(t);
  }, [id, pageNo, doc]);

  // The page most in view is the current page. Observed inside the viewer, so the window's own scroll never counts.
  const pageCount = pages.length;
  useEffect(() => {
    if (!viewer || !pageCount) return;
    const ratios = new Map<number, number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) ratios.set(Number((e.target as HTMLElement).dataset.page), e.intersectionRatio);
      let best = 0, bestN = 0;
      for (const [n, r] of ratios) if (r > best) { best = r; bestN = n; }
      if (bestN) setPageNo(bestN);
    }, { root: viewer, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
    for (const el of pageEls.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [viewer, pageCount]);

  // A page asked for in the address (?page=12) is scrolled to once the viewer is up.
  useEffect(() => { if (viewer && pageCount && wanted.current > 1) { scrollTo(wanted.current, false); wanted.current = 1; } }, [viewer, pageCount, scrollTo]);

  const zoomTo = (step: number) => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(z) + step))]);
  const visible = useMemo(() => (chunks ?? []).filter((c) => showRows || c.chunk_type !== "table_row"), [chunks, showRows]);
  const overlays: Overlay[] = useMemo(() => visible.flatMap((c) => c.bboxes.filter((b) => b.page === pageNo).map((b, i) => ({
    id: `${c.id}:${i}`, type: c.chunk_type, box: b, selected: selected === c.id, label: `${typeLabel[c.chunk_type]} passage on page ${pageNo}`,
  }))), [visible, pageNo, selected]);
  const sel = chunks?.find((c) => c.id === selected) ?? null;
  const total = doc?.page_count ?? 1;
  const title = doc ? doc.name.replace(/\.pdf$/i, "") : "";
  const go = (n: number) => { const t = Math.min(Math.max(1, n), total); setPageNo(t); scrollTo(t); };

  return (
    <>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink render={<Link href="/" />}>Documents</BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            {/* The current crumb opens the list of the other documents, so switching never needs the list page. */}
            {others.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label={`Switch document, now ${title || "this document"}`} />}>
                  {title || "Document"}
                  <Icon icon={ChevronDown} size={12} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-w-(--popover)">
                  {others.map((d) => <DropdownMenuLinkItem key={d.id} render={<Link href={`/documents/${d.id}`} />}><span className="truncate">{docTitle(d)}</span></DropdownMenuLinkItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : <BreadcrumbPage>{title || "Document"}</BreadcrumbPage>}
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      {err && <Alert status="fail"><AlertTitle>The page could not load</AlertTitle><AlertDescription>{err}</AlertDescription></Alert>}
      <SkeletonSwap
        loading={!doc}
        label="Loading document"
        className="flex flex-col gap-6"
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
              <Card>
                <CardHeader>
                  <CardTitle>Processing</CardTitle>
                  <CardDescription>This page updates by itself. The pages show below as soon as they are read; the passages follow.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-5">
                    <ProgressSteps value={stepOf(doc.progress.stage)} aria-label="Processing steps">
                      {STEPS.map((st, i) => (
                        <ProgressStep key={st.title} step={i + 1} state={i + 1 === stepOf(doc.progress.stage) ? "pending" : undefined}>
                          <ProgressStepTrigger>
                            <ProgressStepIndicator />
                            <ProgressStepText>
                              <ProgressStepTitle>{st.title}</ProgressStepTitle>
                              <ProgressStepDescription className="max-sm:hidden">{st.detail}</ProgressStepDescription>
                            </ProgressStepText>
                          </ProgressStepTrigger>
                          <ProgressStepSeparator />
                        </ProgressStep>
                      ))}
                    </ProgressSteps>
                    <Progress value={doc.progress.total ? ((doc.progress.done ?? 0) / doc.progress.total) * 100 : null} aria-label={stageLabel(doc.progress.stage)}>
                      <ProgressLabel>{stageLabel(doc.progress.stage)}</ProgressLabel>
                      <ProgressValue>{() => (doc.progress.total ? `${fmtNum(doc.progress.done ?? 0)} of ${fmtNum(doc.progress.total)}` : "Working")}</ProgressValue>
                    </Progress>
                  </div>
                </CardContent>
              </Card>
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

            {(doc.status === "ready" || (doc.status !== "error" && pages.length > 0)) && (
              <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Page {pageNo}</CardTitle>
                    <CardMeta>of {fmtNum(total)}</CardMeta>
                    <CardAction>
                      <Button variant="ghost" size="icon-xs" aria-label="Previous page" disabled={pageNo <= 1} onClick={() => go(pageNo - 1)}><Icon icon={ChevronLeft} /></Button>
                      <Input mode="number" size="sm" aria-label="Page number" min={1} max={total} value={pageNo} onValueChange={(v) => { if (v !== null) go(v); }} className="w-20" />
                      <Button variant="ghost" size="icon-xs" aria-label="Next page" disabled={pageNo >= total} onClick={() => go(pageNo + 1)}><Icon icon={ChevronRight} /></Button>
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-col gap-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="type-body-sm text-text-2">Scroll through the pages. Click a box to open its passage.</p>
                        <ButtonGroup aria-label="Zoom">
                          <Button variant="secondary" size="icon-sm" aria-label="Zoom out" disabled={zoom <= ZOOMS[0]} onClick={() => zoomTo(-1)}><Icon icon={Subtract} /></Button>
                          <ButtonGroupText className="data w-14 justify-center">{Math.round(zoom * 100)}%</ButtonGroupText>
                          <Button variant="secondary" size="icon-sm" aria-label="Zoom in" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => zoomTo(1)}><Icon icon={Add} /></Button>
                        </ButtonGroup>
                      </div>
                      {/* Every page in one scrolling column; images load as they near the view. Each page keeps its
                          own aspect ratio, so the column has its full height before any image has arrived. */}
                      <div ref={viewerRef} className="well relative max-h-[75dvh] overflow-auto rounded-soft p-3">
                        <div className="flex w-(--zoom) flex-col gap-3" style={{ "--zoom": `${zoom * 100}%` } as CSSProperties}>
                          {pages.map((p) => (
                            <div
                              key={p.page_number}
                              data-page={p.page_number}
                              ref={(el) => { if (el) pageEls.current.set(p.page_number, el); else pageEls.current.delete(p.page_number); }}
                              className="aspect-(--ratio) w-full"
                              style={{ "--ratio": `${p.width} / ${p.height}` } as CSSProperties}
                            >
                              <PageViewer fill imageUrl={p.image_url ?? publicAsset(p.image_path)} alt={`Page ${p.page_number} of ${title}`} overlays={p.page_number === pageNo ? overlays : []} onSelect={(oid) => setSelected(oid.split(":")[0])} />
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Passages</CardTitle>
                    <CardMeta>{chunks === null ? (doc.status === "ready" ? "Loading" : stageLabel(doc.progress.stage)) : `${visible.length} on this page`}</CardMeta>
                    <CardAction>
                      <label className="flex items-center gap-2 type-label text-text-1 select-none"><Checkbox checked={showRows} onCheckedChange={(c) => setShowRows(!!c)} />Table rows</label>
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-col gap-4">
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
