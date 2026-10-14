"""Generate the built-in sample PDFs. Deterministic (seeded) and synthetic:
no real patients, no real prices.

  inspection-report.pdf    annotated figures (arrows drawn as vector overlays on a raster photo)
  pharmacy-bill-1.pdf      clean digital bill          -> zonal OCR template source
  pharmacy-bill-2.pdf      same layout, other data      -> zonal OCR target
  pharmacy-bill-3-scan.pdf same layout, rotated/shifted image-only scan -> OCR path + registration
  price-schedule.pdf       a ruled table running across 150 pages (~4,500 rows) -> scale test

Run:  uv run --project worker python samples/generate/make_samples.py
"""
from __future__ import annotations

import math
import random
import sys
from pathlib import Path

import numpy as np
import pymupdf
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parents[2] / "web" / "public" / "samples"
OUT.mkdir(parents=True, exist_ok=True)
WORK = Path(__file__).resolve().parents[1] / "work"
WORK.mkdir(exist_ok=True)
rng = random.Random(20261014)

A4 = pymupdf.paper_rect("a4")
BLACK, RED, GREY = (0, 0, 0), (0.85, 0.1, 0.1), (0.35, 0.35, 0.35)
FONT, BOLD = "helv", "hebo"


def text(page, x, y, s, size=10, bold=False, color=BLACK):
    page.insert_text((x, y), s, fontsize=size, fontname=BOLD if bold else FONT, color=color)


def paragraph(page, rect, s, size=10):
    page.insert_textbox(rect, s, fontsize=size, fontname=FONT, color=BLACK, align=pymupdf.TEXT_ALIGN_LEFT)


def arrow(page, p1, p2, color=RED, width=1.6):
    sh = page.new_shape()
    sh.draw_line(p1, p2)
    sh.finish(color=color, width=width)
    ang = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
    L, W = 9, 5
    tip = pymupdf.Point(p2)
    left = pymupdf.Point(p2[0] - L * math.cos(ang) + W * math.sin(ang), p2[1] - L * math.sin(ang) - W * math.cos(ang))
    right = pymupdf.Point(p2[0] - L * math.cos(ang) - W * math.sin(ang), p2[1] - L * math.sin(ang) + W * math.cos(ang))
    sh.draw_polyline([tip, left, right, tip])
    sh.finish(color=color, fill=color, width=0.5)
    sh.commit()


def ruled_table(page, x, y, col_w, header, rows, size=8.5, row_h=14, header_fill=(0.9, 0.9, 0.9)):
    """Draws a bordered table; returns bottom y."""
    sh = page.new_shape()
    total_w = sum(col_w)
    # header
    sh.draw_rect(pymupdf.Rect(x, y, x + total_w, y + row_h))
    sh.finish(color=BLACK, fill=header_fill, width=0.6)
    cx = x
    for w, h in zip(col_w, header):
        page.insert_text((cx + 3, y + row_h - 4), h, fontsize=size, fontname=BOLD)
        cx += w
    yy = y + row_h
    for r in rows:
        cx = x
        for w, c in zip(col_w, r):
            page.insert_text((cx + 3, yy + row_h - 4), str(c)[:int(w / (size * 0.5))], fontsize=size, fontname=FONT)
            cx += w
        yy += row_h
    # grid
    sh = page.new_shape()
    sh.draw_rect(pymupdf.Rect(x, y, x + total_w, yy))
    cx = x
    for w in col_w[:-1]:
        cx += w
        sh.draw_line((cx, y), (cx, yy))
    for i in range(1, len(rows) + 1):
        sh.draw_line((x, y + i * row_h), (x + total_w, y + i * row_h))
    sh.finish(color=BLACK, width=0.5)
    sh.commit()
    return yy


# ---------------------------------------------------------------------------
# 1. inspection report with annotated figures
# ---------------------------------------------------------------------------

def bowl_image(path: Path, dent: bool = True) -> None:
    W, H = 900, 600
    img = Image.new("RGB", (W, H), (245, 245, 247))
    d = ImageDraw.Draw(img)
    # brushed steel bowl: outer ellipse, rim, inner shading
    d.ellipse((120, 140, 780, 520), fill=(176, 180, 186), outline=(90, 92, 96), width=6)
    d.ellipse((160, 120, 740, 300), fill=(205, 208, 214), outline=(110, 112, 118), width=4)
    for i in range(0, 600, 6):  # brushed texture
        d.line((140, 160 + i * 0.6, 760, 150 + i * 0.6), fill=(190 + (i % 12), 193 + (i % 12), 199 + (i % 12)), width=1)
    d.ellipse((160, 120, 740, 300), outline=(110, 112, 118), width=4)
    if dent:
        d.pieslice((150, 90, 290, 230), 200, 330, fill=(120, 122, 126), outline=(60, 60, 64), width=3)  # rim dent
        d.polygon([(560, 420), (610, 470), (590, 480), (545, 440)], fill=(70, 70, 74))  # scratch
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    img.save(path)


def ladle_image(path: Path) -> None:
    W, H = 900, 600
    img = Image.new("RGB", (W, H), (248, 247, 244))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((80, 260, 620, 300), radius=18, fill=(170, 174, 180), outline=(90, 92, 96), width=4)
    d.ellipse((560, 170, 860, 430), fill=(185, 188, 194), outline=(90, 92, 96), width=5)
    d.ellipse((600, 200, 820, 400), fill=(150, 154, 160), outline=(110, 112, 118), width=3)
    d.line((330, 262, 345, 298), fill=(40, 40, 44), width=5)   # hairline crack at the weld
    d.line((345, 298, 352, 302), fill=(40, 40, 44), width=3)
    img = img.filter(ImageFilter.GaussianBlur(0.5))
    img.save(path)


def make_inspection_report() -> None:
    bowl_image(WORK / "bowl.png")
    ladle_image(WORK / "ladle.png")
    doc = pymupdf.open()

    # page 1: cover + scope
    p = doc.new_page(width=A4.width, height=A4.height)
    text(p, 60, 80, "QUALITY INSPECTION REPORT", 18, True)
    text(p, 60, 104, "Stainless steel kitchenware, incoming batch QC-2026-114", 11, False, GREY)
    text(p, 60, 120, "Supplier: Meridian Metalworks Pvt. Ltd.   Inspector: R. Iyer   Date: 14 October 2026", 9, False, GREY)
    text(p, 60, 170, "1. Scope", 13, True)
    paragraph(p, pymupdf.Rect(60, 180, 535, 300),
              "This report records the visual and dimensional inspection of 240 units of SKU B-220 (mixing bowl, 24 cm) "
              "and 120 units of SKU L-410 (serving ladle, 32 cm) received on 12 October 2026. Inspection followed "
              "procedure QP-07 rev. 4: 100% visual check under 800 lux, rim deformation measured with a dial gauge, "
              "and a dye-penetrant check on 10% of welded joints. Each defect is photographed and annotated; the "
              "annotations in the figures are part of the inspection record.")
    text(p, 60, 320, "2. Acceptance criteria", 13, True)
    paragraph(p, pymupdf.Rect(60, 330, 535, 440),
              "Rim deformation up to 1.0 mm is acceptable (grade A). Deformation between 1.0 mm and 2.5 mm is grade B "
              "and may be reworked. Deformation above 2.5 mm, any crack, or any weld porosity visible under dye "
              "penetrant is a reject. Surface scratches longer than 15 mm on a food-contact surface are grade B.")

    # page 2: figure 1 bowl
    p = doc.new_page(width=A4.width, height=A4.height)
    text(p, 60, 70, "3. Findings", 13, True)
    paragraph(p, pymupdf.Rect(60, 80, 535, 150),
              "3.1 Rim deformation on SKU B-220. Seven of 240 bowls showed deformation of the rolled rim. The worst case "
              "is shown in Figure 1: the dent measured 2.1 mm at the deepest point and sits 35 mm from the seam weld. "
              "A 22 mm scratch on the inner wall of the same unit is also marked. The unit is graded B and sent for rework.")
    img_rect = pymupdf.Rect(90, 160, 505, 437)
    p.insert_image(img_rect, filename=str(WORK / "bowl.png"))
    # annotations drawn on top of the raster: arrows + labels are vector objects
    arrow(p, (380, 180), (182, 212))
    text(p, 386, 184, "Dent on rim, 2.1 mm deep (grade B)", 8, True, RED)
    arrow(p, (430, 420), (355, 372))
    text(p, 300, 432, "Scratch, 22 mm, inner wall", 8, True, RED)
    arrow(p, (120, 330), (165, 300))
    text(p, 96, 345, "Seam weld (OK)", 8, True, RED)
    text(p, 90, 455, "Figure 1. Mixing bowl SKU B-220, unit 117. Red arrows mark the rim dent (2.1 mm), a 22 mm scratch", 8.5, False, GREY)
    text(p, 90, 466, "on the inner wall and the seam weld, which passed dye-penetrant inspection.", 8.5, False, GREY)
    paragraph(p, pymupdf.Rect(60, 490, 535, 600),
              "3.2 Surface finish. Brushed finish uniform on all units; no pitting observed. Nine units carried minor "
              "handling marks under 15 mm which are within specification. Compare the marked scratch in Figure 1, which "
              "exceeds the 15 mm limit.")

    # page 3: figure 2 ladle
    p = doc.new_page(width=A4.width, height=A4.height)
    paragraph(p, pymupdf.Rect(60, 70, 535, 140),
              "3.3 Weld integrity on SKU L-410. Dye-penetrant testing of 12 ladles revealed one hairline crack at the "
              "handle-to-bowl weld, shown in Figure 2. Crack length 11 mm, oriented across the weld toe. This is a "
              "reject under clause 2. The remaining 11 sampled welds were sound.")
    img_rect = pymupdf.Rect(90, 150, 505, 427)
    p.insert_image(img_rect, filename=str(WORK / "ladle.png"))
    arrow(p, (330, 200), (248, 272))
    text(p, 334, 198, "Hairline crack at weld toe, 11 mm (REJECT)", 8, True, RED)
    arrow(p, (150, 380), (205, 290))
    text(p, 96, 396, "Handle, 8 mm tube, OK", 8, True, RED)
    text(p, 90, 445, "Figure 2. Serving ladle SKU L-410, unit 22, after dye-penetrant test. The arrow marks an 11 mm", 8.5, False, GREY)
    text(p, 90, 456, "hairline crack at the handle-to-bowl weld toe. The unit is rejected.", 8.5, False, GREY)

    # page 4: defect table (ruled)
    p = doc.new_page(width=A4.width, height=A4.height)
    text(p, 60, 70, "4. Defect register", 13, True)
    paragraph(p, pymupdf.Rect(60, 80, 535, 110), "Table 1 lists every defect found in the batch with its disposition.")
    header = ["Unit", "SKU", "Defect", "Location", "Size", "Grade", "Action"]
    rows = [
        ["117", "B-220", "Rim deformation", "Rim, 35 mm from weld", "2.1 mm", "B", "Rework"],
        ["117", "B-220", "Scratch", "Inner wall", "22 mm", "B", "Rework"],
        ["041", "B-220", "Rim deformation", "Rim, opposite weld", "1.4 mm", "B", "Rework"],
        ["088", "B-220", "Rim deformation", "Rim", "0.8 mm", "A", "Accept"],
        ["203", "B-220", "Rim deformation", "Rim near weld", "2.7 mm", "Reject", "Scrap"],
        ["022", "L-410", "Hairline crack", "Handle-to-bowl weld toe", "11 mm", "Reject", "Scrap"],
        ["067", "L-410", "Weld porosity", "Weld root", "2 pores", "Reject", "Scrap"],
        ["105", "L-410", "Handling mark", "Handle", "9 mm", "A", "Accept"],
    ]
    y = ruled_table(p, 60, 120, [36, 44, 92, 120, 48, 44, 58], header, rows, size=8.5, row_h=16)
    text(p, 60, y + 14, "Table 1. Defect register for batch QC-2026-114.", 8.5, False, GREY)
    text(p, 60, y + 50, "5. Disposition", 13, True)
    paragraph(p, pymupdf.Rect(60, y + 60, 535, y + 160),
              "Three units are rejected and scrapped (B-220 unit 203, L-410 units 022 and 067). Four units go to rework. "
              "The batch is accepted conditionally; the supplier is asked for a corrective action report on the "
              "handle weld within 15 days.")
    doc.save(OUT / "inspection-report.pdf", garbage=3, deflate=True)
    print("inspection-report.pdf", doc.page_count, "pages")


# ---------------------------------------------------------------------------
# 2. pharmacy bills (clean + scanned)
# ---------------------------------------------------------------------------

ITEMS = [
    ("Paracetamol 500 mg Tab", 10, 2.1), ("Amoxicillin 500 mg Cap", 10, 8.4), ("Cetirizine 10 mg Tab", 10, 1.8),
    ("Pantoprazole 40 mg Tab", 15, 6.2), ("Metformin 500 mg Tab", 20, 1.9), ("Azithromycin 500 mg Tab", 3, 24.0),
    ("ORS sachet 21 g", 5, 18.0), ("Vitamin D3 60000 IU", 4, 32.0), ("Ibuprofen 400 mg Tab", 10, 2.6),
    ("Salbutamol inhaler 100 mcg", 1, 160.0),
]


def bill_doc(inv_no: str, date: str, patient: str, pid: str, doctor: str, items: list, seed: int) -> pymupdf.Document:
    doc = pymupdf.open()
    p = doc.new_page(width=A4.width, height=A4.height)
    text(p, 50, 60, "SUNRISE PHARMACY & CLINIC", 15, True)
    text(p, 50, 76, "12 Lake View Road, Chennai 600041  |  GSTIN 33AAACS1234F1Z5  |  DL 20B/1234", 8, False, GREY)
    text(p, 430, 60, "TAX INVOICE", 13, True)
    sh = p.new_shape(); sh.draw_line((50, 88), (545, 88)); sh.finish(color=BLACK, width=0.8); sh.commit()
    # field block (fixed positions = what the zonal template relies on)
    text(p, 50, 110, "Invoice No:", 9, True); text(p, 120, 110, inv_no, 10)
    text(p, 50, 128, "Date:", 9, True); text(p, 120, 128, date, 10)
    text(p, 50, 146, "Patient:", 9, True); text(p, 120, 146, patient, 10)
    text(p, 50, 164, "Patient ID:", 9, True); text(p, 120, 164, pid, 10)
    text(p, 320, 110, "Prescribed by:", 9, True); text(p, 400, 110, doctor, 10)
    text(p, 320, 128, "Payment:", 9, True); text(p, 400, 128, "UPI", 10)
    header = ["Sl", "Item", "Batch", "Exp", "Qty", "Rate", "Amount"]
    rows, sub = [], 0.0
    r = random.Random(seed)
    for i, (name, qty, rate) in enumerate(items, 1):
        amt = qty * rate
        sub += amt
        rows.append([i, name, f"B{r.randint(1000, 9999)}", f"{r.randint(1, 12):02d}/{r.randint(27, 29)}", qty, f"{rate:.2f}", f"{amt:.2f}"])
    y = ruled_table(p, 50, 190, [24, 190, 56, 46, 36, 60, 83], header, rows, size=9, row_h=18)
    gst = round(sub * 0.12, 2)
    total = round(sub + gst, 2)
    text(p, 380, y + 22, "Subtotal:", 9, True); text(p, 470, y + 22, f"{sub:,.2f}", 10)
    text(p, 380, y + 40, "GST 12%:", 9, True); text(p, 470, y + 40, f"{gst:,.2f}", 10)
    text(p, 380, y + 60, "Grand Total:", 11, True); text(p, 470, y + 60, f"Rs. {total:,.2f}", 11, True)
    text(p, 50, 760, "Goods once sold will not be taken back. Keep medicines out of reach of children. This is a computer generated invoice.", 7.5, False, GREY)
    return doc


def bill_template(doc: pymupdf.Document) -> dict:
    """Derive the zonal template from the real word positions on the clean bill,
    so the demo template is exact rather than hand-estimated."""
    import json
    page = doc[0]
    W, H = page.rect.width, page.rect.height
    words = page.get_text("words")  # x0, y0, x1, y1, text, block, line, wordno

    def frac(x0, y0, x1, y1, pad=2.5):
        return {"x": max(0, x0 - pad) / W, "y": max(0, y0 - pad) / H, "w": (x1 - x0 + 2 * pad) / W, "h": (y1 - y0 + 2 * pad) / H}

    def value_after(label_words: list[str], min_x: float | None = None):
        """Words on the same line to the right of the label, up to the next label."""
        for w in words:
            if w[4] == label_words[-1] and (len(label_words) == 1 or any(v[4] == label_words[0] and abs(v[1] - w[1]) < 3 for v in words)):
                y0, y1 = w[1], w[3]
                same = [v for v in words if abs(v[1] - y0) < 3 and v[0] > w[2] and (min_x is None or v[0] >= min_x)]
                same.sort(key=lambda v: v[0])
                # stop at the next label (ends with ':' and is bold-ish in our layout: known labels)
                vals = []
                for v in same:
                    # stop at the next label on the line ("Prescribed by:" sits right of the invoice number)
                    if v[4].endswith(":") or v[4] in ("Prescribed", "Payment", "Patient"):
                        break
                    vals.append(v)
                if vals:
                    return frac(min(v[0] for v in vals), min(v[1] for v in vals), max(v[2] for v in vals), max(v[3] for v in vals))
        return None

    def word_box(text: str, nth: int = 0):
        hits = [w for w in words if w[4] == text]
        w = hits[nth]
        return frac(w[0], w[1], w[2], w[3], pad=1.5)

    fields = [
        {"name": "invoice_no", "type": "text", "page": 1, "box": value_after(["Invoice", "No:"]), "pattern": "SP/\\d{4}/\\d+"},
        {"name": "date", "type": "date", "page": 1, "box": value_after(["Date:"])},
        {"name": "patient", "type": "text", "page": 1, "box": value_after(["Patient:"])},
        {"name": "patient_id", "type": "text", "page": 1, "box": value_after(["Patient", "ID:"]), "pattern": "PT-\\d+"},
        {"name": "doctor", "type": "text", "page": 1, "box": value_after(["Prescribed", "by:"])},
        {"name": "grand_total", "type": "amount", "page": 1, "box": value_after(["Grand", "Total:"])},
    ]
    anchors = [
        {"text": "SUNRISE", "page": 1, "box": word_box("SUNRISE")},
        {"text": "INVOICE", "page": 1, "box": word_box("INVOICE")},
        {"text": "Prescribed", "page": 1, "box": word_box("Prescribed")},
        {"text": "Grand", "page": 1, "box": word_box("Grand")},
    ]
    tpl = {"name": "Sunrise pharmacy bill", "sample_key": "pharmacy-bill-1", "fields": fields, "anchors": anchors}
    (OUT / "ocr-template.json").write_text(json.dumps(tpl, indent=2))
    return tpl


def make_bills() -> None:
    b1 = bill_doc("SP/2026/04417", "14/10/2026", "Ananya Krishnan", "PT-204581", "Dr. S. Menon", ITEMS[:6], 1)
    b1.save(OUT / "pharmacy-bill-1.pdf", garbage=3, deflate=True)
    tpl = bill_template(b1)
    print("ocr-template.json:", [(f["name"], f["box"] is not None) for f in tpl["fields"]])
    b2 = bill_doc("SP/2026/04452", "15/10/2026", "Rahul Verma", "PT-207733", "Dr. P. Nair", ITEMS[3:9], 2)
    b2.save(OUT / "pharmacy-bill-2.pdf", garbage=3, deflate=True)
    # scanned variant: render, rotate, shift, add noise, wrap as image-only PDF
    b3 = bill_doc("SP/2026/04469", "16/10/2026", "Meera Pillai", "PT-209016", "Dr. A. Rao", ITEMS[1:7], 3)
    pix = b3[0].get_pixmap(dpi=200, alpha=False)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples).convert("L")
    img = img.rotate(1.6, resample=Image.BICUBIC, fillcolor=255, expand=False)
    arr = np.array(img).astype(np.int16)
    arr = np.roll(arr, (34, 22), axis=(0, 1))          # shift down/right
    arr[:34, :] = 255; arr[:, :22] = 255
    noise = np.random.default_rng(7).normal(0, 9, arr.shape)
    arr = np.clip(arr + noise, 0, 255).astype(np.uint8)
    img = Image.fromarray(arr).filter(ImageFilter.GaussianBlur(0.4))
    img.save(WORK / "bill3.png")
    doc = pymupdf.open()
    p = doc.new_page(width=A4.width, height=A4.height)
    p.insert_image(p.rect, filename=str(WORK / "bill3.png"))
    doc.save(OUT / "pharmacy-bill-3-scan.pdf", garbage=3, deflate=True)
    print("pharmacy bills written (1, 2, 3-scan)")


# ---------------------------------------------------------------------------
# 3. huge ruled table across many pages
# ---------------------------------------------------------------------------

MOLECULES = ["Amlodipine", "Atorvastatin", "Metformin", "Losartan", "Telmisartan", "Pantoprazole", "Omeprazole",
             "Azithromycin", "Amoxicillin", "Cefixime", "Levocetirizine", "Montelukast", "Paracetamol", "Ibuprofen",
             "Diclofenac", "Metoprolol", "Glimepiride", "Sitagliptin", "Rosuvastatin", "Clopidogrel", "Aspirin",
             "Ondansetron", "Domperidone", "Rabeprazole", "Levothyroxine", "Prednisolone", "Salbutamol", "Budesonide"]
FORMS = ["Tablet", "Capsule", "Syrup", "Injection", "Inhaler", "Ointment"]
MFRS = ["Cadence Pharma", "Vistara Labs", "Meridian Life", "Okra Health", "Suryodaya Remedies", "Nilgiri Biotech"]


def make_price_schedule(pages: int = 150, rows_per_page: int = 30) -> None:
    doc = pymupdf.open()
    p = doc.new_page(width=A4.width, height=A4.height)
    text(p, 60, 90, "NATIONAL PHARMACEUTICAL PRICE SCHEDULE 2026", 16, True)
    text(p, 60, 112, "Ceiling prices of scheduled formulations (synthetic sample data)", 10, False, GREY)
    paragraph(p, pymupdf.Rect(60, 140, 535, 300),
              "This schedule lists the ceiling price per unit for scheduled formulations. Each row gives the formulation "
              "code, molecule, strength, dosage form, pack size, ceiling price in rupees, schedule category and the "
              "reference manufacturer. The table continues without interruption across all pages; column headings are "
              "repeated on every page for readability only.")
    header = ["Code", "Molecule", "Strength", "Form", "Pack", "Ceiling price (INR)", "Sched.", "Manufacturer"]
    widths = [52, 96, 56, 54, 40, 78, 36, 92]
    r = random.Random(99)
    code = 10000
    total_rows = 0
    for pg in range(pages):
        p = doc.new_page(width=A4.width, height=A4.height)
        text(p, 60, 50, "National Pharmaceutical Price Schedule 2026", 8, False, GREY)
        text(p, 500, 50, f"Page {pg + 2}", 8, False, GREY)
        rows = []
        for _ in range(rows_per_page):
            code += 1
            mol = r.choice(MOLECULES)
            strength = r.choice(["5 mg", "10 mg", "20 mg", "40 mg", "250 mg", "500 mg", "650 mg", "100 mcg", "5 mg/5 ml"])
            form = r.choice(FORMS)
            pack = r.choice([1, 10, 15, 30, 60, 100])
            price = round(r.uniform(0.8, 95.0), 2)
            sched = r.choice(["H", "H1", "G", "OTC"])
            rows.append([f"F-{code}", mol, strength, form, str(pack), f"{price:.2f}", sched, r.choice(MFRS)])
        ruled_table(p, 45, 70, widths, header, rows, size=8, row_h=22)
        total_rows += len(rows)
    doc.save(OUT / "price-schedule.pdf", garbage=3, deflate=True)
    print(f"price-schedule.pdf {doc.page_count} pages, {total_rows} rows")


if __name__ == "__main__":
    make_inspection_report()
    make_bills()
    make_price_schedule()
    for f in sorted(OUT.glob("*.pdf")):
        print(f"  {f.name:28} {f.stat().st_size/1024:8.0f} KB")
