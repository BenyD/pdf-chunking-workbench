"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Close, Download, Icon, ListChecked } from "@/components/quartz/icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/quartz/ui/alert";
import { Badge } from "@/components/quartz/ui/badge";
import { Button } from "@/components/quartz/ui/button";
import { ButtonGroup } from "@/components/quartz/ui/button-group";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/quartz/ui/card";
import { Checkbox } from "@/components/quartz/ui/checkbox";
import { Dialog, DialogAction, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/quartz/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/quartz/ui/empty-state";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/quartz/ui/field";
import { Input } from "@/components/quartz/ui/input";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/quartz/ui/item";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderRow, PageHeaderTitle } from "@/components/quartz/ui/page-header";
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
const docName = (d: Document) => d.name.replace(/\.pdf$/i, "");

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
  if (m.length) parts.push(`Found by ${plural(m.length, "printed word")}: ${m.map((x) => (x.anchor === x.found ? x.anchor : `${x.anchor} as ${x.found}`)).join(", ")}.`);
  else parts.push("No printed word was found, so the boxes were used where they were drawn.");
  const byModel = r.fields.filter((f) => f.source === "llm").length;
  if (r.fallback_used) parts.push(byModel ? `The model read ${plural(byModel, "value")} the scanner could not.` : "The model was asked, but the scanner's reading was kept.");
  if (r.fallback_error) parts.push(`The model could not help: ${r.fallback_error}.`);
  return parts.join(" ");
}

/** The printed label to the left of a drawn box on the same line: the word the form is found by on a scan. */
function labelBeside(box: Box, words: Word[]): Word | null {
  const cy = box.y + box.h / 2;
  let best: Word | null = null;
  for (const w of words) {
    const wcy = w.box.y + w.box.h / 2;
    const right = w.box.x + w.box.w;
    if (Math.abs(wcy - cy) > Math.max(box.h, 0.012) * 0.8) continue;   // not on this line
    if (right > box.x + 0.005 || box.x - right > 0.3) continue;         // not to the left, or too far
    if (w.text.replace(/[^a-z0-9]/gi, "").length < 3) continue;        // a colon or a digit is not a landmark
    if (!best || right > best.box.x + best.box.w) best = w;
  }
  return best;
}

/** What kind of value a printed string looks like. */
function kindOf(text: string): OcrField["type"] {
  const t = text.trim();
  if (/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/.test(t) || /\b\d{4}-\d{2}-\d{2}\b/.test(t) || /\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{2,4}\b/i.test(t)) return "date";
  if (/^(rs\.?|inr|₹|\$|€|£)?\s*[\d,]+\.\d{1,2}$/i.test(t)) return "amount";
  if (/^\d{1,9}$/.test(t)) return "integer";
  return "text";
}

/**
 * The fields inside a drawn region, read off its printed words: the words are grouped into lines, a line is
 * cut into columns at wide gaps, and each piece is split into a label and a value at the colon or at its
 * widest gap. Each value becomes a field named by its label, with the kind the value's shape suggests; each
 * label becomes a landmark word. Returns nothing when the region holds no label, so the caller treats it as
 * one plain value.
 */
function splitRegion(region: Box, words: Word[], page: number): { fields: OcrField[]; anchors: OcrAnchor[] } {
  const inside = words.filter((w) => {
    const cx = w.box.x + w.box.w / 2, cy = w.box.y + w.box.h / 2;
    return cx >= region.x && cx <= region.x + region.w && cy >= region.y && cy <= region.y + region.h && w.text.trim().length > 0;
  });
  if (inside.length < 2) return { fields: [], anchors: [] };
  const heights = inside.map((w) => w.box.h).sort((a, b) => a - b);
  const lineH = heights[Math.floor(heights.length / 2)];
  // lines: words whose centres sit within a word's height of each other
  const lines: Word[][] = [];
  for (const w of [...inside].sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2))) {
    const cy = w.box.y + w.box.h / 2;
    const line = lines.find((l) => Math.abs(l[0].box.y + l[0].box.h / 2 - cy) < lineH * 0.7);
    if (line) line.push(w); else lines.push([w]);
  }
  const union = (ws: Word[]): Box => {
    const x0 = Math.min(...ws.map((w) => w.box.x)), y0 = Math.min(...ws.map((w) => w.box.y));
    const x1 = Math.max(...ws.map((w) => w.box.x + w.box.w)), y1 = Math.max(...ws.map((w) => w.box.y + w.box.h));
    return { x: x0 - 0.003, y: y0 - 0.003, w: x1 - x0 + 0.006, h: y1 - y0 + 0.006 };
  };
  const fields: OcrField[] = [];
  const anchors: OcrAnchor[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.box.x - b.box.x);
    // columns: cut where the gap to the next word is a wide one, but never right after a label's colon,
    // since a label and its value can sit far apart on a form
    const columns: Word[][] = [[line[0]]];
    for (let i = 1; i < line.length; i++) {
      const prev = line[i - 1], gap = line[i].box.x - (prev.box.x + prev.box.w);
      if (gap > 0.12 && !/[:：]$/.test(prev.text)) columns.push([line[i]]); else columns[columns.length - 1].push(line[i]);
    }
    for (const col of columns) {
      // the label ends at the last word with a colon; failing that, at the widest gap if it is a real one
      let cut = -1;
      for (let i = 0; i < col.length - 1; i++) if (/[:：]$/.test(col[i].text)) cut = i;
      if (cut < 0) {
        let widest = 0;
        for (let i = 0; i < col.length - 1; i++) {
          const gap = col[i + 1].box.x - (col[i].box.x + col[i].box.w);
          if (gap > widest) { widest = gap; cut = i; }
        }
        if (widest < 0.015) cut = -1;
      }
      if (cut < 0 || cut === col.length - 1) continue;   // no label and value pair here
      const label = col.slice(0, cut + 1), value = col.slice(cut + 1);
      const name = label.map((w) => w.text).join(" ").replace(/[:：\s]+$/, "").trim();
      const text = value.map((w) => w.text).join(" ");
      if (!name) continue;
      fields.push({ name, type: kindOf(text), page, box: union(value) });
      const first = label.find((w) => w.text.replace(/[^a-z0-9]/gi, "").length >= 3) ?? label[0];
      anchors.push({ text: first.text.replace(/[:：.,;]+$/, ""), page, box: first.box });
    }
  }
  return { fields, anchors };
}

export function OcrView() {
  const router = useRouter();
  const [seeding, setSeeding] = useState(false);
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [templates, setTemplates] = useState<OcrTemplate[] | null>(null);
  const [mode, setMode] = useState<"read" | "teach">("read");
  const [busy, setBusy] = useState<"save" | "run" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // The form in hand: its name, the boxes to read and the printed words it is found by.
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [name, setName] = useState("New form");
  const [fields, setFields] = useState<OcrField[]>([]);
  const [anchors, setAnchors] = useState<OcrAnchor[]>([]);

  // Teaching: the clean copy, its page and its printed words.
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [srcPages, setSrcPages] = useState<Page[]>([]);
  const [srcLoading, setSrcLoading] = useState(false);
  const [srcPage, setSrcPage] = useState(1);
  const [words, setWords] = useState<Word[] | null>(null);
  const [drawing, setDrawing] = useState<"field" | "anchor">("field");
  const [advanced, setAdvanced] = useState(false);
  const [fresh, setFresh] = useState<number | null>(null);   // the box just drawn, whose name takes the focus
  const [found, setFound] = useState<string[] | null>(null); // the values the last box split into, to say so
  const [anchorDraft, setAnchorDraft] = useState<{ box: Box; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reading: the scans ticked, what was read off each, and the one whose page is shown.
  const [scans, setScans] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, RunResult | { error: string }>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [shownPages, setShownPages] = useState<Record<string, Page[]>>({});
  const [fallback, setFallback] = useState(true);

  const loadTemplates = useCallback(async () => {
    try { const r = await api<{ templates: OcrTemplate[] }>("/api/ocr/templates"); setTemplates(r.templates); return r.templates; }
    catch { setTemplates([]); return [] as OcrTemplate[]; }
  }, []);

  useEffect(() => {
    api<{ documents: Document[] }>("/api/documents").then((r) => {
      const ready = r.documents.filter((d) => d.status === "ready");
      setDocs(ready);
      setSrcDoc(ready.find((d) => d.sample_key === "pharmacy-bill-1")?.id ?? ready[0]?.id ?? null);
      const scan = ready.find((d) => d.sample_key === "pharmacy-bill-3-scan");
      if (scan) setScans(new Set([scan.id]));
    }).catch(() => setDocs([]));
    loadTemplates().then((ts) => {
      const t = ts[0];
      if (t) { setTemplateId(t.id); setName(t.name); setFields(t.fields); setAnchors(t.anchors); }
      else setMode("teach");
    });
  }, [loadTemplates]);
  useEffect(() => { if (srcDoc) { setSrcLoading(true); api<{ pages: Page[] }>(`/api/documents/${srcDoc}`).then((r) => { setSrcPages(r.pages); setSrcPage(1); }).finally(() => setSrcLoading(false)); } }, [srcDoc]);
  // The page of the scan being shown, fetched once per scan.
  useEffect(() => {
    if (!shown || shownPages[shown]) return;
    api<{ pages: Page[] }>(`/api/documents/${shown}`).then((r) => setShownPages((m) => ({ ...m, [shown]: r.pages }))).catch(() => {});
  }, [shown, shownPages]);
  // The printed words of the clean copy, read once per page while teaching, so a box can take the label beside it.
  useEffect(() => {
    if (mode !== "teach" || !srcDoc) return;
    let gone = false;
    setWords(null);
    api<{ words: Word[] }>("/api/ocr/words", { method: "POST", body: JSON.stringify({ document_id: srcDoc, page_number: srcPage }) })
      .then((r) => { if (!gone) setWords(r.words); })
      .catch(() => { if (!gone) setWords([]); });
    return () => { gone = true; };
  }, [mode, srcDoc, srcPage]);

  function pick(t: OcrTemplate) {
    setTemplateId(t.id); setName(t.name); setFields(t.fields); setAnchors(t.anchors); setResults({}); setShown(null);
    if (t.document_id && docs?.some((d) => d.id === t.document_id)) setSrcDoc(t.document_id);
  }
  function teach(from?: OcrTemplate) {
    if (from) pick(from);
    else { setTemplateId(null); setName("New form"); setFields([]); setAnchors([]); }
    setResults({}); setShown(null); setAdvanced(false); setDrawing("field"); setFresh(null); setFound(null); setErr(null); setMode("teach");
  }
  function backToReading() {
    const t = templates?.find((x) => x.id === templateId) ?? templates?.[0];
    if (t) pick(t);
    setErr(null); setMode("read");
  }

  function onDraw(box: Box) {
    if (box.w < 0.005 || box.h < 0.004) return;
    if (drawing === "anchor") {
      const inside = (words ?? []).filter((w) => w.box.x >= box.x - 0.005 && w.box.y >= box.y - 0.005 && w.box.x + w.box.w <= box.x + box.w + 0.005 && w.box.y + w.box.h <= box.y + box.h + 0.005);
      const text = inside.map((w) => w.text).join(" ");
      if (text) setAnchors([...anchors, { text, page: srcPage, box }]);
      else setAnchorDraft({ box, text: "" });
      return;
    }
    const known = (b: Box) => anchors.some((a) => a.page === srcPage && Math.abs(a.box.x - b.x) < 0.01 && Math.abs(a.box.y - b.y) < 0.01);
    // A box over a block of "label: value" lines splits into one field per line, named and typed from the print.
    const split = splitRegion(box, words ?? [], srcPage);
    if (split.fields.length > 0) {
      setFields([...fields, ...split.fields]);
      setAnchors([...anchors, ...split.anchors.filter((a, i, all) => !known(a.box) && all.findIndex((b) => b.text === a.text) === i)]);
      setFresh(null);
      setFound(split.fields.map((f) => f.name));
      return;
    }
    // A box over one value: a field to name, and the label printed beside it as the word the form is found by.
    setFields([...fields, { name: "", type: "text", page: srcPage, box }]);
    setFresh(fields.length);
    setFound(null);
    const label = labelBeside(box, words ?? []);
    if (label && !known(label.box)) setAnchors([...anchors, { text: label.text.replace(/[:：.,;]+$/, ""), page: srcPage, box: label.box }]);
  }

  async function save() {
    const named = fields.map((f, i) => ({ ...f, name: f.name.trim() || `Value ${i + 1}` }));
    if (!named.length) { setErr("Draw a box around at least one value first."); return; }
    setBusy("save"); setErr(null);
    try {
      if (templateId) await api(`/api/ocr/templates/${templateId}`, { method: "DELETE" });   // the saved form is replaced, never duplicated
      const r = await api<{ template: OcrTemplate }>("/api/ocr/templates", { method: "POST", body: JSON.stringify({ name: name.trim() || "New form", document_id: srcDoc, fields: named, anchors }) });
      setFields(named);
      await loadTemplates();
      setTemplateId(r.template.id);
      setMode("read");
    } catch (e) { setErr(String(e)); } finally { setBusy(null); }
  }

  /** Read every ticked scan with the form, two at a time, filling the table as each one lands. */
  /** Forget the form being edited, then read with whichever form is left. */
  async function remove() {
    if (!templateId) return;
    setBusy("save"); setErr(null);
    try {
      await api(`/api/ocr/templates/${templateId}`, { method: "DELETE" });
      const ts = await loadTemplates();
      setTemplateId(null); setFields([]); setAnchors([]); setName("New form");
      if (ts[0]) { pick(ts[0]); setMode("read"); }
    } catch (e) { setErr(String(e)); } finally { setBusy(null); setConfirmDelete(false); }
  }

  async function run() {
    if (!fields.length) { setErr("Pick a form first, or teach a new one."); return; }
    const ids = [...scans];
    if (!ids.length) { setErr("Tick at least one scan to read."); return; }
    setBusy("run"); setErr(null); setResults({}); setShown(null); setProgress({ done: 0, total: ids.length });
    const queue = [...ids];
    let done = 0;
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          const r = await api<{ result: RunResult }>("/api/ocr/run", { method: "POST", body: JSON.stringify({ document_id: id, page_number: 1, template: { name, fields, anchors }, template_id: templateId, fallback, save: true }) });
          setResults((m) => ({ ...m, [id]: r.result }));
        } catch (e) { setResults((m) => ({ ...m, [id]: { error: String(e) } })); }
        done += 1; setProgress({ done, total: ids.length });
      }
    };
    await Promise.all([worker(), worker()]);
    setShown(ids[0]); setBusy(null); setProgress(null);
  }

  /** The table as a CSV file: one row per scan, one column per value, then how many passed their check. */
  function downloadCsv() {
    const ids = [...scans].filter((id) => results[id]);
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["Scan", ...fields.map((f) => f.name), "Checks passed"];
    const rows = ids.map((id) => {
      const r = results[id];
      const doc = docs?.find((d) => d.id === id);
      if ("error" in r) return [cell(doc ? docName(doc) : id), ...fields.map(() => cell("")), cell(`failed: ${r.error}`)];
      return [cell(doc ? docName(doc) : id), ...fields.map((f) => cell(r.fields.find((x) => x.name === f.name)?.value)), cell(`${r.fields.filter((x) => x.valid).length} of ${r.fields.length}`)];
    });
    const csv = [head.map(cell).join(","), ...rows.map((r) => r.join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "form"}-values.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** Start every sample processing and go to Documents, where the progress shows. */
  async function loadSamples() {
    setSeeding(true); setErr(null);
    try { await api("/api/samples", { method: "POST", body: JSON.stringify({ keys: SAMPLES.map((s) => s.key) }) }); router.push("/"); }
    catch (e) { setErr(String(e)); setSeeding(false); }
  }

  const current = templates?.find((t) => t.id === templateId) ?? null;
  const header = (
    <PageHeader size="sm">
      <PageHeaderRow>
        <PageHeaderContent>
          <PageHeaderTitle>Forms</PageHeaderTitle>
          <PageHeaderDescription>Teach it a form once, then read every scan of that form.</PageHeaderDescription>
        </PageHeaderContent>
        {mode === "read" && docs && docs.length > 0 && (
          <PageHeaderActions>
            <Button variant="secondary" onClick={() => teach()}>Teach a new form</Button>
          </PageHeaderActions>
        )}
      </PageHeaderRow>
    </PageHeader>
  );
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

  const docItems = (docs ?? []).map((d) => ({ value: d.id, label: docName(d) }));
  const scanDocs = (docs ?? []).filter((d) => d.id !== (current?.document_id ?? srcDoc));   // the clean copy itself is not a scan of itself
  const readIds = [...scans].filter((id) => results[id]);
  const shownResult = shown && results[shown] && !("error" in results[shown]) ? (results[shown] as RunResult) : null;
  const shownDoc = shown ? docs?.find((d) => d.id === shown) ?? null : null;
  const shownPage = shown ? shownPages[shown]?.find((p) => p.page_number === 1) ?? null : null;
  const tplItems = (templates ?? []).map((t) => ({ value: t.id, label: `${t.name} (${plural(t.fields.length, "value")})` }));
  const sp = srcPages.find((p) => p.page_number === srcPage);

  return (
    <>
      {header}
      {err && <Alert status="fail"><AlertTitle>The last step failed</AlertTitle><AlertDescription>{err}</AlertDescription></Alert>}

      <SkeletonSwap loading={docs === null || templates === null} label="Loading forms" fallback={<Skeleton className="min-h-96" />}>
        {mode === "read" && (
          <Card>
            <CardHeader>
              <CardTitle>Read scans</CardTitle>
              <CardDescription>Pick the form, tick the scans of it, and press Read. Every scan is read the same way: the form is found on it, each value is read and checked, and the values land in one table.</CardDescription>
              {current && <CardAction><Button variant="ghost" onClick={() => teach(current)}>Edit this form</Button></CardAction>}
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4">
                <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                  <div className="flex min-w-0 flex-col gap-4">
                    <Field orientation="horizontal" className="w-auto">
                      <FieldLabel className="whitespace-nowrap">Form</FieldLabel>
                      <Select items={tplItems} value={templateId} onValueChange={(v) => { const t = templates?.find((x) => x.id === v); if (t) pick(t); }}>
                        <SelectTrigger size="sm" className="w-64"><SelectValue placeholder="Pick a form" /></SelectTrigger>
                        <SelectContent>{tplItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
                      </Select>
                    </Field>
                    <Field orientation="horizontal" className="w-auto">
                      <Checkbox checked={fallback} onCheckedChange={(c) => setFallback(!!c)} />
                      <FieldContent>
                        <FieldLabel>Ask the model when a value cannot be read</FieldLabel>
                        <FieldDescription>A value the scanner misses, or that fails its check, is read from the image by the model instead.</FieldDescription>
                      </FieldContent>
                    </Field>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button size="sm" onClick={run} pending={busy === "run"} pendingLabel="Reading" disabled={!fields.length || scans.size === 0} focusableWhenDisabled aria-describedby={fields.length && scans.size ? undefined : "run-hint"}>
                        Read {scans.size > 1 ? `${scans.size} scans` : "the scan"}
                      </Button>
                      {!fields.length && <span id="run-hint" className="type-body-sm text-text-2">Teach a form first.</span>}
                      {fields.length > 0 && scans.size === 0 && <span id="run-hint" className="type-body-sm text-text-2">Tick a scan on the right.</span>}
                      {progress && <Status status="running" live>Reading {progress.done + 1 > progress.total ? progress.total : progress.done + 1} of {progress.total}</Status>}
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="type-label text-text-2">Scans to read</p>
                      <Button variant="ghost" size="xs" onClick={() => setScans(scans.size === scanDocs.length ? new Set() : new Set(scanDocs.map((d) => d.id)))}>{scans.size === scanDocs.length ? "Tick none" : "Tick all"}</Button>
                    </div>
                    <ItemGroup className="max-h-64 overflow-y-auto">
                      <ul>
                        {scanDocs.map((d) => (
                          <li key={d.id}>
                            <Item size="dense" render={<label />}>
                              <Checkbox checked={scans.has(d.id)} onCheckedChange={(c) => setScans((cur) => { const n = new Set(cur); if (c) n.add(d.id); else n.delete(d.id); return n; })} />
                              <ItemContent>
                                <ItemTitle>{docName(d)}</ItemTitle>
                                <ItemDescription>{plural(d.page_count ?? 1, "page")}{d.page_count && d.page_count > 1 ? ", first page read" : ""}</ItemDescription>
                              </ItemContent>
                            </Item>
                          </li>
                        ))}
                      </ul>
                    </ItemGroup>
                  </div>
                </div>

                {readIds.length > 0 && (
                  <div className="flex flex-col gap-3">
                    <Table aria-label="Values read" title="Values read" count={`${readIds.length} of ${scans.size}`}>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Scan</TableHead>
                          {fields.map((f) => <TableHead key={f.name}>{f.name}</TableHead>)}
                          <TableHead>Checks</TableHead>
                          <TableHead><span className="sr-only">Show</span></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {readIds.map((id) => {
                          const r = results[id];
                          const doc = docs?.find((d) => d.id === id);
                          const label = doc ? docName(doc) : id;
                          if ("error" in r) return (
                            <TableRow key={id}>
                              <TableCell>{label}</TableCell>
                              <TableCell colSpan={fields.length + 2}><Status status="fail">{r.error}</Status></TableCell>
                            </TableRow>
                          );
                          const ok = r.fields.filter((f) => f.valid).length;
                          return (
                            <TableRow key={id} data-selected={shown === id || undefined}>
                              <TableCell>{label}</TableCell>
                              {fields.map((f) => {
                                const v = r.fields.find((x) => x.name === f.name);
                                return <TableCell key={f.name}>{v && !v.valid ? <Status status="warn">{String(v.value ?? "") || "not read"}</Status> : String(v?.value ?? "")}</TableCell>;
                              })}
                              <TableCell><Status status={ok === r.fields.length ? "ok" : "warn"}>{ok} of {r.fields.length}</Status></TableCell>
                              <TableCell><Button variant="ghost" size="xs" onClick={() => setShown(id)} pressed={shown === id} onPressedChange={() => setShown(id)}>Show</Button></TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button variant="secondary" size="sm" onClick={downloadCsv}><Icon icon={Download} />Download as CSV</Button>
                      <span className="type-body-sm text-text-2">{"Each scan's values are saved with it, so they can be searched."}</span>
                    </div>
                    {shownResult && shownDoc && (
                      <div className="grid gap-6 lg:grid-cols-2">
                        <div className="min-w-0">
                          {!shownPage && <Skeleton className="min-h-96" />}
                          {shownPage && (
                            <div className="frame relative bg-paper select-none">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={pageUrl(shownPage)} alt={`Page 1 of ${docName(shownDoc)}`} className="block w-full" draggable={false} />
                              {shownResult.fields.map((f, i) => {
                                const failed = !f.valid;
                                return (
                                  <div key={i} className={cn(BOX, "border-2 border-strong", failed && "border-warn")} style={at(f.box_used)}>
                                    <Badge size="sm" status={failed ? "warn" : undefined} className="absolute -top-4 left-0">{f.name}</Badge>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                        <div className="flex min-w-0 flex-col gap-2">
                          <p className="type-label text-text-1">{docName(shownDoc)}</p>
                          <p className="type-body-sm text-text-2">{describe(shownResult)}</p>
                          {shownResult.fields.some((f) => f.ocr_value !== undefined || (f.raw && f.raw !== String(f.value ?? ""))) && (
                            <ul className="type-body-sm text-text-2">
                              {shownResult.fields.map((f) => f.ocr_value !== undefined
                                ? <li key={f.name}>{f.name}: the scanner read {String(f.ocr_value ?? "nothing")}, so the model read it from the image.</li>
                                : f.raw && f.raw !== String(f.value ?? "") ? <li key={f.name}>{f.name}: read as {f.raw}.</li> : null)}
                            </ul>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {mode === "teach" && (
          <Card>
            <CardHeader>
              <CardTitle>{templateId ? `Edit ${name}` : "Teach a new form"}</CardTitle>
              <CardDescription>On a clean copy of the form, drag a box around each value you want read, and name it. The printed label beside each box is remembered, so the boxes can find the form on any scan.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <Field orientation="horizontal" className="w-auto">
                    <FieldLabel className="whitespace-nowrap">Form name</FieldLabel>
                    <Input size="sm" value={name} onValueChange={setName} className="w-56" />
                  </Field>
                  <Field orientation="horizontal" className="w-auto">
                    <FieldLabel className="whitespace-nowrap">Clean copy</FieldLabel>
                    <Select items={docItems} value={srcDoc} onValueChange={(v) => setSrcDoc(v)}>
                      <SelectTrigger size="sm" className="w-64"><SelectValue placeholder="Pick a document" /></SelectTrigger>
                      <SelectContent>{docItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                  {srcPages.length > 1 && (
                    <Field orientation="horizontal" className="w-auto">
                      <FieldLabel className="whitespace-nowrap">Page</FieldLabel>
                      <Input mode="number" size="sm" min={1} max={srcPages.length} value={srcPage} onValueChange={(v) => { if (v !== null) setSrcPage(Math.max(1, v)); }} className="w-20" />
                    </Field>
                  )}
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                  <div className="min-w-0">
                    {srcLoading && <Skeleton className="min-h-96" />}
                    {!srcLoading && sp && (
                      <DrawableViewer imageUrl={pageUrl(sp)} alt={`Page ${srcPage} of the clean copy`} onDraw={onDraw}>
                        {fields.length === 0 && (
                          <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
                            <span className="well rounded-soft px-3 py-2 type-label">Drag a box around a value, or around a whole block of labelled values</span>
                          </div>
                        )}
                        {advanced && (words ?? []).map((w, i) => <div key={i} className={cn(BOX, "border border-control bg-selected")} style={at(w.box)} />)}
                        {fields.map((f, i) => f.page === srcPage && (
                          <div key={`f${i}`} className={cn(BOX, "border-2 border-strong")} style={at(f.box)}><Badge size="sm" className="absolute -top-4 left-0">{f.name || `Value ${i + 1}`}</Badge></div>
                        ))}
                        {anchors.filter((a) => a.page === srcPage).map((a, i) => (
                          <div key={`a${i}`} data-kind="key" className={cn(BOX, "border-2 border-dashed border-accent-mark")} style={at(a.box)}><Badge kind="key" size="sm" label={a.text} className="absolute -top-4 left-0" /></div>
                        ))}
                      </DrawableViewer>
                    )}
                    {!srcLoading && !sp && <p className="type-body-sm text-text-2">This document has no rendered page yet. Process it on the Documents page first.</p>}
                  </div>

                  <div className="flex min-w-0 flex-col gap-4">
                    {fields.length === 0 ? (
                      <Empty variant="plain">
                        <EmptyHeader>
                          <EmptyTitle>Nothing marked yet</EmptyTitle>
                          <EmptyDescription>Drag on the page around a value, such as the invoice number. It appears here to be named.</EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <p className="type-label text-text-2">Values to read</p>
                        {found && found.length > 0 && <Status status="ok">{plural(found.length, "value")} found in that box: {found.join(", ")}</Status>}
                        {fields.map((f, i) => (
                          <div key={i} className="flex flex-wrap items-center gap-2">
                            <Input size="sm" aria-label={`Name of value ${i + 1}`} placeholder={`Value ${i + 1}, e.g. Invoice number`} value={f.name} onValueChange={(v) => setFields(fields.map((x, j) => (j === i ? { ...x, name: v } : x)))} autoFocus={fresh === i} className="min-w-48 flex-1" />
                            <Select items={FIELD_TYPES} value={f.type} onValueChange={(v) => { if (v) setFields(fields.map((x, j) => (j === i ? { ...x, type: v as OcrField["type"] } : x))); }}>
                              <SelectTrigger size="sm" aria-label={`Kind of value ${i + 1}`} className="w-36"><SelectValue /></SelectTrigger>
                              <SelectContent>{FIELD_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
                            </Select>
                            <Button variant="ghost" size="icon-xs" aria-label={`Remove value ${i + 1}`} onClick={() => setFields(fields.filter((_, j) => j !== i))}><Icon icon={Close} /></Button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex flex-col gap-2">
                      <p className="type-body-sm text-text-2">
                        {anchors.length
                          ? `The form is found on a scan by these printed words: ${anchors.map((a) => a.text).join(", ")}.`
                          : words === null && mode === "teach" ? "Reading the printed words on this page." : "No printed word remembered yet. One is taken from beside each box you draw."}
                      </p>
                      <div><Button variant="ghost" size="xs" onClick={() => setAdvanced((v) => !v)}>{advanced ? "Hide the word tools" : "Change the words"}</Button></div>
                      {advanced && (
                        <div className="flex flex-col gap-2">
                          <div className="flex flex-wrap items-center gap-3">
                            <span className="type-label text-text-1">Each box I draw is a</span>
                            <ButtonGroup aria-label="What a drawn box becomes">
                              <Button variant="secondary" size="sm" pressed={drawing === "field"} onPressedChange={() => setDrawing("field")}>Value to read</Button>
                              <Button variant="secondary" size="sm" pressed={drawing === "anchor"} onPressedChange={() => setDrawing("anchor")}>Printed word</Button>
                            </ButtonGroup>
                          </div>
                          {anchors.map((a, i) => (
                            <div key={i} className="flex flex-wrap items-center gap-2">
                              <Badge kind="key" />
                              <Input size="sm" aria-label={`Printed word ${i + 1}`} value={a.text} onValueChange={(v) => setAnchors(anchors.map((x, j) => (j === i ? { ...x, text: v } : x)))} className="w-48" />
                              <span className="type-body-sm text-text-2">Page {a.page}</span>
                              <Button variant="ghost" size="icon-xs" aria-label={`Forget the word ${a.text}`} onClick={() => setAnchors(anchors.filter((_, j) => j !== i))}><Icon icon={Close} /></Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" onClick={save} pending={busy === "save"} pendingLabel="Saving" disabled={!fields.length} focusableWhenDisabled aria-describedby={fields.length ? undefined : "save-hint"}>Save the form</Button>
                      {templates && templates.length > 0 && <Button variant="ghost" size="sm" onClick={backToReading}>Cancel</Button>}
                      {templateId && <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>Delete this form</Button>}
                      {!fields.length && <span id="save-hint" className="type-body-sm text-text-2">Draw a box first.</span>}
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </SkeletonSwap>

      <Dialog role="alertdialog" open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>Its boxes and words are gone for good. Values already read from scans stay with those scans.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose>Keep the form</DialogClose>
            <DialogAction variant="destructive" pendingLabel="Deleting" onAction={remove}>Delete the form</DialogAction>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={anchorDraft !== null} onOpenChange={(open) => { if (!open) setAnchorDraft(null); }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Which word is printed there?</DialogTitle>
            <DialogDescription>No printed word was read inside that box. Type the word printed there; the form is found on each scan by it.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field>
              <FieldLabel>Printed word</FieldLabel>
              <Input value={anchorDraft?.text ?? ""} onValueChange={(v) => setAnchorDraft((d) => (d ? { ...d, text: v } : d))} placeholder="For example INVOICE" data-autofocus />
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose>Cancel</DialogClose>
            <DialogAction disabled={!anchorDraft?.text.trim()} onAction={() => { if (anchorDraft?.text.trim()) setAnchors([...anchors, { text: anchorDraft.text.trim(), page: srcPage, box: anchorDraft.box }]); setAnchorDraft(null); }}>Add the word</DialogAction>
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
