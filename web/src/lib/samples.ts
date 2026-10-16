import type { OcrAnchor, OcrField } from "./types";

/** Built-in sample documents. Files live in /public/samples so the seed route
 *  can fetch them from the deployment itself (no filesystem access needed on Vercel). */
/** questions: a few fixed questions per sample for the Search page when generative AI is off (nothing is
 *  written by a model then). Taken from the benchmark sets, each one answered in the top results without AI. */
export const SAMPLES: { key: string; file: string; name: string; blurb: string; pages: number; questions?: string[] }[] = [
  { key: "bns-2023", file: "bns-2023.pdf", name: "Bharatiya Nyaya Sanhita 2023.pdf",
    blurb: "An Act with chapters, numbered sections and worked illustrations.", pages: 102,
    questions: ["What is defamation?", "How is cheating defined?", "Can a child under seven commit an offence?"] },
  { key: "bnss-2023", file: "bnss-2023.pdf", name: "Bharatiya Nagarik Suraksha Sanhita 2023.pdf",
    blurb: "An Act whose schedule is a 30-page table with no ruling lines.", pages: 297,
    questions: ["Is theft a cognizable offence?", "What is a bailable offence?", "How long can an arrested person be detained without a magistrate's order?"] },
  { key: "price-schedule", file: "price-schedule.pdf", name: "Pharma Price Schedule (synthetic).pdf",
    blurb: "One ruled price table of 4,500 rows across 150 pages.", pages: 151,
    questions: ["Price of F-14321", "What is the ceiling price of F-11000 and its schedule category?"] },
  { key: "inspection-report", file: "inspection-report.pdf", name: "QC Inspection Report (synthetic).pdf",
    blurb: "Photos of utensils with arrows and labels, and the findings.", pages: 4,
    questions: ["Which unit had a dent on the rim and how deep was it?", "Which units were rejected and scrapped?"] },
  { key: "pharmacy-bill-1", file: "pharmacy-bill-1.pdf", name: "Pharmacy bill 1 (synthetic).pdf", blurb: "A clean digital bill.", pages: 1,
    questions: ["What batch number was dispensed for the Pantoprazole 40 mg tablets on Sunrise Pharmacy invoice SP/2026/04417?"] },
  { key: "pharmacy-bill-2", file: "pharmacy-bill-2.pdf", name: "Pharmacy bill 2 (synthetic).pdf", blurb: "The same bill with a different patient and items.", pages: 1,
    questions: ["What batch number was dispensed for the Azithromycin 500 mg tablets on Sunrise Pharmacy invoice SP/2026/04452?"] },
  { key: "pharmacy-bill-3-scan", file: "pharmacy-bill-3-scan.pdf", name: "Pharmacy bill 3 scanned (synthetic).pdf",
    blurb: "A crooked, shifted scan of the same bill, with no text layer.", pages: 1,
    questions: ["What is the grand total on the Sunrise Pharmacy & Clinic invoice for Meera Pillai that includes 12% GST on the medicines?"] },
  { key: "maintenance-manual", file: "maintenance-manual.pdf", name: "Tablet press maintenance manual (synthetic).pdf",
    blurb: "Drawings marked only with letters and numbers, explained by tables on another page.", pages: 3,
    questions: ["What does the arrow marked D point to in the turret figure?", "On the turret drawing, which lettered part is checked for pitting on the punch tips?"] },
  { key: "sop-stability", file: "sop-stability.pdf", name: "SOP-QC-014 Stability and reserve samples (synthetic).pdf",
    blurb: "A company SOP with known gaps, to check line by line against 21 CFR Part 211.", pages: 1,
    questions: ["How long are reserve samples kept?", "At what conditions are stability samples stored?"] },
];

// A4 is 595 x 842 pt. Boxes are fractions of the page. Values printed at x=120 (labels at 50).
const f = (x: number, y: number, w: number, h: number) => ({ x: x / 595, y: y / 842, w: w / 595, h: h / 842 });

export const SAMPLE_OCR_TEMPLATE: { name: string; sample_key: string; fields: OcrField[]; anchors: OcrAnchor[] } = {
  name: "Sunrise pharmacy bill",
  sample_key: "pharmacy-bill-1",
  fields: [
    { name: "Invoice number", type: "text", page: 1, box: f(118, 99, 160, 15), pattern: "SP/\\d{4}/\\d+" },
    { name: "Date", type: "date", page: 1, box: f(118, 117, 120, 15) },
    { name: "Patient", type: "text", page: 1, box: f(118, 135, 190, 15) },
    { name: "Patient ID", type: "text", page: 1, box: f(118, 153, 120, 15), pattern: "PT-\\d+" },
    { name: "Doctor", type: "text", page: 1, box: f(398, 99, 150, 15) },
    { name: "Grand total", type: "amount", page: 1, box: f(466, 352, 90, 18) },
  ],
  anchors: [
    { text: "SUNRISE", page: 1, box: f(50, 47, 70, 16) },
    { text: "INVOICE", page: 1, box: f(430, 48, 60, 15) },
    { text: "Total:", page: 1, box: f(380, 350, 70, 14) },
  ],
};
