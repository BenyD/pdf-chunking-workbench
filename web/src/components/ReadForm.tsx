"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Download, Icon } from "@/components/quartz/icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/quartz/ui/alert";
import { Badge } from "@/components/quartz/ui/badge";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/quartz/ui/breadcrumb";
import { Button } from "@/components/quartz/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardMeta, CardTitle } from "@/components/quartz/ui/card";
import { Checkbox } from "@/components/quartz/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/quartz/ui/empty-state";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/quartz/ui/field";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemStatus, ItemTitle } from "@/components/quartz/ui/item";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderRow, PageHeaderTitle } from "@/components/quartz/ui/page-header";
import { Skeleton, SkeletonSwap } from "@/components/quartz/ui/skeleton";
import { Status } from "@/components/quartz/ui/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/quartz/ui/table";
import { cn } from "@/lib/quartz/utils";
import { at, BOX, describe, docName, pageUrl, plural, readScan, type RunResult } from "@/lib/forms";
import type { Document, OcrTemplate, Page } from "@/lib/types";
import { api } from "@/lib/ui";

type Outcome = RunResult | { error: string };

/** Read any number of scans with one saved form: tick them, read them, review the table, download it. */
export function ReadForm() {
  const { id } = useParams<{ id: string }>();
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [form, setForm] = useState<OcrTemplate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scans, setScans] = useState<Set<string>>(new Set());
  const [fallback, setFallback] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<Record<string, Outcome>>({});
  const [shown, setShown] = useState<string | null>(null);
  const [pages, setPages] = useState<Record<string, Page[]>>({});

  useEffect(() => {
    api<{ documents: Document[] }>("/api/documents").then((r) => {
      const ready = r.documents.filter((d) => d.status === "ready");
      setDocs(ready);
      const scan = ready.find((d) => d.sample_key === "pharmacy-bill-3-scan");
      if (scan) setScans(new Set([scan.id]));
    }).catch(() => setDocs([]));
    api<{ template: OcrTemplate }>(`/api/ocr/templates/${id}`).then((r) => setForm(r.template)).catch((e) => setErr(String(e)));
  }, [id]);
  useEffect(() => {
    if (!shown || pages[shown]) return;
    api<{ pages: Page[] }>(`/api/documents/${shown}`).then((r) => setPages((m) => ({ ...m, [shown]: r.pages }))).catch(() => {});
  }, [shown, pages]);

  /** Read every ticked scan, two at a time, filling the table as each lands. */
  async function run() {
    if (!form) return;
    const ids = [...scans];
    if (!ids.length) { setErr("Tick at least one scan."); return; }
    setBusy(true); setErr(null); setResults({}); setShown(null); setProgress({ done: 0, total: ids.length });
    const queue = [...ids];
    let done = 0;
    const worker = async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        try { const r = await readScan(d, 1, form, form.id, fallback); setResults((m) => ({ ...m, [d]: r })); }
        catch (e) { setResults((m) => ({ ...m, [d]: { error: String(e) } })); }
        done += 1; setProgress({ done, total: ids.length });
      }
    };
    await Promise.all([worker(), worker()]);
    setShown(ids[0]); setBusy(false); setProgress(null);
    setForm((f) => (f ? { ...f, runs: (f.runs ?? 0) + ids.length } : f));
  }

  /** The table as a CSV file: one row per scan, one column per value, then how many passed their check. */
  function downloadCsv() {
    if (!form) return;
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["Scan", ...form.fields.map((f) => f.name), "Checks passed"];
    const rows = readIds.map((d) => {
      const r = results[d];
      const doc = docs?.find((x) => x.id === d);
      const label = cell(doc ? docName(doc) : d);
      if ("error" in r) return [label, ...form.fields.map(() => cell("")), cell(`failed: ${r.error}`)];
      return [label, ...form.fields.map((f) => cell(r.fields.find((x) => x.name === f.name)?.value)), cell(`${r.fields.filter((x) => x.valid).length} of ${r.fields.length}`)];
    });
    const csv = [head.map(cell).join(","), ...rows.map((r) => r.join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${form.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "form"}-values.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const copy = form?.document_id ? docs?.find((d) => d.id === form.document_id) ?? null : null;
  const scanDocs = (docs ?? []).filter((d) => d.id !== form?.document_id);
  const readIds = [...scans].filter((d) => results[d]);
  const shownResult = shown && results[shown] && !("error" in results[shown]) ? (results[shown] as RunResult) : null;
  const shownDoc = shown ? docs?.find((d) => d.id === shown) ?? null : null;
  const shownPage = shown ? pages[shown]?.find((p) => p.page_number === 1) ?? null : null;
  const toCheck = (r: RunResult) => r.fields.filter((f) => !f.valid).length;

  return (
    <>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink render={<Link href="/forms" />}>Forms</BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>{form?.name ?? "Form"}</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      {err && <Alert status="fail"><AlertTitle>The last step failed</AlertTitle><AlertDescription>{err}</AlertDescription></Alert>}
      <SkeletonSwap loading={docs === null || form === null} label="Loading the form" className="flex flex-col gap-6" fallback={<Skeleton className="min-h-96" />}>
        {form && (
          <>
            <PageHeader size="sm">
              <PageHeaderRow>
                <PageHeaderContent>
                  <PageHeaderTitle>{form.name}</PageHeaderTitle>
                  <PageHeaderDescription>
                    {plural(form.fields.length, "value")}: {form.fields.map((f) => f.name).join(", ")}.{copy ? ` Taught on ${docName(copy)}.` : ""}{form.runs ? ` ${plural(form.runs, "scan")} read so far.` : ""}
                  </PageHeaderDescription>
                </PageHeaderContent>
                <PageHeaderActions>
                  <Button variant="secondary" nativeButton={false} render={<Link href={`/forms/${form.id}/edit`} />}>Edit the form</Button>
                </PageHeaderActions>
              </PageHeaderRow>
            </PageHeader>

            <Card>
              <CardHeader>
                <CardTitle>Read scans</CardTitle>
                <CardDescription>Tick the scans of this form and press Read. Every scan is read the same way: the form is found on it, each value is read and checked, and the values land in one table.</CardDescription>
                <CardAction>
                  <Button variant="ghost" onClick={() => setScans(scans.size === scanDocs.length ? new Set() : new Set(scanDocs.map((d) => d.id)))}>{scans.size === scanDocs.length ? "Tick none" : "Tick all"}</Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-4">
                  {scanDocs.length === 0 && (
                    <Empty variant="plain">
                      <EmptyHeader>
                        <EmptyTitle>No scan to read</EmptyTitle>
                        <EmptyDescription>Upload scans of this form on the Documents page; they appear here once read.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )}
                  {scanDocs.length > 0 && (
                    <ItemGroup>
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
                  )}
                  <Field orientation="horizontal" className="w-auto">
                    <Checkbox checked={fallback} onCheckedChange={(c) => setFallback(!!c)} />
                    <FieldContent>
                      <FieldLabel>Ask the model when a value cannot be read</FieldLabel>
                      <FieldDescription>A value the scanner misses, or that fails its check, is read from the image by the model instead.</FieldDescription>
                    </FieldContent>
                  </Field>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button size="sm" onClick={run} pending={busy} pendingLabel="Reading" disabled={scans.size === 0} focusableWhenDisabled aria-describedby={scans.size ? undefined : "run-hint"}>
                      Read {scans.size > 1 ? `${scans.size} scans` : "the scan"}
                    </Button>
                    {scans.size === 0 && <span id="run-hint" className="type-body-sm text-text-2">Tick a scan first.</span>}
                    {progress && <Status status="running" live>Reading {Math.min(progress.done + 1, progress.total)} of {progress.total}</Status>}
                  </div>
                </div>
              </CardContent>
            </Card>

            {readIds.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Values read</CardTitle>
                  <CardMeta>{readIds.length} of {scans.size}</CardMeta>
                  <CardAction><Button variant="ghost" onClick={downloadCsv}><Icon icon={Download} />Download as CSV</Button></CardAction>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-4">
                    <Table aria-label="Values read">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Scan</TableHead>
                          {form.fields.map((f) => <TableHead key={f.name}>{f.name}</TableHead>)}
                          <TableHead>Checks</TableHead>
                          <TableHead><span className="sr-only">Show</span></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {readIds.map((d) => {
                          const r = results[d];
                          const doc = docs?.find((x) => x.id === d);
                          const label = doc ? docName(doc) : d;
                          if ("error" in r) return (
                            <TableRow key={d}>
                              <TableCell>{label}</TableCell>
                              <TableCell colSpan={form.fields.length + 2}><Status status="fail">{r.error}</Status></TableCell>
                            </TableRow>
                          );
                          const bad = toCheck(r);
                          return (
                            <TableRow key={d} data-selected={shown === d || undefined}>
                              <TableCell>{label}</TableCell>
                              {form.fields.map((f) => {
                                const v = r.fields.find((x) => x.name === f.name);
                                return <TableCell key={f.name}>{v && !v.valid ? <Status status="warn">{String(v.value ?? "") || "not read"}</Status> : String(v?.value ?? "")}</TableCell>;
                              })}
                              <TableCell><Status status={bad ? "warn" : "ok"}>{bad ? `${bad} to check` : "All checked"}</Status></TableCell>
                              <TableCell><Button variant="ghost" size="xs" pressed={shown === d} onPressedChange={() => setShown(d)}>Show</Button></TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    <p className="type-body-sm text-text-2">{"Each scan's values are saved with it, so they can be searched. A value marked to check failed its kind or came back with low confidence; the scan shows where it was read."}</p>

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
                        <div className="flex min-w-0 flex-col gap-3">
                          <p className="type-label text-text-1">{docName(shownDoc)}</p>
                          <ItemGroup>
                            <ul>
                              {shownResult.fields.map((f) => (
                                <li key={f.name}>
                                  <Item size="dense">
                                    <ItemContent>
                                      <ItemTitle>{f.name}</ItemTitle>
                                      <ItemDescription>{String(f.value ?? "") || "Nothing could be read"}{f.ocr_value !== undefined ? ` (the scanner read ${String(f.ocr_value ?? "nothing")}; the model read it from the image)` : f.raw && f.raw !== String(f.value ?? "") ? ` (read as ${f.raw})` : ""}</ItemDescription>
                                    </ItemContent>
                                    <ItemStatus status={f.valid ? "ok" : "warn"}>{f.valid ? "Checked" : f.note || "Check it"}</ItemStatus>
                                  </Item>
                                </li>
                              ))}
                            </ul>
                          </ItemGroup>
                          <p className="type-body-sm text-text-2">{describe(shownResult)}</p>
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </SkeletonSwap>
    </>
  );
}
