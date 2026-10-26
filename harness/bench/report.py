"""Collect run states + judge/human inputs -> per-run scores, block C8, success rule, review queue (plan §6-§9).

Optional input files under <root>/scores/ (keys: blind alias; checkpoint ids as in project.json):
  human.json                  {alias: {"harness_tamper": bool, "<cp>": {"shortcut", "omission_presented_complete",
                               "stack_violation", "data_loss", "c2_rules_only_in_ui", "c9_unjustified", "c3", "c4",
                               "c2_cap"}}}                         (human review always overrides judges)
  judges/<judge>/<alias>.json {"<cp>": {"c3", "c4", "c2_cap", ...}}  (code-judge.md output, one file per run)
  visual/<judge>/<alias>.json {"<cp>": {"score": 0-5}} or {"<cp>": 0-5}  (visual-judge.md output)
  ux.json                     {alias: {"<ux cp>": usability 0-5}}  (cp k uses the first ux checkpoint >= k)
"""

import json
import random
import statistics
from pathlib import Path

from . import metrics, scoring, stats
from .config import MODELS


def _load(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError):
        return default


def load_inputs(scores_dir):
    d = Path(scores_dir)
    judges, vis = {}, {}
    for sub, target in (("judges", judges), ("visual", vis)):
        for f in sorted((d / sub).glob("*/*.json")):
            target.setdefault(f.stem, {})[f.parent.name] = _load(f, {})
    return {"human": _load(d / "human.json", {}), "judges": judges, "visual": vis, "ux": _load(d / "ux.json", {})}


def _visual_scores(vis_by_judge, cp):
    out = {}
    for judge, data in (vis_by_judge or {}).items():
        if "all" in data:
            raise ValueError(f"visual/{judge}: an 'all' entry is not allowed; judge every checkpoint")
        v = data.get(cp)
        if isinstance(v, dict):
            v = v.get("score")
        if isinstance(v, (int, float)):
            out[judge] = v
    return out


def _ux_for(project, ux_run, cp):
    ux_cps = (project.get("ux") or {}).get("checkpoints") or []
    order = project.cp_ids()
    for u in sorted(ux_cps, key=order.index):
        if order.index(u) >= order.index(cp):
            v = (ux_run or {}).get(u)
            return (float(v), u) if isinstance(v, (int, float)) else (None, u)
    return None, None


def collect_run(st, project, paths, inputs):
    alias = st.get("alias") or st["run_id"]
    human_run = (inputs["human"] or {}).get(alias, {})
    wc = paths.run_dir(st["run_id"]) / "wc"
    r = {"run_id": st["run_id"], "alias": alias, "project": st["project"], "model": st["model"], "arm": st["arm"],
         "rep": st["rep"], "status": st["status"], "status_reason": st.get("status_reason"),
         "suite_sha256": st.get("suite_sha256"), "model_ids": st.get("model_ids", []), "checkpoints": {},
         "c6": st.get("c6"), "maintenance": st.get("maintenance"), "tamper_suspected": st.get("tamper_suspected", []),
         "activation": st.get("activation", [])}
    cum_cost = {"billed": 0.0, "list": 0.0}
    cum_fix, exhausted, prev_final, prev_tag = 0, False, None, "bench-base"
    for cp in project.cp_ids():
        rec = st["checkpoints"].get(cp)
        if not rec or not rec.get("commit"):
            break
        v = rec["validations"][-1]
        attempts = [a for t in rec["turns"] for a in t["attempts"]]
        cp_cost = {"billed": sum(a["billed_usd"] for a in attempts), "list": sum(a["list_estimate_usd"] for a in attempts)}
        cum_cost = {k: cum_cost[k] + cp_cost[k] for k in cum_cost}
        cum_fix += rec["fix_attempts"]
        exhausted = exhausted or rec["final"]["exhausted"]
        passed_reqs = sum(scoring.requirement_rate(v["acceptance"], c)["passed"] for c in scoring.TEST_CRITERIA)
        tag = f"bench-{cp}"
        deps = metrics.deps_added(wc, "bench-base", tag, project.language) if wc.exists() else {"added": [],
                                                                                                "counted": []}
        h = human_run.get(cp) or {}
        jc = scoring.code_judges({j: (d.get(cp) or {}) for j, d in (inputs["judges"].get(alias) or {}).items()
                                  if d.get(cp)}, {k: h[k] for k in ("c3", "c4", "c2_cap") if k in h})
        vis_scores = _visual_scores(inputs["visual"].get(alias), cp)
        checks = ((rec.get("visual") or {}).get("checks") or {})
        c10v = scoring.c10_visual(list(vis_scores.values()), checks.get("passed", 0), checks.get("total", 0))
        ux, ux_cp = _ux_for(project, (inputs["ux"] or {}).get(alias), cp)
        first = rec["validations"][0]
        regress = scoring.regressions(prev_final["acceptance"] + prev_final["hazards"],
                                      first["acceptance"] + first["hazards"]) if prev_final else None
        entry = {
            "commit": rec["commit"], "final_validation": v["label"], "final_ok": v["ok"], "fix_attempts": rec["fix_attempts"],
            "acceptance_tests": v["acceptance"], "hazard_tests": v["hazards"],
            "pr": scoring.protection_retention(v["hazards"]),
            "cost": {"cp_billed_usd": cp_cost["billed"], "cp_list_usd": cp_cost["list"],
                     "cum_billed_usd": cum_cost["billed"], "cum_list_usd": cum_cost["list"]},
            "tokens": {k: sum(a["usage"][k] for a in attempts) for k in ("input", "output", "cache_read",
                                                                         "cache_write", "reasoning")},
            "attempts": len(attempts), "rate_limited_attempts": sum(1 for a in attempts if a.get("rate_limited_until")),
            "wall_s_model": sum(a["wall_s"] for a in attempts), "passed_requirements": passed_reqs,
            "deps": deps, "code": metrics.diff_stats(wc, prev_tag, tag, project.get("generated") or [])
            if wc.exists() else None,
            "change_cost": {"churn_loc_removed": None, "regressions_detected": regress},
            "visual_judges": vis_scores, "visual_checks": checks, "ux_source": ux_cp,
            "inputs": {"booted": v["booted"], "lint_ok": v["lint_ok"], "test_ok": v["test_ok"],
                       "acceptance": v["acceptance"], "hazards": v["hazards"], "cum_fix_attempts": cum_fix,
                       "any_exhausted": exhausted, "c8_ratio": None,
                       "c9_unjustified": h.get("c9_unjustified"), "c9_auto": deps["counted"], "c3c4": jc,
                       "c6": {"rating": (st.get("c6") or {}).get("rating")} if st.get("c6") else None,
                       "c10v": c10v, "c10u": ux, "human": h,
                       "blanket_disables": metrics.blanket_disables(wc, "bench-base", tag) if wc.exists() else []},
        }
        if entry["code"]:
            entry["change_cost"]["churn_loc_removed"] = entry["code"]["loc_removed"]
        r["checkpoints"][cp] = entry
        prev_final, prev_tag = v, tag
    return r


def apply_c8(runs):
    """C8: (cumulative cost / passed requirements) per arm, against the block's 3-arm geometric mean, per checkpoint."""
    blocks = {}
    for r in runs.values():
        blocks.setdefault((r["model"], r["project"], r["rep"]), {})[r["arm"]] = r
    for (model, project, rep), arms_ in blocks.items():
        cps = set.intersection(*(set(r["checkpoints"]) for r in arms_.values())) if arms_ else set()
        basis = "billed" if any(r["checkpoints"][cp]["cost"]["cum_billed_usd"] > 0 for r in arms_.values()
                                for cp in cps) else "list"
        for cp in cps:
            per = {a: scoring.cost_per_requirement(r["checkpoints"][cp]["cost"][f"cum_{basis}_usd"],
                                                   r["checkpoints"][cp]["passed_requirements"])
                   for a, r in arms_.items()}
            ratios = scoring.c8_block_ratios(per) if len(per) == 3 else {a: None for a in per}
            for a, r in arms_.items():
                r["checkpoints"][cp]["inputs"]["c8_ratio"] = ratios[a]
                r["checkpoints"][cp]["cost"]["c8_basis"] = basis
                r["checkpoints"][cp]["cost"]["cost_per_requirement"] = per[a]


def score_runs(states, projects, paths, inputs=None, seed=0, bootstrap_n=10_000):
    inputs = inputs or load_inputs(paths.scores)
    runs, problems = {}, []
    for st in states:
        runs[st["run_id"]] = collect_run(st, projects[st["project"]], paths, inputs)
    apply_c8(runs)
    rows = []
    for rid, r in runs.items():
        p = projects[r["project"]]
        human_run = (inputs["human"] or {}).get(r["alias"], {})
        cps = {}
        for cp, c in r["checkpoints"].items():
            c.update({k: v for k, v in scoring.score_checkpoint(c["inputs"]).items()})
            cps[cp] = c["S"]
        omissions = sum(bool((human_run.get(cp) or {}).get("omission_presented_complete")) for cp in r["checkpoints"])
        r["total"] = scoring.run_total(cps, p.weights, omissions=omissions,
                                       harness_tamper=bool(human_run.get("harness_tamper")))
        r["total"]["pending"] = sorted({k for c in r["checkpoints"].values() for k in c.get("pending", [])})
        for c in r["checkpoints"].values():
            c.pop("inputs", None)
        last = list(r["checkpoints"].values())[-1] if r["checkpoints"] else None
        r["PR_final"] = last["pr"]["pr"] if last else None
        if r["status"] in ("invalid", "harness_failure"):
            problems.append(f"{rid}: {r['status']} ({r['status_reason']}): must be rerun from scratch; excluded")
            continue
        if r["status"] == "stopped":
            problems.append(f"{rid}: stopped ({r['status_reason']}); scored with completed checkpoints, rest = 0")
        if r["status"] in ("done", "stopped"):
            rows.append({"model": r["model"], "project": r["project"], "rep": r["rep"], "arm": r["arm"],
                         "S": r["total"]["S"], "PR": r["PR_final"]})
        if r["tamper_suspected"]:
            problems.append(f"{rid}: transcripts mention protected paths {r['tamper_suspected']} (human: harness_tamper)")
    problems += scoring.check_suite_hashes([{"run_id": k, "project": v["project"], "suite_sha256": v["suite_sha256"]}
                                            for k, v in runs.items()])
    for m in MODELS:
        ids = {i for r in runs.values() if r["model"] == m for i in r["model_ids"]}
        if len(ids) > 1:
            problems.append(f"{m}: model snapshot changed during the study {sorted(ids)}: analyse affected blocks apart")
    success = scoring.success_rule(rows, bootstrap_n=bootstrap_n, seed=seed) if rows else {}
    cells = {}
    for row in rows:
        cells.setdefault(f"{row['model']}/{row['project']}/{row['arm']}", []).append(row["S"])
    return {"runs": runs, "success": success, "problems": problems, "rows": rows,
            "cells": {k: stats.cell_summary(v) for k, v in sorted(cells.items())},
            "agreement": agreement(runs, inputs), "review_queue": review_queue(runs, inputs, seed)}


def agreement(runs, inputs):
    """Judge-judge mean absolute difference and human-vs-judges weighted kappa per judged criterion (plan §8)."""
    out = {}
    for crit in ("c3", "c4"):
        pairs, hj = [], ([], [])
        for r in runs.values():
            js = inputs["judges"].get(r["alias"]) or {}
            hum = (inputs["human"] or {}).get(r["alias"]) or {}
            for cp in r["checkpoints"]:
                vals = [d[cp][crit] for d in js.values() if isinstance((d.get(cp) or {}).get(crit), (int, float))]
                if len(vals) >= 2:
                    pairs.append(abs(vals[0] - vals[1]))
                h = (hum.get(cp) or {}).get(crit)
                if vals and isinstance(h, (int, float)):
                    hj[0].append(h)
                    hj[1].append(statistics.mean(vals))
        out[crit] = {"judge_mean_abs_diff": statistics.mean(pairs) if pairs else None, "n_pairs": len(pairs),
                     "human_vs_judges_weighted_kappa": stats.weighted_kappa(*hj), "n_human": len(hj[0]),
                     "low_confidence": (sum(abs(x - y) >= 1 for x, y in zip(*hj)) / len(hj[0]) > 0.3)
                     if hj[0] else None}
    return out


def review_queue(runs, inputs, seed, max_discrepancies=12):
    rng = random.Random(seed)
    disc = []
    for r in runs.values():
        for cp, c in r["checkpoints"].items():
            jc = (c.get("criteria") or {}).get("C3", {}).get("needs_human") or []
            for k in jc:
                disc.append({"alias": r["alias"], "cp": cp, "item": k})
            vj = list((c.get("visual_judges") or {}).values())
            if len(vj) >= 2 and max(vj) - min(vj) >= scoring.JUDGE_DISAGREEMENT:
                disc.append({"alias": r["alias"], "cp": cp, "item": "c10v"})
    if len(disc) > max_discrepancies:
        disc = rng.sample(disc, max_discrepancies)
    cells = {}
    for r in sorted(runs.values(), key=lambda x: x["run_id"]):
        cells.setdefault((r["model"], r["project"]), []).append(r["alias"])
    sample = [rng.choice(v) for _, v in sorted(cells.items())]
    hz_fail = [{"alias": r["alias"], "arm_hidden": True, "failed": c["pr"]["failed"], "cp": cp}
               for r in runs.values() for cp, c in r["checkpoints"].items() if c["pr"]["failed"]
               and r["arm"] != "base" and cp == list(r["checkpoints"])[-1]]
    base_fail = [{"alias": r["alias"], "failed": c["pr"]["failed"], "cp": cp}
                 for r in runs.values() for cp, c in r["checkpoints"].items() if c["pr"]["failed"]
                 and r["arm"] == "base" and cp == list(r["checkpoints"])[-1]]
    base_fail = rng.sample(base_fail, min(len(base_fail), len(hz_fail)))
    deps = [{"alias": r["alias"], "cp": cp, "deps": c["deps"]["added"]} for r in runs.values()
            for cp, c in r["checkpoints"].items() if c["deps"]["added"]]
    return {"discrepancies": disc, "agreement_sample": sample, "hazard_failures": hz_fail + base_fail,
            "dependencies": deps}


def table(scored):
    lines = [f"{'alias':<8}{'run':<36}{'status':<10}{'S':>7}{'PR':>7}{'cost$':>9}  pending"]
    for rid, r in sorted(scored["runs"].items()):
        last = list(r["checkpoints"].values())[-1] if r["checkpoints"] else None
        cost = last["cost"]["cum_billed_usd"] or last["cost"]["cum_list_usd"] if last else 0
        pr = "-" if r.get("PR_final") is None else f"{r['PR_final']:.1f}"
        s = r.get("total", {}).get("S")
        lines.append(f"{r['alias']:<8}{rid:<36}{r['status']:<10}{'-' if s is None else f'{s:.1f}':>7}{pr:>7}"
                     f"{cost:>9.2f}  {','.join(r.get('total', {}).get('pending', [])) or '-'}")
    for m, s in scored["success"].items():
        lines.append(f"{m}: {s['verdict']}  median Δ vs base {s['median_delta_vs_base']}  vs placebo "
                     f"{s['median_delta_vs_placebo']}  PR Δ {s['median_pr_delta']}  "
                     f"p(base)={s['permutation']['vs_base'].get('p')} p(placebo)={s['permutation']['vs_placebo'].get('p')}")
    return "\n".join(lines)
