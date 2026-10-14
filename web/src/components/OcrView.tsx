"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Close, Icon } from "@/components/quartz/icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/quartz/ui/alert";
import { Badge } from "@/components/quartz/ui/badge";
import { Button } from "@/components/quartz/ui/button";
import { ButtonGroup } from "@/components/quartz/ui/button-group";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/quartz/ui/card";
import { Checkbox } from "@/components/quartz/ui/checkbox";
import { Dialog, DialogAction, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/quartz/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/quartz/ui/empty-state";
import { Field, FieldLabel, Label } from "@/components/quartz/ui/field";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderRow, PageHeaderTitle } from "@/components/quartz/ui/page-header";
import { Input } from "@/components/quartz/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/quartz/ui/select";
import { Skeleton, SkeletonSwap } from "@/components/quartz/ui/skeleton";
import { Status } from "@/components/quartz/ui/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/quartz/ui/table";
import { cn } from "@/lib/quartz/utils";
import type { Document, OcrAnchor, OcrField, OcrTemplate, Page } from "@/lib/types";
import { api, publicAsset } from "@/lib/ui";

type Box = { x: number; y: number; w: number; h: number };
type Word = { text: string; conf: number; box: Box };
interface RunField { name: string; type: string; value: unknown; raw: string; confidence: number; source: string; valid: boolean; note: string; box_used: Box; ocr_value?: unknown }
interface RunResult { deskew_angle: number; registration: { dx: number; dy: number; scale: number; matched: { anchor: string; found: string }[] }; fields: RunField[]; needs_fallback: string[]; fallback_used?: boolean; fallback_error?: string }

const FIELD_TYPES = ["text", "date", "amount", "integer"] as const;
const pageUrl = (p: Page) => p.image_url ?? publicAsset(p.image_path);
/** A box as custom properties, read by left-(--x) and friends. */
const at = (b: Box): CSSProperties => ({ "--x": `${b.x * 100}%`, "--y": `${b.y * 100}%`, "--w": `${b.w * 100}%`, "--h": `${b.h * 100}%` } as CSSProperties);
const BOX = "absolute top-(--y) left-(--x) h-(--h) w-(--w)";

export function OcrView() {
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [templates, setTemplates] = useState<OcrTemplate[]>([]);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [srcPages, setSrcPages] = useState<Page[]>([]);
  const [srcLoading, setSrcLoading] = useState(false);
  const [tgtLoading, setTgtLoading] = useState(false);
  const [srcPage, setSrcPage] = useState(1);
  const [mode, setMode] = useState<"field" | "anchor">("field");
  const [name, setName] = useState("New template");
  const [fields, setFields] = useState<OcrField[]>([]);
  const [anchors, setAnchors] = useState<OcrAnchor[]>([]);
  const [words, setWords] = useState<Word[] | null>(null);
  const [showWords, setShowWords] = useState(false);
  const [tgtDoc, setTgtDoc] = useState<string | null>(null);
  const [tgtPages, setTgtPages] = useState<Page[]>([]);
  const [tgtPage, setTgtPage] = useState(1);
  const [fallback, setFallback] = useState(true);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState<"words" | "save" | "run" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [anchorDraft, setAnchorDraft] = useState<{ box: Box; text: string } | null>(null);

  const loadTemplates = useCallback(() => api<{ templates: OcrTemplate[] }>("/api/ocr/templates").then((r) => setTemplates(r.templates)).catch(() => {}), []);
  useEffect(() => {
    api<{ documents: Document[] }>("/api/documents").then((r) => {
      const ready = r.documents.filter((d) => d.status === "ready");
      setDocs(ready);
      setSrcDoc(ready.find((d) => d.sample_key === "pharmacy-bill-1")?.id ?? ready[0]?.id ?? null);
      setTgtDoc(ready.find((d) => d.sample_key === "pharmacy-bill-3-scan")?.id ?? ready[0]?.id ?? null);
    }).catch(() => setDocs([]));
    void loadTemplates();
  }, [loadTemplates]);
  useEffect(() => { if (srcDoc) { setSrcLoading(true); api<{ pages: Page[] }>(`/api/documents/${srcDoc}`).then((r) => { setSrcPages(r.pages); setSrcPage(1); setWords(null); }).finally(() => setSrcLoading(false)); } }, [srcDoc]);
  useEffect(() => { if (tgtDoc) { setTgtLoading(true); api<{ pages: Page[] }>(`/api/documents/${tgtDoc}`).then((r) => { setTgtPages(r.pages); setTgtPage(1); setResult(null); }).finally(() => setTgtLoading(false)); } }, [tgtDoc]);

  async function detectWords() {
    setBusy("words"); setErr(null);
    try { setWords((await api<{ words: Word[] }>("/api/ocr/words", { method: "POST", body: JSON.stringify({ document_id: srcDoc, page_number: srcPage }) })).words); setShowWords(true); }
    catch (e) { setErr(String(e)); } finally { setBusy(null); }
  }

  function onDraw(box: Box) {
    if (box.w < 0.005 || box.h < 0.004) return;
    if (mode === "field") { setFields((f) => [...f, { name: `field_${f.length + 1}`, type: "text", page: srcPage, box }]); return; }
    const inside = (words ?? []).filter((w) => w.box.x >= box.x - 0.005 && w.box.y >= box.y - 0.005 && w.box.x + w.box.w <= box.x + box.w + 0.005 && w.box.y + w.box.h <= box.y + box.h + 0.005);
    const text = inside.map((w) => w.text).join(" ");
    if (text) setAnchors((a) => [...a, { text, page: srcPage, box }]);
    else setAnchorDraft({ box, text: "" });   // no detected word in the box: ask for the printed word
  }

  function loadTemplate(id: string | null) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setName(t.name); setFields(t.fields); setAnchors(t.anchors);
    if (t.document_id && (docs ?? []).some((d) => d.id === t.document_id)) setSrcDoc(t.document_id);
  }

  async function save() {
    if (!fields.length) { setErr("Draw at least one field box first."); return; }
    setBusy("save"); setErr(null);
    try { await api("/api/ocr/templates", { method: "POST", body: JSON.stringify({ name, document_id: srcDoc, fields, anchors }) }); await loadTemplates(); }
    catch (e) { setErr(String(e)); } finally { setBusy(null); }
  }

  async function run() {
    if (!fields.length) { setErr("No fields to read. Draw boxes or load a saved template."); return; }
    setBusy("run"); setErr(null); setResult(null);
    try {
      const saved = templates.find((t) => t.name === name);
      const r = await api<{ result: RunResult }>("/api/ocr/run", { method: "POST", body: JSON.stringify({ document_id: tgtDoc, page_number: tgtPage, template: { name, fields, anchors }, template_id: saved?.id ?? null, fallback, save: true }) });
      setResult(r.result);
    } catch (e) { setErr(String(e)); } finally { setBusy(null); }
  }

  const header = (
    <PageHeader size="sm">
      <PageHeaderRow>
        <PageHeaderContent>
          <PageHeaderTitle>Forms</PageHeaderTitle>
          <PageHeaderDescription>Mark the fields once on a sample form, then read any scan of the same form.</PageHeaderDescription>
        </PageHeaderContent>
      </PageHeaderRow>
    </PageHeader>
  );
  if (docs !== null && docs.length === 0) {
    return (
      <>
        {header}
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No documents to work on</EmptyTitle>
            <EmptyDescription>Load the samples to get the pharmacy bills, or upload a scanned form of your own.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><Button size="sm" nativeButton={false} render={<Link href="/" />}>Go to Documents</Button></EmptyContent>
        </Empty>
      </>
    );
  }

  const docItems = (docs ?? []).map((d) => ({ value: d.id, label: d.name.replace(/\.pdf$/i, "") }));
  const tplItems = templates.map((t) => ({ value: t.id, label: `${t.name} (${t.fields.length} fields, ${t.anchors.length} anchors)` }));
  const sp = srcPages.find((p) => p.page_number === srcPage);
  const tp = tgtPages.find((p) => p.page_number === tgtPage);
  const tgtBoxes = result ? result.fields.map((f) => ({ box: f.box_used, label: f.name, ok: f.valid })) : fields.filter((f) => f.page === tgtPage).map((f) => ({ box: f.box, label: f.name, ok: true }));

  return (
    <>
      {header}
      {err && <Alert status="fail"><AlertTitle>The last step failed</AlertTitle><AlertDescription>{err}</AlertDescription></Alert>}

      <SkeletonSwap loading={docs === null} label="Loading forms" fallback={<div className="grid gap-6 lg:grid-cols-2"><Skeleton className="min-h-96" /><Skeleton className="min-h-96" /></div>}>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card role="group" aria-labelledby="template-title">
            <CardHeader>
              <CardTitle id="template-title">Template</CardTitle>
              <CardDescription>Draw a box around each value you want read. Add two or three words that always appear on the form.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Select items={docItems} value={srcDoc} onValueChange={(v) => setSrcDoc(v)}>
                    <SelectTrigger size="sm" aria-label="Sample form"><SelectValue placeholder="Pick a sample form" /></SelectTrigger>
                    <SelectContent>{docItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
                  </Select>
                  <Input mode="number" size="sm" aria-label="Page" min={1} max={srcPages.length || 1} value={srcPage} onValueChange={(v) => { if (v !== null) setSrcPage(Math.max(1, v)); }} className="w-20" />
                  <ButtonGroup aria-label="What a drawn box becomes">
                    <Button variant="secondary" size="sm" pressed={mode === "field"} onPressedChange={() => setMode("field")}>Draw field</Button>
                    <Button variant="secondary" size="sm" pressed={mode === "anchor"} onPressedChange={() => setMode("anchor")}>Draw anchor</Button>
                  </ButtonGroup>
                  <Button variant="secondary" size="sm" onClick={detectWords} pending={busy === "words"} pendingLabel="Detecting">Detect words</Button>
                  {words && <Label className="flex items-center gap-2"><Checkbox checked={showWords} onCheckedChange={(c) => setShowWords(!!c)} />Show words</Label>}
                </div>

                {srcLoading && <Skeleton className="min-h-96" />}
                {!srcLoading && sp && (
                  <DrawableViewer imageUrl={pageUrl(sp)} alt={`Page ${srcPage} of the sample form`} onDraw={onDraw}>
                    {showWords && (words ?? []).map((w, i) => <div key={i} title={`${w.text} (${w.conf})`} className={cn(BOX, "border border-hair")} style={at(w.box)} />)}
                    {fields.filter((f) => f.page === srcPage).map((f, i) => (
                      <div key={`f${i}`} className={cn(BOX, "border-2 border-strong")} style={at(f.box)}><Badge size="sm" className="absolute -top-4 left-0">{f.name}</Badge></div>
                    ))}
                    {anchors.filter((a) => a.page === srcPage).map((a, i) => (
                      <div key={`a${i}`} data-kind="key" className={cn(BOX, "border-2 border-dashed border-accent-mark")} style={at(a.box)}><Badge kind="key" size="sm" label={a.text} className="absolute -top-4 left-0" /></div>
                    ))}
                  </DrawableViewer>
                )}
                {!srcLoading && !sp && <p className="type-body-sm text-text-2">No rendered page yet. Process a document first.</p>}

                <div className="flex flex-col gap-2">
                  <Label className="flex items-center gap-2"><span className="w-24 shrink-0">Template name</span><Input size="sm" aria-label="Template name" value={name} onValueChange={setName} className="flex-1" /></Label>
                  {fields.map((f, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Input size="sm" aria-label={`Field ${i + 1} name`} value={f.name} onValueChange={(v) => setFields(fields.map((x, j) => j === i ? { ...x, name: v.replace(/\s+/g, "_") } : x))} className="w-36" />
                      <Select items={FIELD_TYPES.map((t) => ({ value: t, label: t }))} value={f.type} onValueChange={(v) => { if (v) setFields(fields.map((x, j) => j === i ? { ...x, type: v as OcrField["type"] } : x)); }}>
                        <SelectTrigger size="sm" aria-label={`Field ${i + 1} type`}><SelectValue /></SelectTrigger>
                        <SelectContent>{FIELD_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                      </Select>
                      <Input size="sm" aria-label={`Field ${i + 1} pattern`} value={f.pattern ?? ""} onValueChange={(v) => setFields(fields.map((x, j) => j === i ? { ...x, pattern: v || undefined } : x))} placeholder="Pattern, optional" className="min-w-32 flex-1" />
                      <Button variant="ghost" size="icon-xs" aria-label={`Remove field ${f.name}`} onClick={() => setFields(fields.filter((_, j) => j !== i))}><Icon icon={Close} /></Button>
                    </div>
                  ))}
                  {anchors.map((a, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Badge kind="key" />
                      <Input size="sm" aria-label={`Anchor ${i + 1} word`} value={a.text} onValueChange={(v) => setAnchors(anchors.map((x, j) => j === i ? { ...x, text: v } : x))} className="w-48" />
                      <span className="type-body-sm text-text-2">Page {a.page}</span>
                      <Button variant="ghost" size="icon-xs" aria-label={`Remove anchor ${a.text}`} onClick={() => setAnchors(anchors.filter((_, j) => j !== i))} className="ms-auto"><Icon icon={Close} /></Button>
                    </div>
                  ))}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={save} pending={busy === "save"} pendingLabel="Saving">Save template</Button>
                    <Button variant="ghost" size="sm" onClick={() => { setFields([]); setAnchors([]); setName("New template"); }}>Clear</Button>
                    {templates.length > 0 && (
                      <Select items={tplItems} value={null} onValueChange={(v) => loadTemplate(v)}>
                        <SelectTrigger size="sm" aria-label="Saved templates"><SelectValue placeholder="Load a saved template" /></SelectTrigger>
                        <SelectContent>{tplItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card role="group" aria-labelledby="run-title">
            <CardHeader>
              <CardTitle id="run-title">Run</CardTitle>
              <CardDescription>The boxes follow the form wherever it sits on the scan.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Select items={docItems} value={tgtDoc} onValueChange={(v) => setTgtDoc(v)}>
                    <SelectTrigger size="sm" aria-label="Scan to read"><SelectValue placeholder="Pick a scan" /></SelectTrigger>
                    <SelectContent>{docItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
                  </Select>
                  <Input mode="number" size="sm" aria-label="Page" min={1} max={tgtPages.length || 1} value={tgtPage} onValueChange={(v) => { if (v !== null) setTgtPage(Math.max(1, v)); }} className="w-20" />
                  <Label className="flex items-center gap-2"><Checkbox checked={fallback} onCheckedChange={(c) => setFallback(!!c)} />Model fallback</Label>
                  <Button size="sm" onClick={run} pending={busy === "run"} pendingLabel="Reading fields" disabled={!fields.length} focusableWhenDisabled aria-describedby={fields.length ? undefined : "run-hint"}>Run template</Button>
                  {!fields.length && <p id="run-hint" className="type-body-sm text-text-2">Draw a field or load a saved template first.</p>}
                </div>
                {busy === "run" && <Status status="running" live>Reading fields</Status>}

                {tgtLoading && <Skeleton className="min-h-96" />}
                {!tgtLoading && tp && (
                  <div className="frame relative bg-paper select-none">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={pageUrl(tp)} alt={`Page ${tgtPage} of the scan`} className="block w-full" draggable={false} />
                    {tgtBoxes.map((b, i) => {
                      const failed = !!result && !b.ok;
                      return (
                        <div key={i} className={cn(BOX, "border-2 border-strong", !result && "border-dashed", failed && "border-warn")} style={at(b.box)}>
                          <Badge size="sm" status={failed ? "warn" : undefined} className="absolute -top-4 left-0">{b.label}</Badge>
                        </div>
                      );
                    })}
                  </div>
                )}

                {result && (
                  <div className="flex flex-col gap-3">
                    <p className="type-body-sm text-text-2">
                      Deskew {result.deskew_angle}°, shift {result.registration.dx.toFixed(0)} by {result.registration.dy.toFixed(0)} px, scale {result.registration.scale.toFixed(3)}. Anchors {result.registration.matched.length ? result.registration.matched.map((m) => `${m.anchor} found as ${m.found}`).join(", ") : "none"}.{result.fallback_used ? " Model fallback used." : ""}{result.fallback_error ? ` Fallback error ${result.fallback_error}.` : ""}
                    </p>
                    <Table aria-label="Fields read" title="Fields read" count={result.fields.length}>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Field</TableHead>
                          <TableHead>Value</TableHead>
                          <TableHead>As read</TableHead>
                          <TableHead>Confidence</TableHead>
                          <TableHead>Source</TableHead>
                          <TableHead>Check</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.fields.map((f) => (
                          <TableRow key={f.name}>
                            <TableCell>{f.name} <span className="text-text-2">{f.type}</span></TableCell>
                            <TableCell className="font-mono">{String(f.value ?? "")}</TableCell>
                            <TableCell className="font-mono text-text-2">{f.raw}{f.ocr_value !== undefined ? ` then ${String(f.ocr_value)}` : ""}</TableCell>
                            <TableCell className="data">{f.confidence}</TableCell>
                            <TableCell><Badge>{f.source}</Badge></TableCell>
                            <TableCell>{f.valid ? <Status status="ok">Valid</Status> : <Status status="warn">{f.note || "Check"}</Status>}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <p className="type-body-sm text-text-2">Saved with the scan. It is searchable now.</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </SkeletonSwap>

      <Dialog open={anchorDraft !== null} onOpenChange={(open) => { if (!open) setAnchorDraft(null); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Name the anchor word</DialogTitle>
            <DialogDescription>No detected word sits in that box. Type the word printed there; the boxes are placed by finding it on each scan.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field>
              <FieldLabel>Printed word</FieldLabel>
              <Input value={anchorDraft?.text ?? ""} onValueChange={(v) => setAnchorDraft((d) => (d ? { ...d, text: v } : d))} placeholder="For example INVOICE" data-autofocus />
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose>Cancel</DialogClose>
            <DialogAction disabled={!anchorDraft?.text.trim()} onAction={() => { if (anchorDraft?.text.trim()) setAnchors((a) => [...a, { text: anchorDraft.text.trim(), page: srcPage, box: anchorDraft.box }]); setAnchorDraft(null); }}>Add anchor</DialogAction>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The sample page with a pointer-drawn box. Quartz has no drawing surface; this is the one custom region on the screen. */
function DrawableViewer({ imageUrl, alt, onDraw, children }: { imageUrl: string; alt: string; onDraw: (b: Box) => void; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [cur, setCur] = useState<{ x: number; y: number } | null>(null);
  const rel = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const live = start && cur ? { x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y), w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y) } : null;
  return (
    <div ref={ref} className="frame relative cursor-crosshair touch-none bg-paper select-none"
      onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); setStart(rel(e)); setCur(rel(e)); }}
      onPointerMove={(e) => { if (start) setCur(rel(e)); }}
      onPointerUp={(e) => { if (start) { const p = rel(e); onDraw({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }); } setStart(null); setCur(null); }}
      onPointerCancel={() => { setStart(null); setCur(null); }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imageUrl} alt={alt} className="pointer-events-none block w-full" draggable={false} />
      {children}
      {live && <div className={cn(BOX, "border-2 border-strong bg-selected")} style={at(live)} />}
    </div>
  );
}
