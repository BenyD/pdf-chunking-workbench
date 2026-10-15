"use client";
import { useEffect, useMemo, useState } from "react";
import { Checkmark, ErrorOutline, Icon, Subtract, Warning } from "@/components/quartz/icon";
import { Badge } from "@/components/quartz/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/quartz/ui/card";
import { Chip, ChipGroup } from "@/components/quartz/ui/chip";
import { Item, ItemContent, ItemGroup, ItemTitle } from "@/components/quartz/ui/item";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderRow, PageHeaderTitle } from "@/components/quartz/ui/page-header";
import report from "@/data/gap-check.json";
import type { Document } from "@/lib/types";
import { api } from "@/lib/ui";

type Status = "met" | "partly_met" | "not_met" | "not_applicable" | "unsure";
type Row = {
  cite: string; section_title: string; text: string; expected: Status | null;
  passages: { page: number; text: string }[];
  rules: { status: Status; reason: string };
  model: { status: Status; quote: string; reason: string };
};
type ModelScore = { model: string; graded: number; right: number; dollars: number; calls: number };
const data = report as unknown as {
  sop: string; regulation: string; regulation_as_of: string; sections: string[]; requirements: number;
  rules_score: { graded: number; decided: number; right: number; unsure: number };
  model_usage: { calls: number; in: number; out: number; dollars: number; dollars_per_requirement: number; model: string };
  models: ModelScore[]; rows: Row[];
};

const WORD: Record<Status, string> = { met: "Met", partly_met: "Partly met", not_met: "Not met", not_applicable: "Not applicable", unsure: "Unsure" };
const MODEL_NAME: Record<string, string> = { "claude-haiku-5-5": "Claude Haiku 5.5", "claude-sonnet-5-5": "Claude Sonnet 5.5", "claude-opus-5-5": "Claude Opus 5.5" };

function StatusBadge({ s }: { s: Status }) {
  if (s === "met") return <Badge><Icon icon={Checkmark} size={12} data-icon="inline-start" />{WORD[s]}</Badge>;
  if (s === "partly_met") return <Badge status="warn"><Icon icon={Warning} size={12} data-icon="inline-start" />{WORD[s]}</Badge>;
  if (s === "not_met") return <Badge status="fail"><Icon icon={ErrorOutline} size={12} data-icon="inline-start" />{WORD[s]}</Badge>;
  return <Badge variant="outline"><Icon icon={Subtract} size={12} data-icon="inline-start" />{WORD[s]}</Badge>;
}

const usd = (x: number) => (x < 0.01 ? `$${x.toFixed(4)}` : x < 1 ? `$${x.toFixed(3)}` : `$${x.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);

/** One SOP checked sentence by sentence against 21 CFR Part 211: the result, the SOP's own words, and why. */
export function SopCheckView() {
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [gapsOnly, setGapsOnly] = useState(true);
  useEffect(() => { api<{ documents: Document[] }>("/api/documents").then((r) => setDocs(r.documents)).catch(() => setDocs([])); }, []);
  const sopDoc = docs?.find((d) => d.name.replace(/\.pdf$/i, "") === data.sop);

  const counts = useMemo(() => data.rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.model.status]: (acc[r.model.status] ?? 0) + 1 }), {}), []);
  const rows = gapsOnly ? data.rows.filter((r) => r.model.status === "partly_met" || r.model.status === "not_met") : data.rows;
  const perSop = data.model_usage.dollars;
  const haiku = data.models.find((m) => m.model === "claude-haiku-5-5");

  return (
    <div className="flex flex-col gap-8">
      <PageHeader size="sm">
        <PageHeaderRow>
          <PageHeaderContent>
            <PageHeaderTitle>SOP check</PageHeaderTitle>
            <PageHeaderDescription>A company SOP checked line by line against {data.regulation}. Every gap comes with the SOP&apos;s own words and the reason it falls short.</PageHeaderDescription>
          </PageHeaderContent>
        </PageHeaderRow>
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>What was checked</CardTitle>
            <CardDescription>
              {sopDoc ? <a className="underline decoration-1 underline-offset-4" href={`/documents/${sopDoc.id}`}>{data.sop}</a> : data.sop}, against
              sections {data.sections.join(", ")} of the eCFR text as of {data.regulation_as_of}: {data.requirements} requirements, one per sentence, each cited exactly.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {(["met", "partly_met", "not_met", "not_applicable"] as Status[]).map((s) => counts[s] ? <span key={s} className="flex items-center gap-1"><StatusBadge s={s} /><span className="data type-body-sm">{counts[s]}</span></span> : null)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>How right it is</CardTitle>
            <CardDescription>The sample SOP was written with known gaps, so every verdict can be marked.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 type-body-sm">
              <li>Rules alone, no AI: sure about {data.rules_score.decided} of {data.rules_score.graded}, right on {data.rules_score.right} of those.</li>
              {data.models.map((m) => <li key={m.model}>{MODEL_NAME[m.model] ?? m.model}: right on {m.right} of {m.graded}, {usd(m.dollars)} for this SOP.</li>)}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>At 5,000 SOPs</CardTitle>
            <CardDescription>{data.model_usage.calls} model calls cost {usd(perSop)} here, about {usd(data.model_usage.dollars_per_requirement)} a requirement.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 type-body-sm">
              <li>Same scope per SOP: {usd(perSop * 5000)}, or {usd(perSop * 2500)} through the Batch API at half price.</li>
              <li>All of Part 211 per SOP, about ten times the sentences: roughly {usd(perSop * 5000 * 10)}.</li>
              {haiku && <li>The rules settle out-of-scope lines for free, so fewer lines reach the model.</li>}
            </ul>
          </CardContent>
        </Card>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="rows-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="rows-heading" className="type-heading-sm">Requirement by requirement</h2>
          <ChipGroup aria-label="Which requirements to show">
            <Chip pressed={gapsOnly} onPressedChange={() => setGapsOnly(true)}>Gaps only</Chip>
            <Chip pressed={!gapsOnly} onPressedChange={() => setGapsOnly(false)}>All {data.rows.length}</Chip>
          </ChipGroup>
        </div>
        <ItemGroup>
          <ul>
            {rows.map((r) => {
              const page = r.passages[0]?.page;
              return (
                <li key={r.cite}>
                  <Item>
                    <ItemContent>
                      <ItemTitle>
                        <span className="data">{r.cite}</span>
                        <StatusBadge s={r.model.status} />
                      </ItemTitle>
                      <div className="flex flex-col gap-2 type-body-sm">
                        <p className="text-text-2">{r.text}</p>
                        <p><span className="type-label">Why: </span>{r.model.reason}</p>
                        <p>
                          <span className="type-label">The SOP says: </span>
                          {r.model.quote ? <>&ldquo;{r.model.quote}&rdquo;</> : <span className="text-text-3">nothing on this.</span>}
                          {r.model.quote && sopDoc && page ? <> <a className="underline decoration-1 underline-offset-4" href={`/documents/${sopDoc.id}?page=${page}`}>page {page}</a></> : null}
                        </p>
                      </div>
                    </ItemContent>
                  </Item>
                </li>
              );
            })}
          </ul>
        </ItemGroup>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="how-heading">
        <h2 id="how-heading" className="type-heading-sm">How it works</h2>
        <ul className="flex list-disc flex-col gap-1 pl-5 type-body-sm text-text-2">
          <li>The regulation comes from the official eCFR XML, where every paragraph carries its own marker, so each sentence is cut at its exact citation and keeps its parent&apos;s lead-in as context.</li>
          <li>Each requirement is searched for in the SOP with the same search as the rest of the app, which returns the three closest passages.</li>
          <li>Rules decide what they can without AI: lines for products the SOP&apos;s scope excludes, and lines whose terms are plainly there or plainly absent.</li>
          <li>A small model reads each requirement with its whole paragraph and the passages, and returns a verdict, the SOP&apos;s own words and one sentence saying why.</li>
        </ul>
      </section>
    </div>
  );
}
