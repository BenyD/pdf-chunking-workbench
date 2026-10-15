"use client";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Close, Icon, MagicWand } from "@/components/quartz/icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/quartz/ui/alert";
import { Badge } from "@/components/quartz/ui/badge";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/quartz/ui/breadcrumb";
import { Button } from "@/components/quartz/ui/button";
import { ButtonGroup } from "@/components/quartz/ui/button-group";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/quartz/ui/card";
import { Checkbox } from "@/components/quartz/ui/checkbox";
import { Dialog, DialogAction, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/quartz/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/quartz/ui/empty-state";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/quartz/ui/field";
import { Input } from "@/components/quartz/ui/input";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemStatus, ItemTitle } from "@/components/quartz/ui/item";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderRow, PageHeaderTitle } from "@/components/quartz/ui/page-header";
import { ProgressStep, ProgressStepDescription, ProgressStepIndicator, ProgressStepSeparator, ProgressStepText, ProgressStepTitle, ProgressStepTrigger, ProgressSteps } from "@/components/quartz/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/quartz/ui/select";
import { Skeleton, SkeletonSwap } from "@/components/quartz/ui/skeleton";
import { Status } from "@/components/quartz/ui/status";
import { cn } from "@/lib/quartz/utils";
import { at, BOX, describe, docName, FIELD_TYPES, kindLabel, labelBeside, newAnchors, pageUrl, plural, readScan, readWords, splitRegion, WHOLE_PAGE, type Box, type RunResult, type Word } from "@/lib/forms";
import type { Document, OcrAnchor, OcrField, OcrTemplate, Page } from "@/lib/types";
import { api } from "@/lib/ui";
import { DrawableViewer } from "./DrawableViewer";

/** The four steps of teaching a form, in the order a person meets them. */
const STEPS = [
  { title: "Clean copy", detail: "The form to teach from" },
  { title: "Values", detail: "What to read off it" },
  { title: "Test", detail: "Try it on a scan" },
  { title: "Save", detail: "Name it and keep it" },
];

const cleanWord = (t: string) => t.replace(/[:：.,;]+$/, "");

/** Teach a new form, or change a saved one, in four steps. The step is in the address, so the browser's back works. */
export function FormWizard() {
  const params = useParams<{ id?: string }>();
  const id = params?.id ?? null;
  const router = useRouter();
  const sp = useSearchParams();
  const [step, setStepState] = useState(() => Math.min(4, Math.max(1, Number(sp.get("step")) || 1)));
  const setStep = (n: number) => { setStepState(n); router.replace(`${id ? `/forms/${id}/edit` : "/forms/new"}?step=${n}`, { scroll: false }); window.scrollTo({ top: 0 }); };

  const [docs, setDocs] = useState<Document[] | null>(null);
  const [loaded, setLoaded] = useState(!id);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"read" | "save" | "delete" | null>(null);

  // The form: its name, the clean copy it is taught on, the boxes to read and the printed words it is found by.
  const [name, setName] = useState("New form");
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [srcPages, setSrcPages] = useState<Page[]>([]);
  const [srcPage, setSrcPage] = useState(1);
  const [fields, setFields] = useState<OcrField[]>([]);
  const [anchors, setAnchors] = useState<OcrAnchor[]>([]);
  const [words, setWords] = useState<Word[] | null>(null);
  const [drawing, setDrawing] = useState<"field" | "anchor">("field");
  const [advanced, setAdvanced] = useState(false);
  const [fresh, setFresh] = useState<number | null>(null);    // the box just drawn, whose name takes the focus
  const [found, setFound] = useState<string[] | null>(null);  // the values the last box or the finder produced
  const [anchorDraft, setAnchorDraft] = useState<{ box: Box; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The test scan and what the form read off it.
  const [tgtDoc, setTgtDoc] = useState<string | null>(null);
  const [tgtPages, setTgtPages] = useState<Page[]>([]);
  const [fallback, setFallback] = useState(true);
  const [result, setResult] = useState<RunResult | null>(null);

  useEffect(() => {
    api<{ documents: Document[] }>("/api/documents").then((r) => {
      const ready = r.documents.filter((d) => d.status === "ready");
      setDocs(ready);
      setSrcDoc((cur) => cur ?? ready.find((d) => d.sample_key === "pharmacy-bill-1")?.id ?? ready[0]?.id ?? null);
      setTgtDoc((cur) => cur ?? ready.find((d) => d.sample_key === "pharmacy-bill-3-scan")?.id ?? null);
    }).catch(() => setDocs([]));
    if (id) {
      api<{ template: OcrTemplate }>(`/api/ocr/templates/${id}`).then((r) => {
        const t = r.template;
        setName(t.name); setFields(t.fields); setAnchors(t.anchors);
        if (t.document_id) setSrcDoc(t.document_id);
        setLoaded(true);
      }).catch((e) => setErr(String(e)));
    }
  }, [id]);
  useEffect(() => { if (srcDoc) api<{ pages: Page[] }>(`/api/documents/${srcDoc}`).then((r) => { setSrcPages(r.pages); setSrcPage(1); }).catch(() => setSrcPages([])); }, [srcDoc]);
  useEffect(() => { if (tgtDoc) api<{ pages: Page[] }>(`/api/documents/${tgtDoc}`).then((r) => { setTgtPages(r.pages); setResult(null); }).catch(() => setTgtPages([])); }, [tgtDoc]);
  // The printed words of the clean copy's page, read once, so boxes can be named and found by them.
  useEffect(() => {
    if (!srcDoc) return;
    let gone = false;
    setWords(null);
    readWords(srcDoc, srcPage).then((w) => { if (!gone) setWords(w); }).catch(() => { if (!gone) setWords([]); });
    return () => { gone = true; };
  }, [srcDoc, srcPage]);

  const sp1 = srcPages.find((p) => p.page_number === srcPage) ?? null;
  const tp1 = tgtPages.find((p) => p.page_number === 1) ?? null;
  const copy = docs?.find((d) => d.id === srcDoc) ?? null;
  const scan = docs?.find((d) => d.id === tgtDoc) ?? null;
  const scanDocs = (docs ?? []).filter((d) => d.id !== srcDoc);
  const docItems = (docs ?? []).map((d) => ({ value: d.id, label: docName(d) }));
  const scanItems = scanDocs.map((d) => ({ value: d.id, label: docName(d) }));
  const onThisPage = fields.filter((f) => f.page === srcPage);

  const addFields = (add: OcrField[], addAnchors: OcrAnchor[]) => {
    const names = new Set(fields.map((f) => f.name.toLowerCase()));
    const fresh = add.filter((f) => !names.has(f.name.toLowerCase()));
    setFields([...fields, ...fresh]);
    setAnchors([...anchors, ...newAnchors(anchors, addAnchors)]);
    setFound(fresh.map((f) => f.name));
    setFresh(null);
  };

  /** Every "label: value" line on the page becomes a field. */
  function findAll() {
    if (!words) return;
    const split = splitRegion(WHOLE_PAGE, words, srcPage, { colonOnly: true });
    if (split.fields.length === 0) { setFound([]); return; }
    addFields(split.fields, split.anchors);
  }

  function onDraw(box: Box) {
    if (box.w < 0.005 || box.h < 0.004) return;
    if (drawing === "anchor") {
      const inside = (words ?? []).filter((w) => w.box.x >= box.x - 0.005 && w.box.y >= box.y - 0.005 && w.box.x + w.box.w <= box.x + box.w + 0.005 && w.box.y + w.box.h <= box.y + box.h + 0.005);
      const text = inside.map((w) => w.text).join(" ");
      if (text) setAnchors([...anchors, { text, page: srcPage, box }]); else setAnchorDraft({ box, text: "" });
      return;
    }
    const split = splitRegion(box, words ?? [], srcPage);
    if (split.fields.length > 0) { addFields(split.fields, split.anchors); return; }
    setFields([...fields, { name: "", type: "text", page: srcPage, box }]);
    setFresh(fields.length);
    setFound(null);
    const label = labelBeside(box, words ?? []);
    if (label) setAnchors([...anchors, ...newAnchors(anchors, [{ text: cleanWord(label.text), page: srcPage, box: label.box }])]);
  }

  async function test() {
    if (!tgtDoc) return;
    setBusy("read"); setErr(null); setResult(null);
    try { setResult(await readScan(tgtDoc, 1, { name, fields: named(), anchors }, id, fallback, false)); }
    catch (e) { setErr(String(e)); } finally { setBusy(null); }
  }

  const named = () => fields.map((f, i) => ({ ...f, name: f.name.trim() || `Value ${i + 1}` }));

  async function save() {
    setBusy("save"); setErr(null);
    const body = { name: name.trim() || "New form", document_id: srcDoc, fields: named(), anchors };
    try {
      if (id) { await api(`/api/ocr/templates/${id}`, { method: "PUT", body: JSON.stringify(body) }); router.push(`/forms/${id}`); }
      else { const r = await api<{ template: OcrTemplate }>("/api/ocr/templates", { method: "POST", body: JSON.stringify(body) }); router.push(`/forms/${r.template.id}`); }
    } catch (e) { setErr(String(e)); setBusy(null); }
  }

  async function remove() {
    if (!id) return;
    setBusy("delete"); setErr(null);
    try { await api(`/api/ocr/templates/${id}`, { method: "DELETE" }); router.push("/forms"); }
    catch (e) { setErr(String(e)); setBusy(null); setConfirmDelete(false); }
  }

  const canLeave = [true, !!sp1, fields.length > 0, true, true];
  const next = () => { if (canLeave[step]) setStep(step + 1); };
  const title = id ? (name || "Edit form") : "New form";

  return (
    <>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink render={<Link href="/forms" />}>Forms</BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          {id && <><BreadcrumbItem><BreadcrumbLink render={<Link href={`/forms/${id}`} />}>{name}</BreadcrumbLink></BreadcrumbItem><BreadcrumbSeparator /></>}
          <BreadcrumbItem><BreadcrumbPage>{id ? "Edit" : "New form"}</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <PageHeader size="sm">
        <PageHeaderRow>
          <PageHeaderContent>
            <PageHeaderTitle>{title}</PageHeaderTitle>
            <PageHeaderDescription>Four steps: a clean copy, the values on it, a test on a scan, and a name to save it under.</PageHeaderDescription>
          </PageHeaderContent>
        </PageHeaderRow>
      </PageHeader>
      {err && <Alert status="fail"><AlertTitle>The last step failed</AlertTitle><AlertDescription>{err}</AlertDescription></Alert>}

      <ProgressSteps value={step} onValueChange={(n) => { if (n <= step) setStep(n); }} aria-label="Teaching steps">
        {STEPS.map((s, i) => (
          <ProgressStep key={s.title} step={i + 1}>
            <ProgressStepTrigger>
              <ProgressStepIndicator />
              <ProgressStepText>
                <ProgressStepTitle>{s.title}</ProgressStepTitle>
                <ProgressStepDescription className="max-sm:hidden">{s.detail}</ProgressStepDescription>
              </ProgressStepText>
            </ProgressStepTrigger>
            <ProgressStepSeparator />
          </ProgressStep>
        ))}
      </ProgressSteps>

      <SkeletonSwap loading={docs === null || !loaded} label="Loading the form" fallback={<Skeleton className="min-h-96" />}>
        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle>Pick a clean copy of the form</CardTitle>
              <CardDescription>A straight, readable copy. Every scan of this form is read with what you mark on it in the next step.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <div className="flex min-w-0 flex-col gap-5">
                  <Field>
                    <FieldLabel>Form name</FieldLabel>
                    <Input value={name} onValueChange={setName} placeholder="Supplier invoice, batch record, delivery note" />
                    <FieldDescription>How the form is listed. One name per layout.</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel>Clean copy</FieldLabel>
                    <Select items={docItems} value={srcDoc} onValueChange={(v) => setSrcDoc(v)}>
                      <SelectTrigger><SelectValue placeholder="Pick a document" /></SelectTrigger>
                      <SelectContent>{docItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
                    </Select>
                    <FieldDescription>One of the documents already loaded. Upload a new one on the Documents page first.</FieldDescription>
                  </Field>
                  {srcPages.length > 1 && (
                    <Field>
                      <FieldLabel>Page</FieldLabel>
                      <Input mode="number" min={1} max={srcPages.length} value={srcPage} onValueChange={(v) => { if (v !== null) setSrcPage(Math.max(1, v)); }} className="w-24" />
                      <FieldDescription>The page the values sit on.</FieldDescription>
                    </Field>
                  )}
                </div>
                <div className="min-w-0">
                  {!sp1 && <Skeleton className="min-h-96" />}
                  {sp1 && (
                    <div className="frame bg-paper">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={pageUrl(sp1)} alt={`Page ${srcPage} of the clean copy`} className="block w-full" draggable={false} />
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle>Mark the values to read</CardTitle>
              <CardDescription>Let it find the labelled values on the page, or drag a box around a value, or around a whole block of them. Each value gets a name and a kind. The printed label beside each one is how the form is found on a scan.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="secondary" size="sm" onClick={findAll} disabled={!words} focusableWhenDisabled aria-describedby={words ? undefined : "find-hint"}><Icon icon={MagicWand} />Find the values for me</Button>
                  {!words && <span id="find-hint" className="type-body-sm text-text-2">Reading the printed words on the page.</span>}
                  {words && <span className="type-body-sm text-text-2">Or drag a box on the page.</span>}
                </div>
                <div className="grid gap-6 lg:grid-cols-2">
                  <div className="min-w-0">
                    {!sp1 && <Skeleton className="min-h-96" />}
                    {sp1 && (
                      <DrawableViewer imageUrl={pageUrl(sp1)} alt={`Page ${srcPage} of the clean copy`} onDraw={onDraw}>
                        {onThisPage.length === 0 && (
                          <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
                            <span className="well rounded-soft px-3 py-2 type-label">Drag a box around a value, or around a block of them</span>
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
                  </div>
                  <div className="flex min-w-0 flex-col gap-4">
                    {found && found.length === 0 && <Status status="warn">No labelled value found on this page. Drag boxes instead.</Status>}
                    {found && found.length > 0 && <Status status="ok">{plural(found.length, "value")} added: {found.join(", ")}</Status>}
                    {fields.length === 0 ? (
                      <Empty variant="plain">
                        <EmptyHeader>
                          <EmptyTitle>Nothing marked yet</EmptyTitle>
                          <EmptyDescription>Press Find the values for me, or drag on the page. Each value appears here to be named.</EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <p className="type-label text-text-2">{plural(fields.length, "value")} to read</p>
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
                        {anchors.length ? `Found on a scan by these printed words: ${anchors.map((a) => a.text).join(", ")}.` : "No printed word remembered yet. One is taken from beside each value."}
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
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 3 && (
          <Card>
            <CardHeader>
              <CardTitle>Test it on a scan</CardTitle>
              <CardDescription>Pick a scan of this form and read it. Every value should come back checked. If a box is off, go back and move it.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4">
                <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                  <div className="flex min-w-0 flex-col gap-5">
                    <Field>
                      <FieldLabel>Scan</FieldLabel>
                      <Select items={scanItems} value={tgtDoc} onValueChange={(v) => setTgtDoc(v)}>
                        <SelectTrigger><SelectValue placeholder="Pick a scan" /></SelectTrigger>
                        <SelectContent>{scanItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
                      </Select>
                      <FieldDescription>A scan of the same form, ideally one that is shifted or a little crooked.</FieldDescription>
                    </Field>
                    <Field orientation="horizontal" className="w-auto">
                      <Checkbox checked={fallback} onCheckedChange={(c) => setFallback(!!c)} />
                      <FieldContent>
                        <FieldLabel>Ask the model when a value cannot be read</FieldLabel>
                        <FieldDescription>A value the scanner misses, or that fails its check, is read from the image by the model.</FieldDescription>
                      </FieldContent>
                    </Field>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button variant="secondary" size="sm" onClick={test} pending={busy === "read"} pendingLabel="Reading" disabled={!tgtDoc}>Read this scan</Button>
                      {busy === "read" && <Status status="running" live>Finding the form and reading each box</Status>}
                    </div>
                    {result && (
                      <>
                        <ItemGroup>
                          <ul>
                            {result.fields.map((f) => (
                              <li key={f.name}>
                                <Item size="dense">
                                  <ItemContent>
                                    <ItemTitle>{f.name}</ItemTitle>
                                    <ItemDescription>{String(f.value ?? "") || "Nothing could be read"}</ItemDescription>
                                  </ItemContent>
                                  <ItemStatus status={f.valid ? "ok" : "warn"}>{f.valid ? "Checked" : f.note || "Check it"}</ItemStatus>
                                </Item>
                              </li>
                            ))}
                          </ul>
                        </ItemGroup>
                        <p className="type-body-sm text-text-2">{describe(result)}</p>
                      </>
                    )}
                  </div>
                  <div className="min-w-0">
                    {!tp1 && <Skeleton className="min-h-96" />}
                    {tp1 && (
                      <div className="frame relative bg-paper select-none">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={pageUrl(tp1)} alt={`Page 1 of ${scan ? docName(scan) : "the scan"}`} className="block w-full" draggable={false} />
                        {(result ? result.fields.map((f) => ({ box: f.box_used, label: f.name, failed: !f.valid })) : named().filter((f) => f.page === 1).map((f) => ({ box: f.box, label: f.name, failed: false }))).map((b, i) => (
                          <div key={i} className={cn(BOX, "border-2 border-strong", !result && "border-dashed", b.failed && "border-warn")} style={at(b.box)}>
                            <Badge size="sm" status={b.failed ? "warn" : undefined} className="absolute -top-4 left-0">{b.label}</Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 4 && (
          <Card>
            <CardHeader>
              <CardTitle>Save the form</CardTitle>
              <CardDescription>What will be kept. Change the name here if you like; everything else comes from the earlier steps.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex max-w-(--measure) flex-col gap-5">
                <Field>
                  <FieldLabel>Form name</FieldLabel>
                  <Input value={name} onValueChange={setName} />
                </Field>
                <ItemGroup>
                  <ul>
                    <li><Item size="dense"><ItemContent><ItemTitle>Clean copy</ItemTitle><ItemDescription>{copy ? docName(copy) : "none"}{srcPages.length > 1 ? `, page ${srcPage}` : ""}</ItemDescription></ItemContent></Item></li>
                    <li><Item size="dense"><ItemContent><ItemTitle>{plural(fields.length, "value")}</ItemTitle><ItemDescription>{named().map((f) => `${f.name} (${kindLabel(f.type).toLowerCase()})`).join(", ")}</ItemDescription></ItemContent></Item></li>
                    <li><Item size="dense"><ItemContent><ItemTitle>Found on a scan by</ItemTitle><ItemDescription>{anchors.length ? anchors.map((a) => a.text).join(", ") : "nothing yet; the boxes are used where they were drawn"}</ItemDescription></ItemContent></Item></li>
                    <li>
                      <Item size="dense">
                        <ItemContent><ItemTitle>Test</ItemTitle><ItemDescription>{result && scan ? `${result.fields.filter((f) => f.valid).length} of ${result.fields.length} values checked on ${docName(scan)}` : "Not tested yet"}</ItemDescription></ItemContent>
                        {result && <ItemStatus status={result.fields.every((f) => f.valid) ? "ok" : "warn"}>{result.fields.every((f) => f.valid) ? "All checked" : "Some to check"}</ItemStatus>}
                      </Item>
                    </li>
                  </ul>
                </ItemGroup>
              </div>
            </CardContent>
          </Card>
        )}
      </SkeletonSwap>

      {/* The step's buttons stay at the bottom of the window, so a long page never hides them. */}
      {docs !== null && loaded && (
        <div className="sticky bottom-0 z-10 -mb-6 flex w-full flex-wrap items-center justify-end gap-2 border-t border-hair bg-page py-3">
          {step === 1 && <>
            <Button variant="ghost" nativeButton={false} render={<Link href={id ? `/forms/${id}` : "/forms"} />}>Cancel</Button>
            <Button onClick={next} disabled={!canLeave[1]}>Mark the values</Button>
          </>}
          {step === 2 && <>
            {!canLeave[2] && <span id="next-hint" className="type-body-sm text-text-2">Mark at least one value first.</span>}
            <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
            <Button onClick={next} disabled={!canLeave[2]} focusableWhenDisabled aria-describedby={canLeave[2] ? undefined : "next-hint"}>Test on a scan</Button>
          </>}
          {step === 3 && <>
            <Button variant="ghost" onClick={() => setStep(2)}>Back</Button>
            <Button onClick={next}>Review and save</Button>
          </>}
          {step === 4 && <>
            {id && <Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete this form</Button>}
            <Button variant="ghost" onClick={() => setStep(3)}>Back</Button>
            <Button onClick={save} pending={busy === "save"} pendingLabel="Saving" disabled={!fields.length}>Save the form</Button>
          </>}
        </div>
      )}

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
