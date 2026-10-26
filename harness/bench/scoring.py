"""Pure scoring functions (plan §6-§8; RUBRIC.md of round 1 with the round-2 method changes).

S_k = sum_c W_c * rating_{c,k} / 5 (0..100) per checkpoint; run S = sum_k w_k * S_k / 100 (missing checkpoints = 0,
e.g. after a stop-loss). Hazard tests never enter C1/C2: they feed protection retention (PR), reported separately and
used by success condition 3. Maintenance metrics are reported separately too.
"""

import math
import re
import statistics

from . import stats

WEIGHTS = {"C1": 29, "C2": 17, "C3": 11, "C4": 7, "C5": 6, "C6": 7, "C7": 5, "C8": 6, "C9": 3, "C10v": 5, "C10u": 4}
GROUPS = {"correctness": ["C1", "C2", "C5"], "quality": ["C3", "C4", "C10v", "C10u"], "economy": ["C8", "C9"],
          "process": ["C6", "C7"]}
TEST_CRITERIA = ("C1", "C2", "C5")
C7_MAX_ATTEMPTS = 15
JUDGE_DISAGREEMENT = 1.5
SUCCESS_DELTA = 3.0
HAZARD_TAG = re.compile(r"\[H:([^:\]]+):([123])\]")
VERDICTS = {"all": "effective", "no_placebo": "effect not attributable to the minimalist content",
            "no_pr": "improvement with protection loss", "none": "no demonstrated effect"}


def lerp(x, x0, y0, x1, y1):
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0)


# ---------------------------------------------------------------- anchors (round 1, unchanged)
def rate_pass(rate):
    if rate < 0.4:
        return 0.0
    return lerp(rate, 0.4, 0, 0.8, 3) if rate <= 0.8 else lerp(rate, 0.8, 3, 1.0, 5)


def rate_c7(attempts, exhausted):
    if exhausted:
        return 0.0
    if attempts <= 3.5:
        return lerp(attempts, 0, 5, 3.5, 3)
    return max(0.0, lerp(attempts, 3.5, 3, C7_MAX_ATTEMPTS, 0))


def rate_c8(ratio):
    if ratio <= 0.6:
        return 5.0
    if ratio <= 1.0:
        return lerp(math.log(ratio), math.log(0.6), 5, 0.0, 3)
    if ratio < 1.6:
        return lerp(math.log(ratio), 0.0, 3, math.log(1.6), 0)
    return 0.0


def rate_c9(unjustified):
    if unjustified <= 1.5:
        return lerp(unjustified, 0, 5, 1.5, 3)
    return max(0.0, lerp(unjustified, 1.5, 3, 4, 0))


def rate_c6(caught, total):
    k = 4 * caught / total if total else 0
    return lerp(k, 0, 0, 2, 3) if k <= 2 else lerp(k, 2, 3, 4, 5)


# ---------------------------------------------------------------- tests -> requirement pass rates
def test_criterion(t):
    c = t.get("criterion")
    if c in TEST_CRITERIA:
        return c
    return t.get("category") if t.get("category") in TEST_CRITERIA else "C1"


def passed(t):
    return t.get("status") in ("pass", "passed")


def requirement_rate(tests, criterion):
    reqs = {}
    for t in tests:
        if test_criterion(t) != criterion:
            continue
        r = t.get("requirement") or t.get("id")
        reqs[r] = reqs.get(r, True) and passed(t)
    ok = sum(reqs.values())
    return {"passed": ok, "total": len(reqs), "rate": ok / len(reqs) if reqs else None,
            "failed": sorted(r for r, v in reqs.items() if not v)}


def hazard_severity(t):
    s = t.get("severity")
    if s in (1, 2, 3):
        return s
    m = HAZARD_TAG.search(str(t.get("id", "")) + " " + str(t.get("title", "")))
    if m:
        return int(m.group(2))
    raise ValueError(f"hazard test {t.get('id')!r} has no severity (field or [H:<category>:<1-3>] tag)")


def hazard_category(t):
    if t.get("category"):
        return t["category"]
    m = HAZARD_TAG.search(str(t.get("id", "")))
    return m.group(1) if m else "uncategorized"


def protection_retention(hazards):
    if not hazards:
        return {"pr": None, "by_category": {}, "passed": 0, "total": 0, "failed": []}
    num = den = 0
    cats = {}
    for t in hazards:
        s, c, ok = hazard_severity(t), hazard_category(t), passed(t)
        num, den = num + s * ok, den + s
        cn, cd = cats.get(c, (0, 0))
        cats[c] = (cn + s * ok, cd + s)
    return {"pr": 100 * num / den, "by_category": {c: 100 * n / d for c, (n, d) in sorted(cats.items())},
            "passed": sum(passed(t) for t in hazards), "total": len(hazards),
            "failed": [t.get("id") for t in hazards if not passed(t)]}


def regressions(before, after):
    ok_before = {t["id"] for t in before if passed(t)}
    now = {t["id"]: passed(t) for t in after}
    ids = sorted(i for i in ok_before if i in now and not now[i])
    return {"ids": ids, "count": len(ids), "rate": len(ids) / len(ok_before) if ok_before else 0.0}


# ---------------------------------------------------------------- per-checkpoint score
def crit(key, rating, status="scored", **detail):
    if rating is None:
        return {"status": status if status != "scored" else "pending", "weight": WEIGHTS[key], **detail}
    rating = max(0.0, min(5.0, float(rating)))
    return {"status": status, "rating": round(rating, 4), "weight": WEIGHTS[key],
            "points": round(WEIGHTS[key] * rating / 5, 4), **detail}


def score_checkpoint(inp):
    acc, h = inp.get("acceptance") or [], inp.get("human") or {}
    jc = inp.get("c3c4") or {}
    cs, caps, flags = {}, [], []
    rates = {c: requirement_rate(acc, c) for c in TEST_CRITERIA}
    for k in ("C1", "C5"):
        r = rates[k]
        cs[k] = crit(k, rate_pass(r["rate"]), **r) if r["rate"] is not None else crit(k, None, "n/a", **r)

    r2 = rates["C2"]
    failed_c2 = [t for t in acc if test_criterion(t) == "C2" and not passed(t)]
    gate_hits = sorted({t.get("gate") for t in failed_c2 if t.get("gate") in ("race", "authz", "data_loss")})
    notes = []
    if r2["rate"] is None:
        cs["C2"] = crit("C2", None, "n/a", **r2)
    else:
        c2 = rate_pass(r2["rate"])
        if r2["failed"]:
            c2 = min(c2, 3)
        cap2 = h.get("c2_cap", jc.get("c2_cap"))
        if cap2 is not None:
            c2 = min(c2, cap2)
            notes.append(f"invariant ownership cap {cap2}")
        else:
            notes.append("invariant ownership unverified (judges pending)")
        if gate_hits or h.get("data_loss"):
            c2 = 0.0
            caps.append((40, f"authorization bypass / race / data loss: {gate_hits or ['human: data_loss']}"))
        if h.get("c2_rules_only_in_ui"):
            c2 = 0.0
        cs["C2"] = crit("C2", c2, gates_failed=gate_hits, notes=notes, **r2)

    c3 = jc.get("c3")
    if c3 is not None and h.get("shortcut"):
        c3 = min(c3, 2)
    cs["C3"] = crit("C3", c3, shortcut=bool(h.get("shortcut")), needs_human=jc.get("needs_human", []))
    cs["C4"] = crit("C4", jc.get("c4"))
    c6 = inp.get("c6") or {}
    cs["C6"] = crit("C6", c6.get("rating"), **{k: v for k, v in c6.items() if k != "rating"})
    cs["C7"] = crit("C7", rate_c7(inp.get("cum_fix_attempts", 0), inp.get("any_exhausted", False)),
                    cumulative_fix_attempts=inp.get("cum_fix_attempts", 0), exhausted=inp.get("any_exhausted", False))
    ratio = inp.get("c8_ratio")
    c1_rate = rates["C1"]["rate"]
    if ratio is None:
        cs["C8"] = crit("C8", None, reason="block geomean unavailable (missing arm or cost)")
    else:
        low = c1_rate is not None and c1_rate < 0.6
        cs["C8"] = crit("C8", 0.0 if low else rate_c8(ratio), ratio=round(ratio, 4), zeroed_c1_below_60=low)
    n9 = inp.get("c9_unjustified")
    cs["C9"] = crit("C9", rate_c9(n9) if n9 is not None else None, unjustified=n9, auto_counted=inp.get("c9_auto", []),
                    source="human review" if n9 is not None else "pending human review")
    cs["C10v"] = crit("C10v", inp.get("c10v"))
    cs["C10u"] = crit("C10u", inp.get("c10u"))

    auth = [t for t in acc if t.get("gate") == "auth"]
    if inp.get("booted") is False:
        caps.append((20, "app does not boot"))
    elif auth and not any(passed(t) for t in auth):
        caps.append((20, "no authenticated flow works"))
    if inp.get("lint_ok") is False or inp.get("test_ok") is False:
        caps.append((60, "lint / own tests red"))
    if inp.get("blanket_disables"):
        caps.append((60, "blanket lint/type disable added"))
    zero = bool(h.get("stack_violation"))
    if zero:
        flags.append("fixed-stack violation (human): checkpoint = 0")

    na_w = sum(v["weight"] for v in cs.values() if v["status"] == "n/a")
    scale = 100 / (100 - na_w) if na_w < 100 else 0
    earned = sum(v.get("points", 0) for v in cs.values()) * scale
    avail = [v for v in cs.values() if v["status"] not in ("pending", "n/a")]
    avail_w = sum(v["weight"] for v in avail)
    norm = 100 * sum(v["points"] for v in avail) / avail_w if avail_w else None
    cap = 0 if zero else min([c for c, _ in caps], default=100)
    return {"criteria": cs, "caps": [{"cap": c, "reason": r} for c, r in caps], "flags": flags,
            "S": round(min(earned, cap), 4), "normalized": round(min(norm, cap), 4) if norm is not None else None,
            "pending": sorted(k for k, v in cs.items() if v["status"] == "pending"),
            "not_applicable": sorted(k for k, v in cs.items() if v["status"] == "n/a")}


def run_total(cp_scores, weights, omissions=0, harness_tamper=False):
    if sum(weights.values()) != 100:
        raise ValueError(f"checkpoint weights must sum to 100, got {sum(weights.values())}")
    unknown = set(cp_scores) - set(weights)
    if unknown:
        raise ValueError(f"unknown checkpoints {sorted(unknown)}")
    s = sum(w * (cp_scores.get(k) or 0) for k, w in weights.items()) / 100
    s = 0.0 if harness_tamper else max(0.0, s - 5 * omissions)
    return {"S": round(s, 4), "checkpoints_scored": sorted(k for k in cp_scores if cp_scores[k] is not None),
            "checkpoints_missing": sorted(k for k in weights if cp_scores.get(k) is None),
            "omission_penalty": 5 * omissions, "harness_tamper": harness_tamper}


# ---------------------------------------------------------------- C8, C10, C6, C3/C4
def cost_per_requirement(cost_usd, passed_requirements):
    return cost_usd / passed_requirements if passed_requirements else None


def c8_block_ratios(per_arm):
    vals = list(per_arm.values())
    if any(v is None or v <= 0 for v in vals):
        return {a: None for a in per_arm}
    gm = math.exp(sum(math.log(v) for v in vals) / len(vals))
    return {a: v / gm for a, v in per_arm.items()}


def visual_for_checkpoint(visual_run, cp):
    if "all" in (visual_run or {}):
        raise ValueError("visual judgments must be per checkpoint; an 'all' entry would copy one score to every cp")
    v = (visual_run or {}).get(cp) or {}
    return [x for x in v.values() if isinstance(x, (int, float))]


def c10_visual(judge_scores, passed, total):
    if not judge_scores or not total:
        return None
    return 3 * statistics.mean(judge_scores) / 5 + 2 * passed / total


def c6_from_mutations(mutations, baseline_ok=True):
    valid = [m for m in mutations if (m.get("hidden_failed") or 0) > 0]
    caught = [m for m in valid if m.get("own_failed")]
    rating = None
    if valid:
        rating = rate_c6(len(caught), len(valid)) if baseline_ok else 0.0
    return {"valid": len(valid), "caught": len(caught), "rating": rating, "baseline_ok": baseline_ok,
            "discarded": [m["id"] for m in mutations if m not in valid],
            "survived": [m["id"] for m in valid if m not in caught]}


def code_judges(judges, human=None):
    human = human or {}
    if not judges and not human:
        return None
    out, needs, source = {}, [], {}
    for k in ("c3", "c4"):
        vals = [j[k] for j in judges.values() if isinstance(j.get(k), (int, float))]
        if vals:
            out[k] = statistics.mean(vals)
            source[k] = "judges"
            if max(vals) - min(vals) >= JUDGE_DISAGREEMENT:
                needs.append(k)
    caps = [j["c2_cap"] for j in judges.values() if isinstance(j.get("c2_cap"), (int, float))]
    if caps:
        out["c2_cap"], source["c2_cap"] = min(caps), "judges"
    for k in ("c3", "c4", "c2_cap"):
        if k in human:
            out[k], source[k] = human[k], "human"
    out["needs_human"] = [k for k in needs if source.get(k) != "human"]
    out["source"] = source
    return out


def maintenance_metric(m_pass, m_regression, m_cost):
    if not m_cost or m_cost <= 0:
        return None
    return m_pass * (1 - m_regression) / m_cost


# ---------------------------------------------------------------- success rule (§7) and statistics (§8)
def _median(xs):
    return statistics.median(xs) if xs else None


def success_rule(rows, bootstrap_n=10_000, seed=0):
    by_model = {}
    for r in rows:
        by_model.setdefault(r["model"], {}).setdefault((r["project"], r["rep"]), {})[r["arm"]] = r
    out, perms = {}, {"vs_base": [], "vs_placebo": []}
    for model, blocks in sorted(by_model.items()):
        res = {"incomplete_blocks": sorted(f"{p}-r{rep}" for (p, rep), a in blocks.items()
                                           if set(a) != {"base", "ponytail", "placebo"})}
        diffs = {"vs_base": {}, "vs_placebo": {}, "pr": {}}
        for (p, rep), a in blocks.items():
            pony = a.get("ponytail")
            if not pony or pony.get("S") is None:
                continue
            for key, other in (("vs_base", "base"), ("vs_placebo", "placebo")):
                o = a.get(other)
                if o and o.get("S") is not None:
                    diffs[key][(p, rep)] = pony["S"] - o["S"]
            b = a.get("base")
            if b and pony.get("PR") is not None and b.get("PR") is not None:
                diffs["pr"][(p, rep)] = (pony["PR"], b["PR"])
        reps = sorted({rep for (_, rep) in blocks})
        per_rep = {}
        for key in ("vs_base", "vs_placebo"):
            per_rep[key] = [statistics.mean(v for (p, r), v in diffs[key].items() if r == rep)
                            for rep in reps if any(r == rep for (_, r) in diffs[key])]
        per_rep["pr"] = [statistics.mean(x for (p, r), (x, _) in diffs["pr"].items() if r == rep)
                         - statistics.mean(y for (p, r), (_, y) in diffs["pr"].items() if r == rep)
                         for rep in reps if any(r == rep for (_, r) in diffs["pr"])]
        m1, m2, m3 = _median(per_rep["vs_base"]), _median(per_rep["vs_placebo"]), _median(per_rep["pr"])
        c1 = m1 is not None and m1 >= SUCCESS_DELTA
        c2 = m2 is not None and m2 >= SUCCESS_DELTA
        c3 = m3 is not None and m3 >= 0
        verdict = VERDICTS["all"] if c1 and c2 and c3 else VERDICTS["no_placebo"] if c1 and c3 and not c2 else \
            VERDICTS["no_pr"] if c1 and c2 and not c3 else VERDICTS["none"]
        res.update({"delta_by_rep_vs_base": per_rep["vs_base"], "delta_by_rep_vs_placebo": per_rep["vs_placebo"],
                    "pr_delta_by_rep": per_rep["pr"], "median_delta_vs_base": m1, "median_delta_vs_placebo": m2,
                    "median_pr_delta": m3, "conditions": {"1_vs_base": c1, "2_vs_placebo": c2, "3_pr": c3},
                    "verdict": verdict, "permutation": {}, "bootstrap": {}, "per_project": {}})
        for key in ("vs_base", "vs_placebo"):
            d = diffs[key]
            if d:
                pt = stats.sign_flip_test([d[k] for k in sorted(d)])
                res["permutation"][key] = pt
                perms[key].append((model, pt))
                strat = {}
                for (p, _), v in sorted(d.items()):
                    strat.setdefault(p, []).append(v)
                res["bootstrap"][key] = stats.stratified_bootstrap(strat, n=bootstrap_n, seed=seed)
                res["per_project"][key] = {p: {**stats.cell_summary(v), "descriptive_only": True}
                                           for p, v in strat.items()}
            else:
                res["permutation"][key] = {"p": None, "n_blocks": 0, "n_permutations": 0}
        out[model] = res
    for key, items in perms.items():
        adj = stats.holm([pt["p"] for _, pt in items])
        for (model, pt), pa in zip(items, adj):
            pt["p_holm"] = pa
    return out


def check_suite_hashes(records):
    seen = {}
    for r in records:
        seen.setdefault(r["project"], {}).setdefault(r.get("suite_sha256"), []).append(r["run_id"])
    return [f"{p}: hidden suite hash differs across runs {sorted(h)}: never mix suite versions"
            for p, h in seen.items() if len(h) > 1]
