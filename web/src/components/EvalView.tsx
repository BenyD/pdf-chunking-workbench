"use client";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { FileText, ListChecks, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Document, EvalQuestion, Strategy } from "@/lib/types";
import { api, STRATEGY_INFO } from "@/lib/ui";
import { StrategyChip } from "./Chips";
import { EvalSkeleton } from "./Skeletons";
import { EmptyState } from "./EmptyState";

interface RunResult {
  k: number; embedded: boolean;
  summary: { strategy: Strategy; recall_at_k: number; hits: number; total: number; mrr: number }[];
  rows: { question: string; hits: { strategy: Strategy; rank: number | null; top: { page_start: number; chunk_type: string; snippet: string }[] }[] }[];
}

export function EvalView() {
  const sp = useSearchParams();
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [docId, setDocId] = useState<string | null>(sp.get("document_id"));
  const [questions, setQuestions] = useState<EvalQuestion[]>([]);
  const [k, setK] = useState(5);
  const [draft, setDraft] = useState({ question: "", must_contain: "", expected_page: "" });
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ documents: Document[] }>("/api/documents").then((r) => {
      const ready = r.documents.filter((d) => d.status === "ready");
      setDocs(ready);
      setDocId((cur) => cur ?? ready[0]?.id ?? null);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!docId) return;
    api<{ questions: EvalQuestion[] }>(`/api/eval/questions?document_id=${docId}`).then((r) => setQuestions(r.questions)).catch(() => {});
    setResult(null);
  }, [docId]);

  async function reload() { if (docId) setQuestions((await api<{ questions: EvalQuestion[] }>(`/api/eval/questions?document_id=${docId}`)).questions); }
  async function add() {
    if (!draft.question.trim() || !docId) return;
    await api("/api/eval/questions", { method: "POST", body: JSON.stringify({ document_id: docId, question: draft.question, must_contain: draft.must_contain || null, expected_page: draft.expected_page ? Number(draft.expected_page) : null }) });
    setDraft({ question: "", must_contain: "", expected_page: "" }); await reload();
  }
  async function remove(id: string) { await api(`/api/eval/questions/${id}`, { method: "DELETE" }); setQuestions((q) => q.filter((x) => x.id !== id)); }
  async function run() {
    setBusy(true); setErr(null);
    try { setResult(await api<RunResult>("/api/eval/run", { method: "POST", body: JSON.stringify({ document_id: docId, k }) })); }
    catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  const docItems = (docs ?? []).map((d) => ({ value: d.id, label: d.name }));

  if (docs && docs.length === 0) {
    return (
      <div className="space-y-4">
        <div><h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Evaluation</h1></div>
        <EmptyState icon={<FileText />} title="Nothing to evaluate yet" hint="Add a document, then write a few questions with the phrase a correct answer must contain.">
          <Button nativeButton={false} render={<Link href="/" />}>Go to Documents</Button>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Evaluation</h1>
        <p className="mt-1 text-sm text-muted-foreground">Recall@k for each strategy on the same questions.</p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select value={docId} onValueChange={(v) => setDocId(v as string | null)} items={docItems}>
          <SelectTrigger className="w-full sm:w-80"><SelectValue placeholder="Pick a document" /></SelectTrigger>
          <SelectContent>{docItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">k</span>
          <Input type="number" min={1} max={20} value={k} onChange={(e) => setK(Number(e.target.value))} className="w-16 text-center" />
          <Button onClick={run} disabled={busy || !questions.length}>{busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Play data-icon="inline-start" />}Run {questions.length} questions</Button>
        </div>
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      {busy && <EvalSkeleton />}

      {result && !busy && (
        <div className="grid gap-3 sm:grid-cols-3">
          {result.summary.map((s) => (
            <Card key={s.strategy} size="sm">
              <CardHeader><CardTitle><StrategyChip strategy={s.strategy} /></CardTitle></CardHeader>
              <CardContent>
                <div className="text-3xl font-semibold tracking-tight">{Math.round(s.recall_at_k * 100)}%</div>
                <div className="text-xs text-muted-foreground">recall@{result.k}, {s.hits} of {s.total} hits, MRR {s.mrr}</div>
              </CardContent>
            </Card>
          ))}
          {!result.embedded && <p className="text-xs text-amber-700 sm:col-span-3">Embedding was unavailable for this run. Ranking used full text only.</p>}
        </div>
      )}

      <Card>
        <CardHeader><CardTitle>Questions</CardTitle><CardDescription>A hit means a top result contains the expected phrase.</CardDescription></CardHeader>
        <CardContent className="px-0 sm:px-6">
          {questions.length === 0 && (
            <div className="px-6 pb-4 sm:px-0">
              <EmptyState icon={<ListChecks />} title="No questions for this document" hint="Add one below. Sample documents come with a ready-made set." className="py-8" />
            </div>
          )}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Question</TableHead><TableHead className="hidden md:table-cell">Must contain</TableHead><TableHead className="hidden lg:table-cell">Page</TableHead>
                  {result?.summary.map((s) => <TableHead key={s.strategy}>{STRATEGY_INFO[s.strategy].label}</TableHead>)}<TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {questions.map((q, i) => {
                  const row = result?.rows[i];
                  return (
                    <TableRow key={q.id} className="align-top">
                      <TableCell className="max-w-[50vw] whitespace-normal sm:max-w-sm">{q.question}<div className="mt-0.5 font-mono text-[11px] text-muted-foreground md:hidden">{q.must_contain}</div></TableCell>
                      <TableCell className="hidden max-w-xs font-mono text-xs whitespace-normal text-muted-foreground md:table-cell">{q.must_contain}</TableCell>
                      <TableCell className="hidden text-muted-foreground lg:table-cell">{q.expected_page ?? "–"}</TableCell>
                      {row?.hits.map((h) => (
                        <TableCell key={h.strategy}>
                          <Badge className={h.rank ? "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"}>{h.rank ? `#${h.rank}` : "miss"}</Badge>
                          <details className="mt-1 text-xs text-muted-foreground"><summary className="cursor-pointer">top 3</summary>{h.top.map((t, j) => <div key={j} className="mt-1 line-clamp-2 max-w-[14rem]">p.{t.page_start} {t.chunk_type}: {t.snippet}</div>)}</details>
                        </TableCell>
                      ))}
                      <TableCell className="text-right"><Button variant="ghost" size="icon-xs" className="text-destructive" onClick={() => remove(q.id)} aria-label="delete"><Trash2 /></Button></TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="bg-muted/40">
                  <TableCell><Input value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} placeholder="New question" className="h-7" /></TableCell>
                  <TableCell className="hidden md:table-cell"><Input value={draft.must_contain} onChange={(e) => setDraft({ ...draft, must_contain: e.target.value })} placeholder="phrase the right chunk contains" className="h-7" /></TableCell>
                  <TableCell className="hidden lg:table-cell"><Input value={draft.expected_page} onChange={(e) => setDraft({ ...draft, expected_page: e.target.value })} placeholder="opt." className="h-7 w-16" /></TableCell>
                  <TableCell colSpan={(result?.summary.length ?? 0) + 1} className="text-right"><Button variant="outline" size="sm" onClick={add}><Plus data-icon="inline-start" />Add</Button></TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
