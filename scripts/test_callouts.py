#!/usr/bin/env python3
"""Score the callout reader (worker/app/parse/callouts.py) on figures with known labels, and list what it reads
in the real figures of the benchmark documents, where nothing should be read unless a label is there.

    cd worker && .venv/bin/python ../scripts/callout_testset.py && .venv/bin/python ../scripts/test_callouts.py [--real]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))
from app.parse.callouts import read_callouts  # noqa: E402

SET = ROOT / "scripts" / "benchmarks" / "callouts"


def synthetic() -> None:
    expected = json.loads((SET / "expected.json").read_text())
    tp = fp = fn = 0
    for name, want in expected.items():
        t0 = time.time()
        got = read_callouts((SET / f"{name}.png").read_bytes())
        ms = (time.time() - t0) * 1000
        labels = [c.label for c in got]
        hit, extra, miss = set(labels) & set(want), set(labels) - set(want), set(want) - set(labels)
        tp, fp, fn = tp + len(hit), fp + len(extra), fn + len(miss)
        flag = "ok " if not extra and not miss else "!! "
        print(f"{flag}{name:24} want {','.join(want) or '-':12} got {','.join(labels) or '-':14} "
              f"{'missed ' + ','.join(sorted(miss)) if miss else ''} {'extra ' + ','.join(sorted(extra)) if extra else ''}  {ms:5.0f} ms")
    print(f"\nlabels found {tp} of {tp + fn} ({tp / max(1, tp + fn):.0%}); wrong labels {fp}")


def real(names: list[str]) -> None:
    import pymupdf
    from app.parse.layout import parse_document
    from app.parse.model import FigureBlock
    for path in names:
        doc = pymupdf.open(path)
        t0 = time.time()
        figs = [b for lay in parse_document(doc) for b in lay.blocks if isinstance(b, FigureBlock)]
        reads = [(f.page, f.caption, [c.label for c in read_callouts(f.image_png)]) for f in figs]
        n = sum(1 for r in reads if r[2])
        print(f"\n{Path(path).name}: {len(figs)} figures, labels read in {n}, {time.time() - t0:.0f}s")
        for page, cap, labels in reads:
            if labels:
                print(f"   p{page:<4} {labels}  {(cap or '')[:60]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--real", nargs="*", help="PDFs whose figures to read")
    a = ap.parse_args()
    synthetic()
    if a.real:
        real(a.real)
