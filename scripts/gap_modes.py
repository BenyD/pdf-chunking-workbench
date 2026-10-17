#!/usr/bin/env python3
"""The SOP check run four ways on the same SOPs: what each decides, gets right, leaves for a person, and costs.

    cd worker
    .venv/bin/python ../scripts/gap_modes.py              # verdicts from the cache; the batch API for any missing
    .venv/bin/python ../scripts/gap_modes.py --cached     # never call a model: a line with no cached verdict stays unsure
    .venv/bin/python ../scripts/gap_modes.py --cached --publish   # also write the summary the SOP check page shows

    rules        no AI, no API: local model for scope and evidence, rules judge
    cascade      the same, then Claude Haiku through the Batch API only on the lines the rules leave unsure
    local+model  local scope and evidence, Haiku on every line (to see what the local evidence costs Haiku)
    current      voyage-4 scope and evidence, Haiku on every line (sections 24 and 25 of DECISIONS)

Graded against the sample SOP's known answers (gap_check.EXPECTED) and three SOPs written after the rules were
first frozen (scripts/benchmarks/gap-heldout.json; samples/generate/make_gap_heldout.py makes their PDFs). A
section a mode does not pick leaves its lines unchecked, and an unchecked line counts as not right. The other
SOPs have no written answers: they count toward lines, cost and what is left for a person. Writes
scripts/benchmarks/gap-modes.json, and with --publish the summary alone to web/src/data/gap-modes.json.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "worker"))

import gap_check as g  # noqa: E402
from app.llm import local  # noqa: E402

HELDOUT = ROOT / "scripts" / "benchmarks" / "gap-heldout.json"
OUT = ROOT / "scripts" / "benchmarks" / "gap-modes.json"
WEB_OUT = ROOT / "web" / "src" / "data" / "gap-modes.json"
MODEL = "claude-haiku-5-5"
VOYAGE_PRICE = 0.06                 # $ per million tokens, read 2026-10-15
SOPS = [g.SAMPLE, "SOP-PR-021", "SOP-PK-009", "SOP-QA-012", "SOP-QA-020", "SOP-QA-031", "SOP-WH-004",
        "SOP-QC-020", "SOP-QC-025", "SOP-QA-040", "SOP-PR-030", "SOP-PR-015", "SOP-HR-002", "SOP-QA-008"]
MODES = [("rules", g.LOCAL, "rules"), ("cascade", g.LOCAL, "cascade"), ("local+model", g.LOCAL, "model"), ("current", g.API, "model")]
ASK_ABOVE = 0.50                    # dollars: a run that would cost more stops and asks for --yes


def truth() -> dict[str, dict[str, str]]:
    held = json.loads(HELDOUT.read_text())
    return {g.SAMPLE: g.EXPECTED, **{name: e["lines"] for name, e in held.items() if not name.startswith("_")}}


def group(stem: str) -> str:
    return "sample" if stem == g.SAMPLE else "held out" if stem in truth() else "others"


def lines_for(mode: str, vec: g.Vectors, judge: str, cache: g.Cache, cached_only: bool, yes: bool) -> list[dict]:
    """Every SOP's lines in this mode, each with its final verdict and what that verdict cost at batch price."""
    reqs = g.units(g.read_part())
    vectors = cache.embed([f"{r.section_title}. {r.text}" for r in reqs], "query", vec)
    with g._conn() as c:
        sops = [g.prepare(c, cache, n, reqs, vectors, None, vec, MODEL, vec.scope_line) for n in SOPS]
    lines = [x for s in sops for x in s["lines"]]
    ask = [x for x in lines if not g.by_rules(x, judge)]
    known = cache.verdicts(sorted({x.key for x in ask}))
    todo = list({x.key: x for x in ask if x.key not in known}.values())
    if todo and not cached_only:
        guess = len(todo) * 0.0001
        if guess > ASK_ABOVE and not yes:
            raise SystemExit(f"{mode}: {len(todo)} lines to judge, about ${guess:.2f}; run again with --yes to spend it")
        print(f"{mode}: {len(todo)} lines not in the cache, sent as one batch")
        g.judge_in_batches(cache, todo)
        known = cache.verdicts(sorted({x.key for x in ask}))
    out = []
    for s in sops:
        for x in s["lines"]:
            if x.source != "rules":
                k = known.get(x.key)
                x.verdict = k["verdict"] if k else {"status": "unsure", "quote": "", "reason": "No verdict in the cache."}
                x.tokens = (k["in"], k["out"]) if k else (0, 0)
                x.source = "model" if k else "none"
            out.append({"sop": s["stem"], "cite": x.req.cite, "status": x.verdict["status"],
                        "by": x.source, "rules": x.rules["status"],
                        "dollars": g.dollars(MODEL, *x.tokens, "batch") if x.source == "model" else 0.0})
    return out


def summarise(rows: list[dict], answers: dict[str, dict[str, str]]) -> dict:
    """Per group of SOPs: lines, who decided them, what is left for a person, and, where the answers are known,
    how many are right, how many known gaps are shown, how many are missed (shown as met or not applicable), and
    how many false gaps a reviewer would have to dismiss (met or not applicable lines shown as gaps)."""
    out: dict[str, dict] = {}
    for grp in ("sample", "held out", "others", "all"):
        mine = [x for x in rows if grp == "all" or group(x["sop"]) == grp]
        stems = sorted({x["sop"] for x in mine})
        d = {"sops": len(stems), "lines": len(mine),
             "by_rules": sum(1 for x in mine if x["by"] == "rules" and x["status"] != "unsure"),
             "by_model": sum(1 for x in mine if x["by"] == "model" and x["status"] != "unsure"),
             "unsure": sum(1 for x in mine if x["status"] == "unsure"),
             "dollars": round(sum(x["dollars"] for x in mine), 5)}
        d["dollars_per_sop"] = round(d["dollars"] / max(1, len(stems)), 6)
        graded = [(stem, cite, want) for stem in stems if stem in answers for cite, want in answers[stem].items()]
        if graded:
            got = {(x["sop"], x["cite"]): x for x in mine}
            right = decided = gaps_shown = unchecked = missed = false_gaps = 0
            for stem, cite, want in graded:
                x = got.get((stem, cite))
                if x is None:
                    unchecked += 1
                    continue
                if x["status"] != "unsure":
                    decided += 1
                    right += g.right(x["status"], want, x["by"] == "rules")
                gap, shown = want in ("not_met", "partly_met"), x["status"] in ("not_met", "partly_met")
                gaps_shown += gap and shown
                missed += gap and x["status"] in ("met", "not_applicable")
                false_gaps += not gap and shown
            d.update({"graded": len(graded), "decided": decided, "right": right, "unchecked": unchecked,
                      "left_for_person": len(graded) - decided,
                      "gaps": sum(1 for _, _, w in graded if w in ("not_met", "partly_met")), "gaps_shown": gaps_shown,
                      "gaps_missed": missed, "false_gaps": false_gaps})
        out[grp] = d
    return out


def local_seconds_per_sop() -> float:
    """CPU time to embed one SOP's passages with the local model, the only step of the no-AI check that is not
    instant once the SOP is stored (the rules and the scoring take milliseconds)."""
    with g._conn() as c:
        texts = [t for n in SOPS for (t,) in c.execute(
            "select raw_text from chunks where document_id = %s and strategy = 'structural' and chunk_type <> 'table_row'",
            (g.find_sop(c, n)[0],))]
    local.embed_passages(texts[:4])                      # load the model first
    t0 = time.perf_counter()
    local.embed_passages(texts)
    return (time.perf_counter() - t0) / len(SOPS)


def voyage_dollars_per_sop() -> float:
    with g._conn() as c:
        tokens = sum(c.execute("select coalesce(sum(token_count), 0) from chunks where document_id = %s and strategy = 'contextual'",
                               (g.find_sop(c, n)[0],)).fetchone()[0] for n in SOPS)
    return tokens / len(SOPS) * VOYAGE_PRICE / 1e6


def main(cached_only: bool, yes: bool, publish: bool) -> None:
    cache = g.Cache()
    answers = truth()
    report = {"sops": SOPS, "model": MODEL, "price": "batch", "modes": {}}
    for mode, vec, judge in MODES:
        rows = lines_for(mode, vec, judge, cache, cached_only, yes)
        report["modes"][mode] = {"vectors": vec.model, "judge": judge, "scope_line": vec.scope_line,
                                 "summary": summarise(rows, answers), "rows": rows}
    secs, voy = local_seconds_per_sop(), voyage_dollars_per_sop()
    report["local_seconds_per_sop"], report["voyage_dollars_per_sop"] = round(secs, 3), round(voy, 7)

    print(f"\n{'mode':12} {'group':9} {'lines':>5} {'rules':>5} {'model':>5} {'unsure':>6} {'right':>7} {'gaps shown':>10} {'missed':>6} "
          f"{'false':>5} {'$ per SOP':>10} {'5,000 SOPs':>10}")
    for mode, m in report["modes"].items():
        for grp in ("sample", "held out", "others", "all"):
            d = m["summary"][grp]
            per = d["dollars_per_sop"] + (voy if mode == "current" else 0.0)
            right = f"{d['right']}/{d['graded']}" if "graded" in d else ""
            gaps = f"{d['gaps_shown']}/{d['gaps']}" if "graded" in d else ""
            missed, false = (str(d["gaps_missed"]), str(d["false_gaps"])) if "graded" in d else ("", "")
            print(f"{mode:12} {grp:9} {d['lines']:5} {d['by_rules']:5} {d['by_model']:5} {d['unsure']:6} {right:>7} {gaps:>10} {missed:>6} {false:>5}"
                  f" {per:10.5f} {per * 5000:10.2f}")
            d["dollars_per_sop_with_embeddings"] = round(per, 6)
    print(f"\nlocal model: {secs:.2f} s of CPU per SOP to embed its passages ({secs * 5000 / 3600:.1f} h for 5,000 on this laptop); "
          f"voyage-4 for the same passages: ${voy:.6f} per SOP")
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}")
    if publish:
        keep = ("graded", "decided", "right", "gaps", "gaps_shown", "unsure", "sops", "lines")
        page = {"model": MODEL, "sops": len(SOPS), "modes": {
            mode: {**{grp: {k: m["summary"][grp][k] for k in keep if k in m["summary"][grp]} for grp in ("sample", "held out", "all")},
                   "dollars_per_sop": m["summary"]["all"]["dollars_per_sop_with_embeddings"]}
            for mode, m in report["modes"].items()}}
        WEB_OUT.write_text(json.dumps(page, indent=2) + "\n")
        print(f"wrote {WEB_OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cached", action="store_true", help="never call a model; a line with no cached verdict stays unsure")
    ap.add_argument("--yes", action="store_true", help=f"spend more than ${ASK_ABOVE:.2f} on model calls if a run needs it")
    ap.add_argument("--publish", action="store_true", help=f"also write the summary to {WEB_OUT.relative_to(ROOT)}, which the SOP check page shows")
    a = ap.parse_args()
    main(a.cached, a.yes, a.publish)
