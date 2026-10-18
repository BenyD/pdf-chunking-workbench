"use client";
import { useEffect, useMemo, useState } from "react";
import { PromptInput, type PromptValue } from "@/components/quartz/ai/prompt-input";
import { Response, type InlineTag } from "@/components/quartz/ai/response";
import { Alert, AlertDescription, AlertTitle } from "@/components/quartz/ui/alert";
import { Badge } from "@/components/quartz/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardMeta, CardTitle } from "@/components/quartz/ui/card";
import { ChipButton, ChipGroup } from "@/components/quartz/ui/chip";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/quartz/ui/empty-state";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemLink, ItemTitle } from "@/components/quartz/ui/item";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderRow, PageHeaderTitle } from "@/components/quartz/ui/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/quartz/ui/select";
import { SkeletonText } from "@/components/quartz/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/quartz/ui/table";
import report from "@/data/comparison.json";
import { aiEnabled } from "@/lib/flags";
import type { Document, SearchResult } from "@/lib/types";
import { api } from "@/lib/ui";
import { chunkKind, typeLabel } from "./PageViewer";

type Hit = SearchResult & { document_name?: string };
type Mode = "keywords" | "pure" | "full";
type Setup = { key: string; label: string; strategy: string; recall: number; mrr: number; tokens_read: number; questions: number; by_document: Record<string, { recall: number | null }> };
type Question = { doc: string; question: string; ranks: Record<string, number | null> };
const data = report as unknown as { date: string; k: number; questions: number; setups: Setup[]; per_question: Question[] };

/** The three ways a question is asked: keywords alone, the app as it ships, and the app with generative AI added. */
const MODES: { mode: Mode; title: string; detail: string }[] = [
  { mode: "keywords", title: "Keywords only", detail: "Passages cut by rules, found by keyword search. No model of any kind." },
  { mode: "pure", title: "The app", detail: "The same passages, plus meaning search from a small open-source model on our own server. No API call, nothing generated." },
  { mode: "full", title: "With generative AI", detail: "An option, off by default: a model writes a context line per passage, describes figures and writes the answer." },
];

/** The ways asked live. With generative AI switched off (lib/flags) its column is not asked at all, so no paid
 * service is ever called from this page; its measured numbers stay in the table below. */
const LIVE = aiEnabled ? MODES : MODES.filter((m) => m.mode !== "full");

/** Which benchmark setup each live mode corresponds to. */
const SETUP_OF: Record<Mode, string> = { keywords: "struct_kw", pure: "struct_local", full: "ctx_hyb" };

/** What each method costs in model calls when a document is indexed. */
const CALLS: Record<string, string> = {
  fixed: "Embeddings",
  semantic: "Embeddings, plus one per sentence to find the cuts",
  hierarchical: "Embeddings",
  structural: "None, or embeddings (a local model, or an API)",
  contextual: "A small model per chunk, a vision model per figure, embeddings",
};

const ALL = "all";
const pct = (x: number | null | undefined) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const docName = (h: Hit) => (h.document_name ?? "").replace(/\.pdf$/i, "");
const tags: InlineTag[] = [{ pattern: /\[(\d+)\]/, partial: /\[\d*$/, render: (m, { key }) => <Badge key={key} className="mx-0.5">{m[1]}</Badge> }];

export function CompareView() {
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const [asked, setAsked] = useState("");
  const [hits, setHits] = useState<Partial<Record<Mode, Hit[] | null>>>({});
  const [answer, setAnswer] = useState<string | null>(null);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => { api<{ documents: Document[] }>("/api/documents").then((r) => setDocs(r.documents.filter((d) => d.status === "ready"))).catch(() => setDocs([])); }, []);

  // Benchmark questions that tell the story, one per document: what meaning search adds over keywords, and what
  // only generative AI finds. Falls back to the old split when the report has no local-model setup.
  const presets = useMemo(() => {
    const order = ["Tablet press", "humira", "who-trs", "Bharatiya Nagarik", "nppa", "Pharma Price", "QC Inspection", "Bharatiya Nyaya"];
    const rank = (q: Question) => { const i = order.findIndex((o) => q.doc.startsWith(o)); return i < 0 ? order.length : i; };
    const onePerDoc = (qs: Question[], n: number) => [...qs].sort((a, b) => rank(a) - rank(b))
      .filter((q, i, all) => all.findIndex((x) => x.doc === q.doc) === i).slice(0, n);
    const app = "struct_local" in (data.per_question[0]?.ranks ?? {}) ? "struct_local" : "ctx_hyb";
    const only = onePerDoc(data.per_question.filter((q) => q.ranks.struct_kw == null && q.ranks[app] != null), 4);
    const both = onePerDoc(data.per_question.filter((q) => q.ranks[app] == null && q.ranks.ctx_hyb != null), 3);
    return { only, both };
  }, []);

  async function run(query: string, scope: string | null = docId) {
    const q = query.trim();
    if (!q) return;
    setGeneration((g) => g + 1);
    setAsked(q); setErr(null); setAnswer(null);
    setHits(Object.fromEntries(LIVE.map((m) => [m.mode, null])));
    const results = await Promise.all(LIVE.map(async ({ mode }) => {
      try {
        const r = await api<{ results: Hit[] }>("/api/search", { method: "POST", body: JSON.stringify({ query: q, document_id: scope, k: 5, mode }) });
        setHits((h) => ({ ...h, [mode]: r.results }));
        return [mode, r.results] as const;
      } catch (e) {
        setErr(String(e)); setHits((h) => ({ ...h, [mode]: [] }));
        return [mode, [] as Hit[]] as const;
      }
    }));
    const full = results.find(([m]) => m === "full")?.[1] ?? [];
    if (!aiEnabled || !full.length) return;
    setAnswerBusy(true);
    try {
      const passages = full.slice(0, 5).map((h, i) => ({ n: i + 1, text: h.raw_text, document_name: docName(h), page: h.page_start }));
      const r = await api<{ answer: string }>("/api/answer", { method: "POST", body: JSON.stringify({ query: q, passages }) });
      setAnswer(r.answer);
    } catch { setAnswer(""); } finally { setAnswerBusy(false); }
  }

  /** A benchmark question is asked within its own document, as the benchmark did. */
  function ask(q: Question) {
    const d = docs?.find((x) => x.name.replace(/\.pdf$/i, "") === q.doc);
    setDocId(d?.id ?? null);
    void run(q.question, d?.id ?? null);
  }

  const docItems = [{ value: ALL, label: "All documents" }, ...(docs ?? []).map((d) => ({ value: d.id, label: d.name.replace(/\.pdf$/i, "") }))];
  const busy = Object.values(hits).some((h) => h === null);
  const status = busy ? "submitted" : answerBusy ? "streaming" : "ready";
  const byKey = Object.fromEntries(data.setups.map((s) => [s.key, s]));
  const docsInReport = Object.keys(data.setups[0]?.by_document ?? {});
  const shown = ["fixed_hyb", "hier_hyb", "struct_kw", "struct_local", "ctx_hyb"].filter((k) => byKey[k]);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader size="sm">
        <PageHeaderRow>
          <PageHeaderContent>
            <PageHeaderTitle>Compare</PageHeaderTitle>
            <PageHeaderDescription>{aiEnabled ? "What AI would add, measured. Ask one question three ways" : "Keywords against the app, live. Ask one question both ways"}, then see how every chunking method scored on the same {data.questions} questions.</PageHeaderDescription>
          </PageHeaderContent>
        </PageHeaderRow>
      </PageHeader>
      {err && <Alert status="fail"><AlertTitle>A search failed</AlertTitle><AlertDescription>{err}</AlertDescription></Alert>}

      <section className="flex flex-col gap-4" aria-labelledby="ask-heading">
        <h2 id="ask-heading" className="type-heading-sm">{aiEnabled ? "Ask it three ways" : "Ask it two ways"}</h2>
        <PromptInput
          label="Question"
          placeholder="Ask a question"
          status={status}
          generation={generation}
          onSubmit={(v: PromptValue) => run(v.text)}
          maxLength={500}
          tools={
            <Select items={docItems} value={docId ?? ALL} onValueChange={(v) => setDocId(v === ALL || v === null ? null : v)}>
              <SelectTrigger size="sm" aria-label="Search in"><SelectValue /></SelectTrigger>
              <SelectContent>{docItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
            </Select>
          }
        />
        {(presets.only.length > 0 || (aiEnabled && presets.both.length > 0)) && (
          <div className="flex flex-col gap-3">
            {presets.only.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="type-label text-text-2">Keywords miss, the app finds</p>
                <ChipGroup aria-label="Questions keywords miss and the app finds">{presets.only.map((q) => <ChipButton key={q.question} onClick={() => ask(q)}>{q.question}</ChipButton>)}</ChipGroup>
              </div>
            )}
            {aiEnabled && presets.both.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="type-label text-text-2">Only generative AI finds</p>
                <ChipGroup aria-label="Questions only generative AI finds">{presets.both.map((q) => <ChipButton key={q.question} onClick={() => ask(q)}>{q.question}</ChipButton>)}</ChipGroup>
              </div>
            )}
          </div>
        )}

        {asked && (
          <div className={aiEnabled ? "grid gap-4 lg:grid-cols-3" : "grid gap-4 lg:grid-cols-2"}>
            {LIVE.map(({ mode, title, detail }) => {
              const list = hits[mode];
              const s = byKey[SETUP_OF[mode]];
              return (
                <Card key={mode}>
                  <CardHeader>
                    <CardTitle>{title}</CardTitle>
                    {s && <CardMeta>{pct(s.recall)} on the benchmark</CardMeta>}
                    <CardDescription>{detail}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-col gap-4">
                      {mode === "full" && (answerBusy || answer) && (
                        <div className="well rounded-soft p-3">
                          {answerBusy ? <SkeletonText type="body-sm" lines={3} /> : <Response inlineTags={tags}>{answer ?? ""}</Response>}
                        </div>
                      )}
                      {list === null || list === undefined ? (
                        <SkeletonText type="body-sm" lines={6} />
                      ) : list.length === 0 ? (
                        <Empty variant="plain" size="sm">
                          <EmptyHeader>
                            <EmptyTitle>Nothing found</EmptyTitle>
                            <EmptyDescription>No passage uses these words.</EmptyDescription>
                          </EmptyHeader>
                        </Empty>
                      ) : (
                        <ItemGroup>
                          <ul>
                            {list.map((h, i) => (
                              <li key={h.id}>
                                <Item kind={chunkKind[h.chunk_type]}>
                                  <ItemContent>
                                    <ItemTitle>
                                      <Badge>{i + 1}</Badge>
                                      <Badge kind={chunkKind[h.chunk_type]} label={typeLabel[h.chunk_type]} />
                                      <ItemLink href={`/documents/${h.document_id}?page=${h.page_start}`}>{docName(h)}, page {h.page_start}</ItemLink>
                                    </ItemTitle>
                                    <ItemDescription>{h.raw_text}</ItemDescription>
                                  </ItemContent>
                                </Item>
                              </li>
                            ))}
                          </ul>
                        </ItemGroup>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="bench-heading">
        <div className="flex flex-col gap-1">
          <h2 id="bench-heading" className="type-heading-sm">Every method on the same questions</h2>
          <p className="type-body-sm text-text-2">{data.questions} questions with a known answer across {docsInReport.length} documents, measured on {data.date}. A question counts when one of the top {data.k} passages holds the expected words, in the document&apos;s own text, on the right page. The first five rows are the standard ways to cut documents (fixed-size pieces, cuts where the topic shifts, and big pieces with small ones inside), the same ones LangChain, LlamaIndex and AWS Bedrock offer, built with their usual settings and searched with the same engine. The app is the row with the local open-source model: no API call and no generated text.</p>
        </div>
        <Table aria-label="Recall by method">
          <TableHeader>
            <TableRow>
              <TableHead>Method</TableHead>
              <TableHead>Right passage in top {data.k}</TableHead>
              <TableHead>Ranking (MRR)</TableHead>
              <TableHead>Tokens in top {data.k}</TableHead>
              <TableHead>Model calls to index</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.setups.map((s) => (
              <TableRow key={s.key}>
                <TableCell>{s.label}</TableCell>
                <TableCell className="data">{pct(s.recall)}</TableCell>
                <TableCell className="data">{s.mrr.toFixed(2)}</TableCell>
                <TableCell className="data">{s.tokens_read.toLocaleString("en-IN")}</TableCell>
                <TableCell>{s.key === "struct_kw" ? "None" : CALLS[s.strategy] ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <Table aria-label="Recall by document">
          <TableHeader>
            <TableRow>
              <TableHead>Document</TableHead>
              {shown.map((k) => <TableHead key={k}>{byKey[k].label.split(",")[0].replace(" (the app)", "")}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {docsInReport.map((dn) => (
              <TableRow key={dn}>
                <TableCell>{dn.replace(/\.pdf$/i, "")}</TableCell>
                {shown.map((k) => <TableCell key={k} className="data">{pct(byKey[k].by_document[dn]?.recall)}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
