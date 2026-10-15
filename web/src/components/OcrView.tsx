"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Close, Icon, ListChecked } from "@/components/quartz/icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/quartz/ui/alert";
import { Badge } from "@/components/quartz/ui/badge";
import { Button } from "@/components/quartz/ui/button";
import { ButtonGroup } from "@/components/quartz/ui/button-group";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/quartz/ui/card";
import { Checkbox } from "@/components/quartz/ui/checkbox";
import { Dialog, DialogAction, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/quartz/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/quartz/ui/empty-state";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "@/components/quartz/ui/field";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderRow, PageHeaderTitle } from "@/components/quartz/ui/page-header";
import { Input } from "@/components/quartz/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/quartz/ui/select";
import { Skeleton, SkeletonSwap } from "@/components/quartz/ui/skeleton";
import { Status } from "@/components/quartz/ui/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/quartz/ui/table";
import { cn } from "@/lib/quartz/utils";
import { SAMPLES } from "@/lib/samples";
import type { Document, OcrAnchor, OcrField, OcrTemplate, Page } from "@/lib/types";
import { api, publicAsset } from "@/lib/ui";

type Box = { x: number; y: number; w: number; h: number };
type Word = { text: string; conf: number; box: Box };
interface RunField { name: string; type: string; value: unknown; raw: string; confidence: number; source: string; valid: boolean; note: string; box_used: Box; ocr_value?: unknown }
interface RunResult { deskew_angle: number; registration: { dx: number; dy: number; scale: number; matched: { anchor: string; found: string }[] }; fields: RunField[]; needs_fallback: string[]; fallback_used?: boolean; fallback_error?: string }

/** The kinds of value a box can hold, in the words a person would use. */
const FIELD_TYPES: { value: OcrField["type"]; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "date", label: "Date" },
  { value: "amount", label: "Amount" },
  { value: "integer", label: "Whole number" },
];
const pageUrl = (p: Page) => p.image_url ?? publicAsset(p.image_path);
/** A box as custom properties, read by left-(--x) and friends. */
const at = (b: Box): CSSProperties => ({ "--x": `${b.x * 100}%`, "--y": `${b.y * 100}%`, "--w": `${b.w * 100}%`, "--h": `${b.h * 100}%` } as CSSProperties);
const BOX = "absolute top-(--y) left-(--x) h-(--h) w-(--w)";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What happened on the run, as sentences a person can read. */
function describe(r: RunResult): string {
  const parts: string[] = [];
  const angle = Math.abs(r.deskew_angle);
  parts.push(angle >= 0.05 ? `The scan was crooked by ${angle.toFixed(1)}° and was straightened.` : "The scan was straight.");
  const dx = Math.round(r.registration.dx);
  const dy = Math.round(r.registration.dy);
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) parts.push("The form sat where it does on the clean copy.");
  else {
    const across = dx ? `${Math.abs(dx)} px to the ${dx > 0 ? "right" : "left"}` : "";
    const down = dy ? `${Math.abs(dy)} px ${dy > 0 ? "down" : "up"}` : "";
    parts.push(`The form sat ${[across, down].filter(Boolean).join(" and ")} from where it is on the clean copy, so the boxes moved with it.`);
  }
  const m = r.registration.matched;
  if (m.length) parts.push(`${plural(m.length, "landmark word")} found: ${m.map((x) => (x.anchor === x.found ? x.anchor : `${x.anchor} as ${x.found}`)).join(", ")}.`);
  else parts.push("No landmark word was found, so the boxes were used where they were drawn.");
  const byModel = r.fields.filter((f) => f.source === "llm").length;
  if (r.fallback_used) parts.push(byModel ? `The model read ${plural(byModel, "value")} the scanner could not.` : "The model was asked, but the scanner's reading was kept.");
  if (r.fallback_error) parts.push(`The model could not help: ${r.fallback_error}.`);
  return parts.join(" ");
}

export function OcrView() {
  const router = useRouter();
  const [seeding, setSeeding] = useState(false);
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
  const [savedAs, setSavedAs] = useState<string | null>(null);
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

  // Any change to the template means it is no longer the one on file.
  const updateFields = (next: OcrField[]) => { setFields(next); setSavedAs(null); };
  const updateAnchors = (next: OcrAnchor[]) => { setAnchors(next); setSavedAs(null); };

  async function detectWords() {
    setBusy("words"); setErr(null);
    try { setWords((await api<{ words: Word[] }>("/api/ocr/words", { method: "POST", body: JSON.stringify({ document_id: srcDoc, page_number: srcPage }) })).words); setShowWords(true); }
    catch (e) { setErr(String(e)); } finally { setBusy(null); }
  }

  function onDraw(box: Box) {
    if (box.w < 0.005 || box.h < 0.004) return;
    if (mode === "field") { updateFields([...fields, { name: `value_${fields.length + 1}`, type: "text", page: srcPage, box }]); return; }
    const inside = (words ?? []).filter((w) => w.box.x >= box.x - 0.005 && w.box.y >= box.y - 0.005 && w.box.x + w.box.w <= box.x + box.w + 0.005 && w.box.y + w.box.h <= box.y + box.h + 0.005);
    const text = inside.map((w) => w.text).join(" ");
    if (text) updateAnchors([...anchors, { text, page: srcPage, box }]);
    else setAnchorDraft({ box, text: "" });   // no outlined word in the box: ask for the printed word
  }

  function loadTemplate(id: string | null) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setName(t.name); setFields(t.fields); setAnchors(t.anchors); setSavedAs(t.name);
    if (t.document_id && (docs ?? []).some((d) => d.id === t.document_id)) setSrcDoc(t.document_id);
  }

  async function save() {
    if (!fields.length) { setErr("Mark at least one value in step 1 first."); return; }
    setBusy("save"); setErr(null);
    try { await api("/api/ocr/templates", { method: "POST", body: JSON.stringify({ name, document_id: srcDoc, fields, anchors }) }); await loadTemplates(); setSavedAs(name); }
    catch (e) { setErr(String(e)); } finally { setBusy(null); }
  }

  async function run() {
    if (!fields.length) { setErr("Nothing to read yet. Mark a value in step 1 or load a saved template in step 2."); return; }
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
          <PageHeaderDescription>Teach it a form once, then read every scan of that form. Mark the values on a clean copy, and the same values are read off any new scan, even one that is shifted or crooked.</PageHeaderDescription>
        </PageHeaderContent>
      </PageHeaderRow>
    </PageHeader>
  );
  /** Start every sample processing and go to Documents, where the progress shows. */
  async function loadSamples() {
    setSeeding(true); setErr(null);
    try { await api("/api/samples", { method: "POST", body: JSON.stringify({ keys: SAMPLES.map((s) => s.key) }) }); router.push("/"); }
    catch (e) { setErr(String(e)); setSeeding(false); }
  }

  if (docs !== null && docs.length === 0) {
    return (
      <>
        {header}
        {err && <Alert status="fail"><AlertTitle>Loading the samples failed</AlertTitle><AlertDescription>{err}</AlertDescription></Alert>}
        <Empty>
          <EmptyHeader>
            <EmptyMedia><Icon icon={ListChecked} /></EmptyMedia>
            <EmptyTitle>No form to work on yet</EmptyTitle>
            <EmptyDescription>Load the samples for the pharmacy bills, or upload a scanned form of your own.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={loadSamples} pending={seeding} pendingLabel="Loading samples">Load samples</Button>
            <Button size="sm" variant="secondary" nativeButton={false} render={<Link href="/" />}>Go to Documents</Button>
          </EmptyContent>
        </Empty>
      </>
    );
  }

  const docItems = (docs ?? []).map((d) => ({ value: d.id, label: d.name.replace(/\.pdf$/i, "") }));
  const tplItems = templates.map((t) => ({ value: t.id, label: `${t.name} (${plural(t.fields.length, "value")}, ${plural(t.anchors.length, "landmark")})` }));
  const sp = srcPages.find((p) => p.page_number === srcPage);
  const tp = tgtPages.find((p) => p.page_number === tgtPage);
  const tgtBoxes = result ? result.fields.map((f) => ({ box: f.box_used, label: f.name, ok: f.valid })) : fields.filter((f) => f.page === tgtPage).map((f) => ({ box: f.box, label: f.name, ok: true }));
  const marked = fields.length ? `${plural(fields.length, "value")} and ${plural(anchors.length, "landmark word")} marked.` : "Nothing marked yet.";

  return (
    <>
      {header}
      {err && <Alert status="fail"><AlertTitle>The last step failed</AlertTitle><AlertDescription>{err}</AlertDescription></Alert>}

      <SkeletonSwap loading={docs === null} label="Loading forms" className="flex flex-col gap-6" fallback={<div className="flex flex-col gap-6"><Skeleton className="min-h-96" /><Skeleton className="min-h-24" /><Skeleton className="min-h-96" /></div>}>
        <Card role="group" aria-labelledby="step-1">
          <CardHeader>
            <CardTitle id="step-1">1. Mark what to read on a clean copy of the form</CardTitle>
            <CardDescription>Drag a box around each value you want read, such as the invoice number or the total. Then box two or three printed words that never change, such as INVOICE or TOTAL. These landmark words let the boxes find the form on a scan that is shifted or crooked.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-4">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <Field orientation="horizontal" className="w-auto">
                    <FieldLabel className="whitespace-nowrap">Clean copy</FieldLabel>
                    <Select items={docItems} value={srcDoc} onValueChange={(v) => setSrcDoc(v)}>
                      <SelectTrigger size="sm" className="w-56"><SelectValue placeholder="Pick a document" /></SelectTrigger>
                      <SelectContent>{docItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                  <Field orientation="horizontal" className="w-auto">
                    <FieldLabel className="whitespace-nowrap">Page</FieldLabel>
                    <Input mode="number" size="sm" min={1} max={srcPages.length || 1} value={srcPage} onValueChange={(v) => { if (v !== null) setSrcPage(Math.max(1, v)); }} className="w-20" />
                  </Field>
                </div>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <FieldTitle className="shrink-0">Each box I draw is a</FieldTitle>
                    <ButtonGroup aria-label="What a drawn box becomes">
                      <Button variant="secondary" size="sm" pressed={mode === "field"} onPressedChange={() => setMode("field")}>Value to read</Button>
                      <Button variant="secondary" size="sm" pressed={mode === "anchor"} onPressedChange={() => { setMode("anchor"); if (!words && busy !== "words") void detectWords(); }}>Landmark word</Button>
                    </ButtonGroup>
                  </div>
                  <div className="flex items-center gap-3">
                    <Button variant="secondary" size="sm" onClick={detectWords} pending={busy === "words"} pendingLabel="Outlining">Outline the words</Button>
                    {words && <label className="flex items-center gap-2 type-label text-text-1 select-none"><Checkbox checked={showWords} onCheckedChange={(c) => setShowWords(!!c)} />Show the outlines</label>}
                  </div>
                </div>

                {srcLoading && <Skeleton className="min-h-96" />}
                {!srcLoading && sp && (
                  <DrawableViewer imageUrl={pageUrl(sp)} alt={`Page ${srcPage} of the clean copy`} onDraw={onDraw}>
                    {showWords && (words ?? []).map((w, i) => <div key={i} title={`${w.text} (${w.conf})`} className={cn(BOX, "border border-control bg-selected")} style={at(w.box)} />)}
                    {fields.filter((f) => f.page === srcPage).map((f, i) => (
                      <div key={`f${i}`} className={cn(BOX, "border-2 border-strong")} style={at(f.box)}><Badge size="sm" className="absolute -top-4 left-0">{f.name}</Badge></div>
                    ))}
                    {anchors.filter((a) => a.page === srcPage).map((a, i) => (
                      <div key={`a${i}`} data-kind="key" className={cn(BOX, "border-2 border-dashed border-accent-mark")} style={at(a.box)}><Badge kind="key" size="sm" label={a.text} className="absolute -top-4 left-0" /></div>
                    ))}
                  </DrawableViewer>
                )}
                {!srcLoading && !sp && <p className="type-body-sm text-text-2">This document has no rendered page yet. Process it on the Documents page first.</p>}
              </div>

              <div className="flex min-w-0 flex-col gap-4">
                {fields.length === 0 && anchors.length === 0 && (
                  <Empty variant="plain">
                    <EmptyHeader>
                      <EmptyTitle>Nothing marked yet</EmptyTitle>
                      <EmptyDescription>Drag a box on the page around the first value you want read. It appears here, where you can name it and say what kind of value it is.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
                {fields.length > 0 && (
                  <Table aria-label="Values to read" title="Values to read" count={fields.length}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Kind</TableHead>
                        <TableHead>Must match</TableHead>
                        <TableHead><span className="sr-only">Remove</span></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fields.map((f, i) => (
                        <TableRow key={i}>
                          <TableCell><Input size="sm" aria-label={`Name of value ${i + 1}`} value={f.name} onValueChange={(v) => updateFields(fields.map((x, j) => j === i ? { ...x, name: v.replace(/\s+/g, "_") } : x))} className="w-36" /></TableCell>
                          <TableCell>
                            <Select items={FIELD_TYPES} value={f.type} onValueChange={(v) => { if (v) updateFields(fields.map((x, j) => j === i ? { ...x, type: v as OcrField["type"] } : x)); }}>
                              <SelectTrigger size="sm" aria-label={`Kind of value ${i + 1}`} className="w-36"><SelectValue /></SelectTrigger>
                              <SelectContent>{FIELD_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell><Input size="sm" aria-label={`Pattern value ${i + 1} must match`} value={f.pattern ?? ""} onValueChange={(v) => updateFields(fields.map((x, j) => j === i ? { ...x, pattern: v || undefined } : x))} placeholder="Optional" className="w-32" /></TableCell>
                          <TableCell><Button variant="ghost" size="icon-xs" aria-label={`Remove ${f.name}`} onClick={() => updateFields(fields.filter((_, j) => j !== i))}><Icon icon={Close} /></Button></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                {anchors.length > 0 && (
                  <Table aria-label="Landmark words" title="Landmark words" count={anchors.length}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Printed word</TableHead>
                        <TableHead>Page</TableHead>
                        <TableHead><span className="sr-only">Remove</span></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {anchors.map((a, i) => (
                        <TableRow key={i}>
                          <TableCell><Input size="sm" aria-label={`Landmark word ${i + 1}`} value={a.text} onValueChange={(v) => updateAnchors(anchors.map((x, j) => j === i ? { ...x, text: v } : x))} className="w-48" /></TableCell>
                          <TableCell className="data">{a.page}</TableCell>
                          <TableCell><Button variant="ghost" size="icon-xs" aria-label={`Remove landmark ${a.text}`} onClick={() => updateAnchors(anchors.filter((_, j) => j !== i))}><Icon icon={Close} /></Button></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                {fields.length > 0 && anchors.length === 0 && <p className="type-body-sm text-text-2">No landmark word yet. Without one, a shifted scan is read where the boxes were drawn. Switch to Landmark word and box a printed word such as INVOICE.</p>}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card role="group" aria-labelledby="step-2">
          <CardHeader>
            <CardTitle id="step-2">2. Save it as a template</CardTitle>
            <CardDescription>A saved template reads any scan of this form later, without marking it again. {marked}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <Field orientation="horizontal" className="w-auto">
                <FieldLabel className="whitespace-nowrap">Template name</FieldLabel>
                <Input size="sm" value={name} onValueChange={(v) => { setName(v); setSavedAs(null); }} className="w-56" />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={save} pending={busy === "save"} pendingLabel="Saving" disabled={!fields.length} focusableWhenDisabled aria-describedby={fields.length ? undefined : "save-hint"}>Save template</Button>
                <Button variant="ghost" size="sm" onClick={() => { setFields([]); setAnchors([]); setName("New template"); setSavedAs(null); }}>Start over</Button>
                {savedAs && <Status status="ok">Saved</Status>}
                {!fields.length && <span id="save-hint" className="type-body-sm text-text-2">Mark a value in step 1 first.</span>}
              </div>
              {templates.length > 0 && (
                <Field orientation="horizontal" className="w-auto">
                  <FieldLabel className="whitespace-nowrap">Saved templates</FieldLabel>
                  <Select items={tplItems} value={null} onValueChange={(v) => loadTemplate(v)}>
                    <SelectTrigger size="sm" className="w-64"><SelectValue placeholder="Load one" /></SelectTrigger>
                    <SelectContent>{tplItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
              )}
            </div>
          </CardContent>
        </Card>

        <Card role="group" aria-labelledby="step-3">
          <CardHeader>
            <CardTitle id="step-3">3. Read a scan of the same form</CardTitle>
            <CardDescription>Pick any scan of this form. The landmark words place the boxes, then each value is read, checked against its kind, and saved with the scan so it can be searched.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <Field orientation="horizontal" className="w-auto">
                  <FieldLabel className="whitespace-nowrap">Scan</FieldLabel>
                  <Select items={docItems} value={tgtDoc} onValueChange={(v) => setTgtDoc(v)}>
                    <SelectTrigger size="sm" className="w-56"><SelectValue placeholder="Pick a scan" /></SelectTrigger>
                    <SelectContent>{docItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
                <Field orientation="horizontal" className="w-auto">
                  <FieldLabel className="whitespace-nowrap">Page</FieldLabel>
                  <Input mode="number" size="sm" min={1} max={tgtPages.length || 1} value={tgtPage} onValueChange={(v) => { if (v !== null) setTgtPage(Math.max(1, v)); }} className="w-20" />
                </Field>
              </div>
              <Field orientation="horizontal" className="w-auto">
                <Checkbox checked={fallback} onCheckedChange={(c) => setFallback(!!c)} />
                <FieldContent>
                  <FieldLabel>Ask the model when a value cannot be read</FieldLabel>
                  <FieldDescription>A value the scanner misses, or that fails its check, is read from the image by the model instead.</FieldDescription>
                </FieldContent>
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" onClick={run} pending={busy === "run"} pendingLabel="Reading" disabled={!fields.length} focusableWhenDisabled aria-describedby={fields.length ? undefined : "run-hint"}>Read the scan</Button>
                {!fields.length && <span id="run-hint" className="type-body-sm text-text-2">Mark a value in step 1, or load a saved template in step 2.</span>}
                {busy === "run" && <Status status="running" live>Finding the form and reading each box</Status>}
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <div className="min-w-0">
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
                </div>

                <div className="flex min-w-0 flex-col gap-3">
                  {!result && fields.length > 0 && <p className="type-body-sm text-text-2">The dashed boxes show where the values were marked on the clean copy. Press Read the scan to find the form and read them.</p>}
                  {result && (
                    <>
                      <p className="type-body-sm text-text-2">{describe(result)}</p>
                      <Table aria-label="Values read" title="Values read" count={result.fields.length}>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Value</TableHead>
                            <TableHead>Read as</TableHead>
                            <TableHead>Confidence</TableHead>
                            <TableHead>Check</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {result.fields.map((f) => (
                            <TableRow key={f.name}>
                              <TableCell>{f.name} <span className="text-text-2">{FIELD_TYPES.find((t) => t.value === f.type)?.label.toLowerCase() ?? f.type}</span></TableCell>
                              <TableCell className="font-mono">{String(f.value ?? "")}{f.ocr_value !== undefined ? <span className="block type-body-sm text-text-2">the scanner read {String(f.ocr_value ?? "nothing")}</span> : f.raw && f.raw !== String(f.value ?? "") ? <span className="block type-body-sm text-text-2">from {f.raw}</span> : null}</TableCell>
                              <TableCell className="data">{f.confidence}</TableCell>
                              <TableCell>{f.valid ? <Status status="ok">{f.source === "llm" ? "Valid, read by the model" : "Valid"}</Status> : <Status status="warn">{f.note || "Check it"}</Status>}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      <p className="type-body-sm text-text-2">Saved with the scan. These values can be searched now.</p>
                    </>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </SkeletonSwap>

      <Dialog open={anchorDraft !== null} onOpenChange={(open) => { if (!open) setAnchorDraft(null); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Which word is printed there?</DialogTitle>
            <DialogDescription>No outlined word sits inside that box. Type the word printed there. The boxes are placed by finding it on each scan.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field>
              <FieldLabel>Printed word</FieldLabel>
              <Input value={anchorDraft?.text ?? ""} onValueChange={(v) => setAnchorDraft((d) => (d ? { ...d, text: v } : d))} placeholder="For example INVOICE" data-autofocus />
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose>Cancel</DialogClose>
            <DialogAction disabled={!anchorDraft?.text.trim()} onAction={() => { if (anchorDraft?.text.trim()) updateAnchors([...anchors, { text: anchorDraft.text.trim(), page: srcPage, box: anchorDraft.box }]); setAnchorDraft(null); }}>Add landmark</DialogAction>
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
