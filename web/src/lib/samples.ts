import type { OcrAnchor, OcrField } from "./types";

/** Built-in sample documents. Files live in /public/samples so the seed route
 *  can fetch them from the deployment itself (no filesystem access needed on Vercel). */
export const SAMPLES: { key: string; file: string; name: string; blurb: string; pages: number }[] = [
  { key: "bns-2023", file: "bns-2023.pdf", name: "Bharatiya Nyaya Sanhita 2023.pdf",
    blurb: "An Act of Parliament: chapters, numbered sections, titles in the margin and worked illustrations.", pages: 102 },
  { key: "bnss-2023", file: "bnss-2023.pdf", name: "Bharatiya Nagarik Suraksha Sanhita 2023.pdf",
    blurb: "An Act whose First Schedule is a 30-page table with no ruling lines: section, offence, punishment, bailable, court.", pages: 297 },
  { key: "price-schedule", file: "price-schedule.pdf", name: "Pharma Price Schedule (synthetic).pdf",
    blurb: "One ruled price table of 4,500 rows running across 150 pages: code, molecule, strength, pack, ceiling price.", pages: 151 },
  { key: "inspection-report", file: "inspection-report.pdf", name: "QC Inspection Report (synthetic).pdf",
    blurb: "Photos of steel utensils with red arrows and labels drawn on them, and the findings beside each.", pages: 4 },
  { key: "pharmacy-bill-1", file: "pharmacy-bill-1.pdf", name: "Pharmacy bill 1 (synthetic).pdf", blurb: "A clean digital bill. The clean copy to mark up on the Forms page.", pages: 1 },
  { key: "pharmacy-bill-2", file: "pharmacy-bill-2.pdf", name: "Pharmacy bill 2 (synthetic).pdf", blurb: "The same bill layout with a different patient and items.", pages: 1 },
  { key: "pharmacy-bill-3-scan", file: "pharmacy-bill-3-scan.pdf", name: "Pharmacy bill 3 scanned (synthetic).pdf",
    blurb: "A scan of the same bill, slightly crooked and shifted, with no text layer. The scan to read on the Forms page.", pages: 1 },
];

// A4 is 595 x 842 pt. Boxes are fractions of the page. Values printed at x=120 (labels at 50).
const f = (x: number, y: number, w: number, h: number) => ({ x: x / 595, y: y / 842, w: w / 595, h: h / 842 });

export const SAMPLE_OCR_TEMPLATE: { name: string; sample_key: string; fields: OcrField[]; anchors: OcrAnchor[] } = {
  name: "Sunrise pharmacy bill",
  sample_key: "pharmacy-bill-1",
  fields: [
    { name: "invoice_no", type: "text", page: 1, box: f(118, 99, 160, 15), pattern: "SP/\\d{4}/\\d+" },
    { name: "date", type: "date", page: 1, box: f(118, 117, 120, 15) },
    { name: "patient", type: "text", page: 1, box: f(118, 135, 190, 15) },
    { name: "patient_id", type: "text", page: 1, box: f(118, 153, 120, 15), pattern: "PT-\\d+" },
    { name: "doctor", type: "text", page: 1, box: f(398, 99, 150, 15) },
    { name: "grand_total", type: "amount", page: 1, box: f(466, 352, 90, 18) },
  ],
  anchors: [
    { text: "SUNRISE", page: 1, box: f(50, 47, 70, 16) },
    { text: "INVOICE", page: 1, box: f(430, 48, 60, 15) },
    { text: "Total:", page: 1, box: f(380, 350, 70, 14) },
  ],
};
