"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { PromptInput, type PromptValue } from "@/components/quartz/ai/prompt-input";
import { Response, type InlineTag } from "@/components/quartz/ai/response";
import { Alert, AlertDescription, AlertTitle } from "@/components/quartz/ui/alert";
import { Badge } from "@/components/quartz/ui/badge";
import { Button } from "@/components/quartz/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/quartz/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/quartz/ui/collapsible";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/quartz/ui/empty-state";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemLink, ItemTitle } from "@/components/quartz/ui/item";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderRow, PageHeaderTitle } from "@/components/quartz/ui/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/quartz/ui/select";
import { SkeletonSwap, SkeletonText } from "@/components/quartz/ui/skeleton";
import type { Chunk, Document, SearchResult } from "@/lib/types";
import { api, publicAsset } from "@/lib/ui";
import { chunkKind, PageViewer, typeLabel } from "./PageViewer";

type Hit = SearchResult & { page_image_url: string };
type Suggestion = { text: string; document_id: string; document_name: string };
const ALL = "all";
const docName = (h: Hit) => (h.document_name ?? "").replace(/\.pdf$/i, "");

/** A [n] in the answer becomes a small link to source n below it. */
const CITATIONS: InlineTag[] = [{
  pattern: /\[(\d+)\]/,
  partial: /\[\d*$/,
  render: (m, { key }) => <Badge key={key} render={<a href={`#source-${m[1]}`} aria-label={`Source ${m[1]}`} />}>{m[1]}</Badge>,
}];

export function SearchView() {
  const sp = useSearchParams();
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [docId, setDocId] = useState<string | null>(sp.get("document_id"));
  const [asked, setAsked] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => { api<{ documents: Document[] }>("/api/documents").then((r) => setDocs(r.documents.filter((d) => d.status === "ready"))).catch(() => setDocs([])); }, []);
  const initialQ = sp.get("q");
  useEffect(() => { if (initialQ) void run(initialQ, sp.get("document_id")); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSuggestions(null);
    api<{ suggestions: Suggestion[] }>(`/api/suggestions${docId ? `?document_id=${docId}` : ""}`).then((r) => setSuggestions(r.suggestions)).catch(() => setSuggestions([]));
  }, [docId]);

  async function run(query: string, scope: string | null = docId) {
    const q = query.trim();
    if (!q) return;
    const gen = generation + 1;
    setGeneration(gen);
    setBusy(true); setErr(null); setAsked(q); setAnswer(null); setHits(null);
    let found: Hit[] = [];
    try {
      const r = await api<{ results: Hit[] }>("/api/search", { method: "POST", body: JSON.stringify({ query: q, document_id: scope, k: 8 }) });
      found = r.results; setHits(found);
    } catch (e) { setErr(String(e)); setHits([]); } finally { setBusy(false); }
    if (!found.length) return;
    setAnswerBusy(true);
    try {
      const passages = found.slice(0, 6).map((h, i) => ({ n: i + 1, text: h.raw_text, document_name: docName(h), page: h.page_start }));
      const r = await api<{ answer: string }>("/api/answer", { method: "POST", body: JSON.stringify({ query: q, passages }) });
      setAnswer(r.answer);
    } catch { setAnswer(""); } finally { setAnswerBusy(false); }
  }

  const docItems = [{ value: ALL, label: "All documents" }, ...(docs ?? []).map((d) => ({ value: d.id, label: d.name.replace(/\.pdf$/i, "") }))];
  function ask(s: Suggestion) {
    const scope = docId ?? s.document_id;
    if (!docId) setDocId(scope);
    void run(s.text, scope);
  }
  const status = busy ? "submitted" : answerBusy ? "streaming" : "ready";

  const header = (
    <PageHeader size="sm">
      <PageHeaderRow>
        <PageHeaderContent>
          <PageHeaderTitle>Search</PageHeaderTitle>
          <PageHeaderDescription>Ask a question and get an answer with its sources. Pick a question below or type your own.</PageHeaderDescription>
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
            <EmptyTitle>Nothing to search yet</EmptyTitle>
            <EmptyDescription>Add a document first. Once it finishes processing it shows up here.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><Button size="sm" nativeButton={false} render={<Link href="/" />}>Go to Documents</Button></EmptyContent>
        </Empty>
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!asked && (
          <section aria-labelledby="ask-title" className="flex w-full flex-col gap-2">
            <h2 id="ask-title" className="type-label text-text-2">{docId ? "Questions this document can answer" : "Try one of these"}</h2>
            <SkeletonSwap
              loading={suggestions === null || docs === null}
              label="Loading suggestions"
              fallback={<ItemGroup><ul>{Array.from({ length: 5 }, (_, i) => <li key={i}><Item><ItemContent><SkeletonText type="body" className="w-96" /><SkeletonText type="body-sm" className="w-40" /></ItemContent></Item></li>)}</ul></ItemGroup>}
            >
              {suggestions && suggestions.length > 0 && (
                <ItemGroup>
                  <ul>
                    {suggestions.map((s, i) => (
                      <li key={`${i}-${s.text}`}>
                        <Item>
                          <ItemContent>
                            {/* A question is a sentence, so it wraps instead of taking ItemTitle's one-line cut. */}
                            <p className="type-label text-text-1">
                              <ItemLink href={`/search?document_id=${s.document_id}&q=${encodeURIComponent(s.text)}`} onClick={(e) => { e.preventDefault(); ask(s); }} className="whitespace-normal">{s.text}</ItemLink>
                            </p>
                            {!docId && <ItemDescription>{s.document_name.replace(/\.pdf$/i, "")}</ItemDescription>}
                          </ItemContent>
                        </Item>
                      </li>
                    ))}
                  </ul>
                </ItemGroup>
              )}
              {suggestions?.length === 0 && <p className="type-body text-text-2">No suggestions for this document yet. Type a question below.</p>}
            </SkeletonSwap>
          </section>
        )}
        {asked && (
          <div className="flex w-full flex-col gap-4">
            <h2 className="type-heading">{asked}</h2>
            {err && <Alert status="fail"><AlertTitle>The search failed</AlertTitle><AlertDescription>{err}</AlertDescription></Alert>}
            {(busy || answerBusy || answer !== null) && (
              <Card>
                <CardHeader><CardTitle>Answer</CardTitle></CardHeader>
                <CardContent>
                  <SkeletonSwap loading={busy || answerBusy} label="Writing the answer" fallback={<SkeletonText type="body" lines={3} />}>
                    {answer ? <Response inlineTags={CITATIONS}>{answer}</Response> : <p className="type-body text-text-2">No answer could be written from what was found.</p>}
                  </SkeletonSwap>
                </CardContent>
              </Card>
            )}
            <SkeletonSwap
              loading={busy}
              label="Searching"
              fallback={<ItemGroup><ul>{Array.from({ length: 4 }, (_, i) => <li key={i}><Item><ItemContent><SkeletonText type="label" className="w-48" /><SkeletonText type="body-sm" lines={2} /></ItemContent></Item></li>)}</ul></ItemGroup>}
            >
              {hits && hits.length === 0 && !err && (
                <Empty reason="no-results">
                  <EmptyHeader>
                    <EmptyTitle>No matches</EmptyTitle>
                    <EmptyDescription>Try different words, or widen the search to all documents.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              {hits && hits.length > 0 && (
                <section aria-labelledby="sources-title" className="flex flex-col gap-2">
                  <h3 id="sources-title" className="type-label text-text-2">Sources</h3>
                  <ItemGroup>
                    <ul>
                      {hits.map((r, i) => <SourceRow key={r.id} r={r} n={i + 1} />)}
                    </ul>
                  </ItemGroup>
                </section>
              )}
            </SkeletonSwap>
          </div>
        )}
      </div>

      <div className="w-full pb-4">
        <PromptInput
          label="Question"
          placeholder="Ask a question"
          status={status}
          generation={generation}
          onStop={() => { setBusy(false); setAnswerBusy(false); }}
          onSubmit={(v: PromptValue) => run(v.text)}
          maxLength={500}
          tools={
            <Select items={docItems} value={docId ?? ALL} onValueChange={(v) => setDocId(v === ALL || v === null ? null : v)}>
              <SelectTrigger size="sm" aria-label="Search in"><SelectValue /></SelectTrigger>
              <SelectContent side="top">{docItems.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}</SelectContent>
            </Select>
          }
        />
      </div>
    </div>
  );
}

/** One passage the answer rests on: where it is, what it says, and its surroundings on request. */
function SourceRow({ r, n }: { r: Hit; n: number }) {
  type Ctx = { parent: Chunk | null; prev: Chunk | null; next: Chunk | null; children: Chunk[] };
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  useEffect(() => { if (open && !ctx) api<Ctx>(`/api/chunks/${r.id}`).then(setCtx).catch(() => {}); }, [open, ctx, r.id]);
  const box = r.bboxes.find((b) => b.page === r.page_start);
  const meta = r.metadata as { image_path?: string };
  return (
    <li id={`source-${n}`}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <Item kind={chunkKind[r.chunk_type]}>
          <ItemContent>
            <ItemTitle>
              <Badge>{n}</Badge>
              <Badge kind={chunkKind[r.chunk_type]} label={typeLabel[r.chunk_type]} />
              <ItemLink href={`/documents/${r.document_id}?page=${r.page_start}`}>{docName(r)}, page {r.page_start}</ItemLink>
            </ItemTitle>
            {r.context && <ItemDescription>{r.context}</ItemDescription>}
            <ItemDescription>{r.raw_text}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>{open ? "Hide context" : "Show context"}</CollapsibleTrigger>
          </ItemActions>
        </Item>
        <CollapsibleContent>
          <div className="flex flex-col gap-3 p-3">
            {meta.image_path && (
              <div className="frame bg-paper">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={publicAsset(meta.image_path)} alt="Figure" className="block max-h-64 w-auto" />
              </div>
            )}
            {box && <PageViewer imageUrl={r.page_image_url} alt={`Page ${r.page_start} of ${docName(r)}`} overlays={[{ id: r.id, type: r.chunk_type, box, label: `${typeLabel[r.chunk_type]} passage on page ${r.page_start}`, selected: true }]} />}
            <SkeletonSwap loading={!ctx} label="Loading surroundings" fallback={<SkeletonText type="body-sm" lines={3} />}>
              {ctx?.parent && (
                <div className="flex flex-col gap-1">
                  <p className="type-label">The whole table</p>
                  <pre className="well max-h-64 overflow-auto rounded-soft p-3 type-code-sm whitespace-pre-wrap">{ctx.parent.raw_text}</pre>
                </div>
              )}
              {ctx && (ctx.prev || ctx.next) && (
                <div className="grid gap-3 md:grid-cols-2">
                  {ctx.prev && <div className="flex flex-col gap-1"><p className="type-label">Before</p><p className="well line-clamp-6 rounded-soft p-3 type-body-sm whitespace-pre-wrap">{ctx.prev.raw_text}</p></div>}
                  {ctx.next && <div className="flex flex-col gap-1"><p className="type-label">After</p><p className="well line-clamp-6 rounded-soft p-3 type-body-sm whitespace-pre-wrap">{ctx.next.raw_text}</p></div>}
                </div>
              )}
            </SkeletonSwap>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
