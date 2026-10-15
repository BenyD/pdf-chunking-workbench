import type { CSSProperties } from "react";
import type { Document, OcrAnchor, OcrField, OcrTemplate, Page } from "./types";
import { api, publicAsset } from "./ui";

/** What the Forms pages share: the shapes a read returns, and the reading of a page's printed words into fields. */

export type Box = { x: number; y: number; w: number; h: number };
export type Word = { text: string; conf: number; box: Box };
export interface RunField { name: string; type: string; value: unknown; raw: string; confidence: number; source: string; valid: boolean; note: string; box_used: Box; ocr_value?: unknown }
export interface RunResult { deskew_angle: number; registration: { dx: number; dy: number; scale: number; matched: { anchor: string; found: string }[] }; fields: RunField[]; needs_fallback: string[]; fallback_used?: boolean; fallback_error?: string }

/** The kinds of value a box can hold, in the words a person would use. */
export const FIELD_TYPES: { value: OcrField["type"]; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "date", label: "Date" },
  { value: "amount", label: "Amount" },
  { value: "integer", label: "Whole number" },
];
export const kindLabel = (t: string) => FIELD_TYPES.find((k) => k.value === t)?.label ?? t;
export const WHOLE_PAGE: Box = { x: 0, y: 0, w: 1, h: 1 };

export const pageUrl = (p: Page) => p.image_url ?? publicAsset(p.image_path);
/** A box as custom properties, read by left-(--x) and friends. */
export const at = (b: Box): CSSProperties => ({ "--x": `${b.x * 100}%`, "--y": `${b.y * 100}%`, "--w": `${b.w * 100}%`, "--h": `${b.h * 100}%` } as CSSProperties);
export const BOX = "absolute top-(--y) left-(--x) h-(--h) w-(--w)";
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const docName = (d: Document) => d.name.replace(/\.pdf$/i, "");

/** What happened on a read, as sentences a person can read. */
export function describe(r: RunResult): string {
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
export function labelBeside(box: Box, words: Word[]): Word | null {
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
export function kindOf(text: string): OcrField["type"] {
  const t = text.trim();
  if (/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/.test(t) || /\b\d{4}-\d{2}-\d{2}\b/.test(t) || /\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{2,4}\b/i.test(t)) return "date";
  if (/^(rs\.?|inr|₹|\$|€|£)?\s*[\d,]+\.\d{1,2}$/i.test(t)) return "amount";
  if (/^\d{1,9}$/.test(t)) return "integer";
  return "text";
}

const cleanWord = (t: string) => t.replace(/[:：.,;]+$/, "");

/**
 * The fields inside a region, read off its printed words: the words are grouped into lines, a line is cut
 * into columns at wide gaps (never right after a label's colon, since a label and its value can sit far
 * apart), and each piece is split into a label and a value at the colon or, unless `colonOnly`, at its widest
 * gap. Each value becomes a field named by its label with the kind its shape suggests; each label becomes a
 * landmark word. Returns nothing when the region holds no label, so the caller treats it as one plain value.
 */
export function splitRegion(region: Box, words: Word[], page: number, opts: { colonOnly?: boolean } = {}): { fields: OcrField[]; anchors: OcrAnchor[] } {
  const inside = words.filter((w) => {
    const cx = w.box.x + w.box.w / 2, cy = w.box.y + w.box.h / 2;
    return cx >= region.x && cx <= region.x + region.w && cy >= region.y && cy <= region.y + region.h && w.text.trim().length > 0;
  });
  if (inside.length < 2) return { fields: [], anchors: [] };
  const heights = inside.map((w) => w.box.h).sort((a, b) => a - b);
  const lineH = heights[Math.floor(heights.length / 2)];
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
    const columns: Word[][] = [[line[0]]];
    for (let i = 1; i < line.length; i++) {
      const prev = line[i - 1], gap = line[i].box.x - (prev.box.x + prev.box.w);
      if (gap > 0.12 && !/[:：]$/.test(prev.text)) columns.push([line[i]]); else columns[columns.length - 1].push(line[i]);
    }
    for (const col of columns) {
      let cut = -1;
      for (let i = 0; i < col.length - 1; i++) if (/[:：]$/.test(col[i].text)) cut = i;
      if (cut < 0 && !opts.colonOnly) {
        let widest = 0;
        for (let i = 0; i < col.length - 1; i++) {
          const gap = col[i + 1].box.x - (col[i].box.x + col[i].box.w);
          if (gap > widest) { widest = gap; cut = i; }
        }
        if (widest < 0.015) cut = -1;
      }
      if (cut < 0 || cut === col.length - 1) continue;
      const label = col.slice(0, cut + 1), value = col.slice(cut + 1);
      const name = label.map((w) => w.text).join(" ").replace(/[:：\s]+$/, "").trim();
      const text = value.map((w) => w.text).join(" ");
      if (!name || /^\d+$/.test(name)) continue;
      fields.push({ name, type: kindOf(text), page, box: union(value) });
      const first = label.find((w) => w.text.replace(/[^a-z0-9]/gi, "").length >= 3) ?? label[0];
      anchors.push({ text: cleanWord(first.text), page, box: first.box });
    }
  }
  return { fields, anchors };
}

/** Landmarks not yet on the list, by place on the page and by word. */
export function newAnchors(have: OcrAnchor[], add: OcrAnchor[]): OcrAnchor[] {
  const out: OcrAnchor[] = [];
  for (const a of add) {
    const dup = [...have, ...out].some((b) => b.page === a.page && (Math.abs(b.box.x - a.box.x) < 0.01 && Math.abs(b.box.y - a.box.y) < 0.01 || b.text.toLowerCase() === a.text.toLowerCase()));
    if (!dup) out.push(a);
  }
  return out;
}

/** The printed words of a page, read by OCR. */
export const readWords = (documentId: string, page: number) =>
  api<{ words: Word[] }>("/api/ocr/words", { method: "POST", body: JSON.stringify({ document_id: documentId, page_number: page }) }).then((r) => r.words);

/** Read one scan with a form. */
export const readScan = (documentId: string, page: number, t: Pick<OcrTemplate, "name" | "fields" | "anchors">, templateId: string | null, fallback: boolean, save = true) =>
  api<{ result: RunResult }>("/api/ocr/run", { method: "POST", body: JSON.stringify({ document_id: documentId, page_number: page, template: { name: t.name, fields: t.fields, anchors: t.anchors }, template_id: templateId, fallback, save }) }).then((r) => r.result);
