"""Three held-out synthetic SOPs for the no-AI gap check (written 2026-10-17, after the rules judge was frozen).

    worker/.venv/bin/python samples/generate/make_gap_heldout.py OUTDIR

Expected sections and verdicts are in scripts/benchmarks/gap-heldout.json, written before any of these was ingested.
The PDFs are not kept in the repo; upload them to a local stack to run scripts/gap_modes.py on them.
"""
import sys
from pathlib import Path

import pymupdf

SOPS = {
    "SOP-PR-015 In-process controls and yield (synthetic)": (
        "SOP-PR-015: In-process controls and yield (synthetic)",
        "Version 4   Effective 01-May-2026   Department: Production   Site: Chennai",
        [
            ("1. Purpose", "To set out the checks made on in-process material during granulation, blending, compression and "
             "coating, and how the yield of each step is worked out."),
            ("2. Scope", "Applies to the granulation, compression and coating of tablets in the oral solid dosage block."),
            ("3. In-process checks", "3.1 The master record of each product lists the in-process checks, the samples taken "
             "for them and the limits; operators follow it for every batch. 3.2 These checks monitor the output of each "
             "step and show whether granulation, blending and compression perform as validated. 3.3 At the press, the "
             "weight of 20 tablets is checked every 30 minutes against the weight limits, with hardness, thickness and "
             "friability. 3.4 Blend uniformity is shown by ten samples from the blender tested for content uniformity. "
             "3.5 Dissolution of the coated tablets is tested at the end of coating. 3.6 Bioburden is not tested in "
             "process, as no step uses water."),
            ("4. Limits and results", "4.1 In-process limits are those written in the master record. 4.2 Each result is "
             "compared with its limit; a result outside the limit stops the step until QA decides. 4.3 Blend samples are "
             "tested by QC for assay and uniformity, and QA releases the blend before compression starts. 4.4 Rejected "
             "granules or tablets are labelled REJECTED and moved to the locked reject cage."),
            ("5. Yield", "Yield is calculated at the end of granulation, compression and coating as a percentage of the "
             "theoretical yield. The operator calculates and records each yield in the batch record."),
        ]),
    "SOP-HR-002 Personnel qualification, training and hygiene (synthetic)": (
        "SOP-HR-002: Personnel qualification, training and hygiene (synthetic)",
        "Version 3   Effective 01-Feb-2026   Department: Human Resources   Site: Chennai",
        [
            ("1. Purpose", "To make sure that people who make, pack, test or store products are qualified and trained "
             "for their work, and that they do not contaminate the product."),
            ("2. Scope", "Applies to all permanent and contract staff in production, packaging, the QC laboratory and the "
             "warehouse at the Chennai site."),
            ("3. Qualification", "3.1 Each job has a written description stating the education and experience it needs, "
             "and new staff are trained before they work alone. 3.2 Supervisors hold a degree in pharmacy or science and "
             "have at least three years in production."),
            ("4. Training", "4.1 Each person is trained in the SOPs of their own job and in GMP as it applies to that job, "
             "and the training is recorded. 4.2 GMP induction training is given by the QA training officer when a "
             "person joins."),
            ("5. Clothing and hygiene", "5.1 Clean factory uniforms are issued every day. 5.2 Hair covers, face masks, "
             "gloves and sleeve covers are worn in the dispensing and compression rooms. 5.3 Staff wash and sanitize "
             "their hands on entry; eating, drinking and smoking are banned in production areas. 5.4 Only staff whose "
             "badge is authorised by the production manager can open the doors of the dispensing and compression rooms."),
            ("6. Health", "Anyone with an open wound on the hands is moved away from open product until it has healed."),
        ]),
    "SOP-QA-008 Production procedures, deviations and reprocessing (synthetic)": (
        "SOP-QA-008: Production procedures, deviations and reprocessing (synthetic)",
        "Version 2   Effective 01-Mar-2026   Department: Quality Assurance   Site: Chennai",
        [
            ("1. Purpose", "To set out how production and process control procedures are written, approved and followed, "
             "how departures from them are handled, and when a batch may be reprocessed."),
            ("2. Scope", "Applies to tablets and capsules made at the Chennai site."),
            ("3. Production procedures", "3.1 Every production and process control step is described in a written "
             "procedure. Together, the production SOPs listed in Annex 1 cover every requirement of 21 CFR 211 Subpart F. "
             "3.2 Each production SOP is written by Production, reviewed by Engineering where equipment is involved, and "
             "approved by QA. Changes follow the same route. 3.3 Operators follow the procedures and complete the batch "
             "record at the end of each shift."),
            ("4. Deviations", "Any departure from a written procedure is recorded on a deviation form with its reason and "
             "QA's assessment."),
            ("5. Reprocessing", "5.1 A batch that fails a specification may be reprocessed only under a written "
             "reprocessing protocol that states the steps to be taken and the tests the reprocessed batch must pass. "
             "5.2 The production manager approves each reprocessing protocol."),
        ]),
}


def make(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for name, (title, line, sections) in SOPS.items():
        doc = pymupdf.open()
        p = doc.new_page(width=595, height=842)
        p.insert_text((50, 60), title, fontsize=13, fontname="hebo")
        p.insert_text((50, 80), line, fontsize=9, fontname="helv", color=(0.4, 0.4, 0.4))
        y = 110
        for head, body in sections:
            p.insert_text((50, y), head, fontsize=11, fontname="hebo")
            h = (len(body) // 92 + 2) * 13
            left = p.insert_textbox(pymupdf.Rect(50, y + 6, 545, y + 6 + h), body, fontsize=10, fontname="helv")
            if left < 0:
                raise RuntimeError(f"{name}: {head} overflows by {-left:.0f} pt")
            y += h + 24
        path = out / f"{name}.pdf"
        doc.save(path, garbage=3, deflate=True)
        print(path)


if __name__ == "__main__":
    make(Path(sys.argv[1]))
