"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Eraser, FileText, Loader2, Play, Save, ScanSearch, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Document, OcrAnchor, OcrField, OcrTemplate, Page } from "@/lib/types";
import { api, publicAsset } from "@/lib/ui";
import { cn } from "@/lib/utils";
import { EmptyState } from "./EmptyState";
import { PageHeader } from "./PageHeader";
import { ImageSkeleton, PageSkeleton } from "./Skeletons";
import { Panel } from "./Panel";
import { Pill } from "./Chips";

type Box = { x: number; y: number; w: number; h: number };
type Word = { text: string; conf: number; box: Box };
interface RunField { name: string; type: string; value: unknown; raw: string; confidence: number; source: string; valid: boolean; note: string; box_used: Box; ocr_value?: unknown }
interface RunResult { deskew_angle: number; registration: { dx: number; dy: number; scale: number; matched: { anchor: string; found: string }[] }; fields: RunField[]; needs_fallback: string[]; fallback_used?: boolean; fallback_error?: string }

const FIELD_TYPES = ["text", "date", "amount", "integer"] as const;
const pageUrl = (p: Page) => p.image_url ?? publicAsset(p.image_path);
const pct = (b: Box): React.CSSProperties => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });

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
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadTemplates = useCallback(() => api<{ templates: OcrTemplate[] }>("/api/ocr/templates").then((r) => setTemplates(r.templates)).catch(() => {}), []);
  useEffect(() => {
    api<{ documents: Document[] }>("/api/documents").then((r) => {
      const ready = r.documents.filter((d) => d.status === "ready");
      setDocs(ready);
      setSrcDoc(ready.find((d) => d.sample_key === "pharmacy-bill-1")?.id ?? ready[0]?.id ?? null);
      setTgtDoc(ready.find((d) => d.sample_key === "pharmacy-bill-3-scan")?.id ?? ready[0]?.id ?? null);
    }).catch(() => {});
    void loadTemplates();
  }, [loadTemplates]);
  useEffect(() => { if (srcDoc) { setSrcLoading(true); api<{ pages: Page[] }>(`/api/documents/${srcDoc}`).then((r) => { setSrcPages(r.pages); setSrcPage(1); setWords(null); }).finally(() => setSrcLoading(false)); } }, [srcDoc]);
  useEffect(() => { if (tgtDoc) { setTgtLoading(true); api<{ pages: Page[] }>(`/api/documents/${tgtDoc}`).then((r) => { setTgtPages(r.pages); setTgtPage(1); setResult(null); }).finally(() => setTgtLoading(false)); } }, [tgtDoc]);

  async function detectWords() {
    setBusy("Detecting words…"); setErr(null);
    try { setWords((await api<{ words: Word[] }>("/api/ocr/words", { method: "POST", body: JSON.stringify({ document_id: srcDoc, page_number: srcPage }) })).words); setShowWords(true); }
    catch (e) { setErr(String(e)); } finally { setBusy(null); }
  }

  function onDraw(box: Box) {
    if (box.w < 0.005 || box.h < 0.004) return;
    if (mode === "field") { setFields((f) => [...f, { name: `field_${f.length + 1}`, type: "text", page: srcPage, box }]); return; }
    const inside = (words ?? []).filter((w) => w.box.x >= box.x - 0.005 && w.box.y >= box.y - 0.005 && w.box.x + w.box.w <= box.x + box.w + 0.005 && w.box.y + w.box.h <= box.y + box.h + 0.005);
    const text = inside.map((w) => w.text).join(" ") || prompt("Anchor text (the word printed inside this box):") || "";
    if (text) setAnchors((a) => [...a, { text, page: srcPage, box }]);
  }

  function loadTemplate(id: string | null) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setName(t.name); setFields(t.fields); setAnchors(t.anchors);
    if (t.document_id && (docs ?? []).some((d) => d.id === t.document_id)) setSrcDoc(t.document_id);
  }

  async function save() {
    if (!fields.length) { setErr("Draw at least one field box first."); return; }
    setBusy("Saving…"); setErr(null);
    try { await api("/api/ocr/templates", { method: "POST", body: JSON.stringify({ name, document_id: srcDoc, fields, anchors }) }); await loadTemplates(); }
    catch (e) { setErr(String(e)); } finally { setBusy(null); }
  }

  async function run() {
    if (!fields.length) { setErr("No fields to extract. Draw boxes or load a saved template."); return; }
    setBusy("Running OCR…"); setErr(null); setResult(null);
    try {
      const saved = templates.find((t) => t.name === name);
      const r = await api<{ result: RunResult }>("/api/ocr/run", { method: "POST", body: JSON.stringify({ document_id: tgtDoc, page_number: tgtPage, template: { name, fields, anchors }, template_id: saved?.id ?? null, fallback, save: true }) });
      setResult(r.result);
    } catch (e) { setErr(String(e)); } finally { setBusy(null); }
  }

  const header = <PageHeader title="Forms" subtitle="Mark the fields once on a sample form, then read any scan of the same form." />;
  if (docs === null) return <div className="space-y-5">{header}<PageSkeleton panels={2} /></div>;
  if (docs.length === 0) {
    return (
      <div className="space-y-5">
        {header}
        <Panel>
          <EmptyState icon={<FileText />} title="No documents to work on" hint="Load the samples to get the pharmacy bills, or upload a scanned form of your own.">
            <Button nativeButton={false} render={<Link href="/" />}>Go to Documents</Button>
          </EmptyState>
        </Panel>
      </div>
    );
  }

  const docItems = (docs ?? []).map((d) => ({ value: d.id, label: d.name }));
  const tplItems = templates.map((t) => ({ value: t.id, label: `${t.name} (${t.fields.length} fields, ${t.anchors.length} anchors)` }));
  const sp = srcPages.find((p) => p.page_number === srcPage);
  const tp = tgtPages.find((p) => p.page_number === tgtPage);
  const tgtBoxes = result ? result.fields.map((f) => ({ box: f.box_used, label: f.name, ok: f.valid })) : fields.filter((f) => f.page === tgtPage).map((f) => ({ box: f.box, label: f.name, ok: true }));

  return (
    <div className="space-y-5">
      {header}
      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Template" description="Draw a box around each value you want read. Add two or three words that always appear on the form.">
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <Select value={srcDoc} onValueChange={(v) => setSrcDoc(v as string | null)} items={docItems}>
                <SelectTrigger className="w-full bg-card sm:w-64"><SelectValue placeholder="Source document" /></SelectTrigger>
                <SelectContent className="min-w-[18rem]">{docItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <Input type="number" min={1} max={srcPages.length || 1} value={srcPage} onChange={(e) => setSrcPage(Number(e.target.value) || 1)} className="w-16 text-center" aria-label="page" />
                <Tabs value={mode} onValueChange={(v) => setMode(v as "field" | "anchor")}><TabsList><TabsTrigger value="field">draw field</TabsTrigger><TabsTrigger value="anchor">draw anchor</TabsTrigger></TabsList></Tabs>
                <Button variant="outline" size="sm" onClick={detectWords} disabled={!!busy}><ScanSearch data-icon="inline-start" />detect words</Button>
              </div>
              {words && <Label className="flex items-center gap-1.5 text-xs"><Checkbox checked={showWords} onCheckedChange={(c) => setShowWords(!!c)} /> show words</Label>}
            </div>
            {srcLoading && <ImageSkeleton />}
            {!srcLoading && sp ? (
              <DrawableViewer imageUrl={pageUrl(sp)} onDraw={onDraw}>
                {showWords && (words ?? []).map((w, i) => <div key={i} title={`${w.text} (${w.conf})`} className="absolute border border-muted-foreground/40 bg-muted-foreground/5" style={pct(w.box)} />)}
                {fields.filter((f) => f.page === srcPage).map((f, i) => <div key={`f${i}`} className="absolute border-2 border-primary bg-primary/10" style={pct(f.box)}><span className="absolute -top-4 left-0 rounded bg-primary px-1 text-[10px] text-primary-foreground">{f.name}</span></div>)}
                {anchors.filter((a) => a.page === srcPage).map((a, i) => <div key={`a${i}`} className="absolute border-2 border-dashed border-emerald-600 bg-emerald-500/10" style={pct(a.box)}><span className="absolute -top-4 left-0 rounded bg-emerald-600 px-1 text-[10px] text-white">⚓ {a.text}</span></div>)}
              </DrawableViewer>
            ) : !srcLoading && <p className="text-sm text-muted-foreground">No rendered page. Ingest a document first.</p>}

            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2"><Label className="w-24 text-xs text-muted-foreground">Template</Label><Input value={name} onChange={(e) => setName(e.target.value)} className="h-8" /></div>
              {fields.map((f, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-primary">▣</span>
                  <Input value={f.name} onChange={(e) => setFields(fields.map((x, j) => j === i ? { ...x, name: e.target.value.replace(/\s+/g, "_") } : x))} className="h-8 w-36" />
                  <Select value={f.type} onValueChange={(v) => setFields(fields.map((x, j) => j === i ? { ...x, type: v as OcrField["type"] } : x))} items={FIELD_TYPES.map((t) => ({ value: t, label: t }))}>
                    <SelectTrigger size="sm" className="w-28"><SelectValue /></SelectTrigger>
                    <SelectContent className="min-w-[18rem]">{FIELD_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                  </Select>
                  <Input value={f.pattern ?? ""} onChange={(e) => setFields(fields.map((x, j) => j === i ? { ...x, pattern: e.target.value || undefined } : x))} placeholder="regex (optional)" className="h-8 min-w-32 flex-1 font-mono text-xs" />
                  <Button variant="ghost" size="icon-xs" className="text-destructive" onClick={() => setFields(fields.filter((_, j) => j !== i))} aria-label="remove"><X /></Button>
                </div>
              ))}
              {anchors.map((a, i) => (
                <div key={i} className="flex items-center gap-2"><span className="text-xs text-emerald-600">⚓</span>
                  <Input value={a.text} onChange={(e) => setAnchors(anchors.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} className="h-8 w-48" />
                  <span className="text-xs text-muted-foreground">anchor word, p.{a.page}</span>
                  <Button variant="ghost" size="icon-xs" className="ml-auto text-destructive" onClick={() => setAnchors(anchors.filter((_, j) => j !== i))} aria-label="remove"><X /></Button>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button size="sm" onClick={save} disabled={!!busy}><Save data-icon="inline-start" />Save template</Button>
                <Button variant="outline" size="sm" onClick={() => { setFields([]); setAnchors([]); setName("New template"); }}><Eraser data-icon="inline-start" />Clear</Button>
                {templates.length > 0 && (
                  <Select value={null} onValueChange={(v) => loadTemplate(v as string | null)} items={tplItems}>
                    <SelectTrigger size="sm" className="w-full bg-card sm:w-64"><SelectValue placeholder="Load saved template" /></SelectTrigger>
                    <SelectContent className="min-w-[18rem]">{tplItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
                  </Select>
                )}
                {busy && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />{busy}</span>}
              </div>
            </div>
          </div>
        </Panel>

        <Panel title="Run" description="The boxes follow the form wherever it sits on the scan.">
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <Select value={tgtDoc} onValueChange={(v) => setTgtDoc(v as string | null)} items={docItems}>
                <SelectTrigger className="w-full bg-card sm:w-64"><SelectValue placeholder="Target document" /></SelectTrigger>
                <SelectContent className="min-w-[18rem]">{docItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <Input type="number" min={1} max={tgtPages.length || 1} value={tgtPage} onChange={(e) => setTgtPage(Number(e.target.value) || 1)} className="w-16 text-center" aria-label="page" />
                <Label className="flex items-center gap-1.5 text-xs"><Checkbox checked={fallback} onCheckedChange={(c) => setFallback(!!c)} /> model fallback</Label>
                <Button size="sm" onClick={run} disabled={!!busy || !fields.length}><Play data-icon="inline-start" />Run template</Button>
              </div>
            </div>
            {tgtLoading && <ImageSkeleton />}
            {!tgtLoading && tp && (
              <div className="relative overflow-hidden rounded-[1rem] bg-white ring-1 ring-black/5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={pageUrl(tp)} alt="target page" className="block w-full" />
                {busy === "Running OCR…" && <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-[1px]"><span className="flex items-center gap-2 rounded-full bg-card px-3 py-1.5 text-sm shadow-sm ring-1 ring-black/5"><Loader2 className="size-4 animate-spin" />Reading fields</span></div>}
                {tgtBoxes.map((b, i) => (
                  <div key={i} className={cn("absolute border-2", result ? (b.ok ? "border-emerald-600 bg-emerald-500/10" : "border-amber-500 bg-amber-500/10") : "border-dashed border-primary/60")} style={pct(b.box)}><span className="absolute -top-4 left-0 rounded bg-foreground px-1 text-[10px] text-background">{b.label}</span></div>
                ))}
              </div>
            )}
            {result && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Deskew {result.deskew_angle}°, shift {result.registration.dx.toFixed(0)} by {result.registration.dy.toFixed(0)} px, scale {result.registration.scale.toFixed(3)}. Anchors {result.registration.matched.length ? result.registration.matched.map((m) => `${m.anchor}→${m.found}`).join(", ") : "none"}.{result.fallback_used ? " Model fallback used." : ""}{result.fallback_error ? ` Fallback error ${result.fallback_error}.` : ""}
                </p>
                <div className="overflow-x-auto rounded-xl ring-1 ring-black/5">
                  <Table>
                    <TableHeader><TableRow><TableHead>Field</TableHead><TableHead>Value</TableHead><TableHead className="hidden md:table-cell">As read</TableHead><TableHead>Confidence</TableHead><TableHead>Source</TableHead><TableHead className="hidden lg:table-cell">Note</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {result.fields.map((f) => (
                        <TableRow key={f.name}>
                          <TableCell className="font-medium">{f.name} <span className="text-xs text-muted-foreground">{f.type}</span></TableCell>
                          <TableCell className="font-mono">{String(f.value ?? "")}</TableCell>
                          <TableCell className="hidden font-mono text-muted-foreground md:table-cell">{f.raw}{f.ocr_value !== undefined ? ` → ${String(f.ocr_value)}` : ""}</TableCell>
                          <TableCell>{f.confidence}</TableCell>
                          <TableCell><Pill tone={f.source === "llm" ? "teal" : f.valid ? "green" : "amber"}>{f.source}</Pill></TableCell>
                          <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">{f.note}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <p className="text-xs text-muted-foreground">Saved as a record chunk of the target document. It is searchable now.</p>
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function DrawableViewer({ imageUrl, onDraw, children }: { imageUrl: string; onDraw: (b: Box) => void; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [cur, setCur] = useState<{ x: number; y: number } | null>(null);
  const rel = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const live = start && cur ? { x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y), w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y) } : null;
  return (
    <div ref={ref} className="relative cursor-crosshair touch-none overflow-hidden rounded-[1rem] bg-white ring-1 ring-black/5 select-none"
      onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); setStart(rel(e)); setCur(rel(e)); }}
      onPointerMove={(e) => { if (start) setCur(rel(e)); }}
      onPointerUp={(e) => { if (start) { const p = rel(e); onDraw({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }); } setStart(null); setCur(null); }}
      onPointerCancel={() => { setStart(null); setCur(null); }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imageUrl} alt="page" className="pointer-events-none block w-full" draggable={false} />
      {children}
      {live && <div className="absolute border-2 border-foreground bg-foreground/10" style={pct(live)} />}
    </div>
  );
}
