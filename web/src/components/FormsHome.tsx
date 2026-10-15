"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon, ListChecked } from "@/components/quartz/icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/quartz/ui/alert";
import { Button } from "@/components/quartz/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/quartz/ui/empty-state";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemLink, ItemTitle } from "@/components/quartz/ui/item";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderRow, PageHeaderTitle } from "@/components/quartz/ui/page-header";
import { SkeletonSwap, SkeletonText } from "@/components/quartz/ui/skeleton";
import { docName, plural } from "@/lib/forms";
import { SAMPLES } from "@/lib/samples";
import type { Document, OcrTemplate } from "@/lib/types";
import { api } from "@/lib/ui";

/** The forms taught so far. Each opens on reading scans; a new one starts the four-step teaching. */
export function FormsHome() {
  const router = useRouter();
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [templates, setTemplates] = useState<OcrTemplate[] | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ documents: Document[] }>("/api/documents").then((r) => setDocs(r.documents.filter((d) => d.status === "ready"))).catch(() => setDocs([]));
    api<{ templates: OcrTemplate[] }>("/api/ocr/templates").then((r) => setTemplates(r.templates)).catch(() => setTemplates([]));
  }, []);

  async function loadSamples() {
    setSeeding(true); setErr(null);
    try { await api("/api/samples", { method: "POST", body: JSON.stringify({ keys: SAMPLES.map((s) => s.key) }) }); router.push("/"); }
    catch (e) { setErr(String(e)); setSeeding(false); }
  }

  const noDocs = docs !== null && docs.length === 0;
  return (
    <>
      <PageHeader size="sm">
        <PageHeaderRow>
          <PageHeaderContent>
            <PageHeaderTitle>Forms</PageHeaderTitle>
            <PageHeaderDescription>Teach it a form once, then read every scan of that form into a table.</PageHeaderDescription>
          </PageHeaderContent>
          {templates && templates.length > 0 && !noDocs && (
            <PageHeaderActions>
              <Button nativeButton={false} render={<Link href="/forms/new" />}>New form</Button>
            </PageHeaderActions>
          )}
        </PageHeaderRow>
      </PageHeader>
      {err && <Alert status="fail"><AlertTitle>Loading the samples failed</AlertTitle><AlertDescription>{err}</AlertDescription></Alert>}

      <SkeletonSwap loading={docs === null || templates === null} label="Loading forms" fallback={<div className="flex flex-col gap-2"><SkeletonText type="label" className="w-64" /><SkeletonText type="body-sm" className="w-80" /></div>}>
        {noDocs && (
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
        )}
        {!noDocs && templates && templates.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia><Icon icon={ListChecked} /></EmptyMedia>
              <EmptyTitle>No form taught yet</EmptyTitle>
              <EmptyDescription>Teaching takes four steps: pick a clean copy, mark the values, test it on a scan, save. Then any number of scans can be read into one table.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent><Button size="sm" nativeButton={false} render={<Link href="/forms/new" />}>New form</Button></EmptyContent>
          </Empty>
        )}
        {!noDocs && templates && templates.length > 0 && (
          <ItemGroup>
            <ul>
              {templates.map((t) => {
                const copy = docs?.find((d) => d.id === t.document_id);
                const facts = [plural(t.fields.length, "value"), copy ? `taught on ${docName(copy)}` : null, t.runs ? `${plural(t.runs, "scan")} read` : "no scan read yet"].filter(Boolean).join(", ");
                return (
                  <li key={t.id}>
                    <Item>
                      <ItemContent>
                        <ItemTitle><ItemLink href={`/forms/${t.id}`}>{t.name}</ItemLink></ItemTitle>
                        <ItemDescription>{facts}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={`/forms/${t.id}/edit`} />}>Edit</Button>
                      </ItemActions>
                    </Item>
                  </li>
                );
              })}
            </ul>
          </ItemGroup>
        )}
      </SkeletonSwap>
    </>
  );
}
