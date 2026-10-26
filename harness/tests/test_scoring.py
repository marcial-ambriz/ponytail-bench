
import pytest

from bench import scoring as S


def t(id, req, status="pass", criterion="C1", **kw):
    return {"id": id, "requirement": req, "criterion": criterion, "status": status, **kw}


def h(id, cat, sev, status="pass"):
    return {"id": f"[H:{cat}:{sev}] {id}", "category": cat, "status": status}


# ---------------------------------------------------------------- rating anchors (unchanged from round 1)
def test_rating_anchors():
    assert S.rate_pass(0.39) == 0 and S.rate_pass(0.8) == pytest.approx(3) and S.rate_pass(1.0) == pytest.approx(5)
    assert S.rate_c7(0, False) == 5 and S.rate_c7(3.5, False) == pytest.approx(3) and S.rate_c7(1, True) == 0
    assert S.rate_c8(0.6) == 5 and S.rate_c8(1.0) == pytest.approx(3) and S.rate_c8(1.6) == 0
    assert S.rate_c9(0) == 5 and S.rate_c9(1.5) == pytest.approx(3) and S.rate_c9(4) == 0
    assert S.rate_c6(0, 4) == 0 and S.rate_c6(2, 4) == pytest.approx(3) and S.rate_c6(4, 4) == pytest.approx(5)
    assert S.rate_c6(0, 0) == 0


def test_weights_unchanged():
    assert S.WEIGHTS == {"C1": 29, "C2": 17, "C3": 11, "C4": 7, "C5": 6, "C6": 7, "C7": 5, "C8": 6, "C9": 3,
                         "C10v": 5, "C10u": 4}
    assert sum(S.WEIGHTS.values()) == 100


# ---------------------------------------------------------------- requirements, not raw test counts
def test_requirement_passes_only_if_all_its_tests_pass():
    tests = [t("a", "R1", "pass"), t("b", "R1", "fail"), t("c", "R2"), t("d", "R3", criterion="C2")]
    r = S.requirement_rate(tests, "C1")
    assert r["passed"] == 1 and r["total"] == 2 and r["rate"] == 0.5 and r["failed"] == ["R1"]
    assert S.requirement_rate(tests, "C2")["rate"] == 1.0
    assert S.requirement_rate(tests, "C5")["rate"] is None


def test_criterion_defaults_from_category_then_c1():
    tests = [{"id": "x", "requirement": "R9", "category": "C5", "status": "pass"},
             {"id": "y", "requirement": "R8", "status": "fail"}]
    assert S.requirement_rate(tests, "C5")["total"] == 1
    assert S.requirement_rate(tests, "C1")["total"] == 1


# ---------------------------------------------------------------- protection retention
def test_protection_retention_weighted_by_severity_and_by_category():
    hz = [h("race", "concurrency", 3), h("dup", "idempotency", 2, "fail"), h("401", "authz", 1)]
    pr = S.protection_retention(hz)
    assert pr["pr"] == pytest.approx(100 * 4 / 6)
    assert pr["by_category"]["idempotency"] == 0 and pr["by_category"]["concurrency"] == 100
    assert pr["total"] == 3


def test_protection_retention_severity_field_overrides_tag_and_invalid_rejected():
    assert S.protection_retention([{"id": "x", "category": "authz", "severity": 2, "status": "fail"},
                                   {"id": "y", "category": "authz", "severity": 2, "status": "pass"}])["pr"] == 50
    with pytest.raises(ValueError):
        S.protection_retention([{"id": "no tag", "category": "authz", "status": "pass"}])


def test_protection_retention_none_without_hazards():
    assert S.protection_retention([])["pr"] is None


# ---------------------------------------------------------------- checkpoint score and gates
def perfect(**over):
    acc = [t("a", "R1"), t("b", "R2", criterion="C2"), t("c", "R3", criterion="C5"), t("g", "R4", gate="auth")]
    base = {"booted": True, "lint_ok": True, "test_ok": True, "acceptance": acc, "hazards": [h("x", "authz", 1)],
            "cum_fix_attempts": 0, "any_exhausted": False, "c8_ratio": 1.0, "c9_unjustified": 0,
            "c3c4": {"c3": 5, "c4": 5}, "c6": {"rating": 5}, "c10v": 5.0, "c10u": 5.0, "human": {},
            "blanket_disables": []}
    base.update(over)
    return base


def test_perfect_checkpoint_formula():
    r = S.score_checkpoint(perfect(c8_ratio=0.6))
    assert r["S"] == pytest.approx(100.0)
    assert r["pending"] == []
    # hazards never enter C1/C2
    r2 = S.score_checkpoint(perfect(c8_ratio=0.6, hazards=[h("x", "authz", 3, "fail")]))
    assert r2["S"] == pytest.approx(100.0)


def test_pending_criteria_lower_bound_vs_normalized():
    r = S.score_checkpoint(perfect(c8_ratio=0.6, c3c4=None, c10v=None))
    assert r["pending"] == ["C10v", "C3", "C4"]
    assert r["S"] == pytest.approx(100 - 11 - 7 - 5)
    assert r["normalized"] == pytest.approx(100.0)


def test_gate_boot_failure_caps_at_20():
    assert S.score_checkpoint(perfect(c8_ratio=0.6, booted=False))["S"] <= 20


def test_gate_no_authenticated_flow_caps_at_20():
    acc = [t("a", "R1"), t("g", "R4", "fail", gate="auth")]
    assert S.score_checkpoint(perfect(c8_ratio=0.6, acceptance=acc))["S"] <= 20


def test_gate_lint_or_tests_red_or_blanket_disable_caps_at_60():
    assert S.score_checkpoint(perfect(c8_ratio=0.6, lint_ok=False))["S"] == pytest.approx(60)
    assert S.score_checkpoint(perfect(c8_ratio=0.6, blanket_disables=["a.ts: // @ts-ignore"]))["S"] == pytest.approx(60)
    # lint/test not configured for the project -> gate not applied
    assert S.score_checkpoint(perfect(c8_ratio=0.6, lint_ok=None, test_ok=None))["S"] == pytest.approx(100)


def test_gate_race_or_authz_probe_zeroes_c2_and_caps_40():
    acc = [t("a", "R1"), t("b", "R2", "fail", criterion="C2", gate="race"), t("g", "R4", gate="auth")]
    r = S.score_checkpoint(perfect(c8_ratio=0.6, acceptance=acc))
    assert r["criteria"]["C2"]["rating"] == 0 and r["S"] <= 40


def test_failing_c2_probe_caps_c2_at_3_and_db_ownership_caps_4():
    acc = [t("a", "R1"), t("b", "R2", "fail", criterion="C2"), t("b2", "R5", criterion="C2"),
           t("b3", "R6", criterion="C2"), t("b4", "R7", criterion="C2"), t("b5", "R8", criterion="C2"),
           t("g", "R4", gate="auth")]
    assert S.score_checkpoint(perfect(acceptance=acc))["criteria"]["C2"]["rating"] <= 3
    r = S.score_checkpoint(perfect(c3c4={"c3": 5, "c4": 5, "c2_cap": 4}))
    assert r["criteria"]["C2"]["rating"] == 4


def test_shortcut_caps_c3_and_stack_violation_zeroes_checkpoint():
    r = S.score_checkpoint(perfect(human={"shortcut": True}))
    assert r["criteria"]["C3"]["rating"] == 2
    assert S.score_checkpoint(perfect(human={"stack_violation": True}))["S"] == 0


def test_c8_zero_when_c1_below_60_percent():
    acc = [t("a", "R1", "fail"), t("a2", "R2", "fail"), t("a3", "R3"), t("g", "R4", gate="auth")]
    assert S.score_checkpoint(perfect(acceptance=acc, c8_ratio=0.5))["criteria"]["C8"]["rating"] == 0


def test_c7_cumulative_and_exhaustion():
    assert S.score_checkpoint(perfect(cum_fix_attempts=0))["criteria"]["C7"]["rating"] == 5
    assert S.score_checkpoint(perfect(cum_fix_attempts=2, any_exhausted=True))["criteria"]["C7"]["rating"] == 0


def test_c9_pending_until_human_review():
    r = S.score_checkpoint(perfect(c9_unjustified=None, c9_auto=["left-pad"]))
    assert "C9" in r["pending"] and r["criteria"]["C9"]["auto_counted"] == ["left-pad"]


# ---------------------------------------------------------------- run total
def test_run_total_weighted_and_stop_loss_counts_missing_as_zero():
    w = {"cp1": 10, "cp2": 15, "cp3": 20, "cp4": 35, "cp5": 20}
    full = {k: 80.0 for k in w}
    assert S.run_total(full, w)["S"] == pytest.approx(80.0)
    partial = {"cp1": 80.0, "cp2": 80.0}  # stopped by stop-loss after cp2
    assert S.run_total(partial, w)["S"] == pytest.approx((10 * 80 + 15 * 80) / 100)
    assert S.run_total(full, w, omissions=1)["S"] == pytest.approx(75.0)
    assert S.run_total(full, w, harness_tamper=True)["S"] == 0


def test_run_total_rejects_bad_weights():
    with pytest.raises(ValueError):
        S.run_total({"cp1": 50}, {"cp1": 50, "cp2": 40})


# ---------------------------------------------------------------- C8 block geomean of 3 arms
def test_c8_ratio_against_three_arm_block_geomean():
    r = S.c8_block_ratios({"base": 1.0, "ponytail": 1.0, "placebo": 1.0})
    assert r == {"base": 1.0, "ponytail": 1.0, "placebo": 1.0}
    r = S.c8_block_ratios({"base": 2.0, "ponytail": 0.5, "placebo": 1.0})
    gm = (2.0 * 0.5 * 1.0) ** (1 / 3)
    assert r["base"] == pytest.approx(2.0 / gm) and r["ponytail"] == pytest.approx(0.5 / gm)
    assert S.c8_block_ratios({"base": 1.0, "ponytail": None, "placebo": 1.0}) == {"base": None, "ponytail": None,
                                                                                   "placebo": None}


def test_cost_per_requirement_uses_all_turns():
    assert S.cost_per_requirement(12.0, 6) == 2.0
    assert S.cost_per_requirement(12.0, 0) is None


# ---------------------------------------------------------------- C10 visual
def test_c10_visual_formula_judges_and_checks():
    assert S.c10_visual([4.0, 5.0], passed=3, total=4) == pytest.approx(3 * 4.5 / 5 + 2 * 0.75)
    assert S.c10_visual([], passed=3, total=4) is None
    assert S.c10_visual([5.0, 5.0], passed=0, total=0) is None


def test_visual_inputs_must_be_per_checkpoint():
    with pytest.raises(ValueError):
        S.visual_for_checkpoint({"all": {"judge-a": 4}}, "cp1")
    assert S.visual_for_checkpoint({"cp2": {"judge-a": 4, "judge-b": 3}}, "cp2") == [4, 3]
    assert S.visual_for_checkpoint({"cp2": {"judge-a": 4}}, "cp1") == []


# ---------------------------------------------------------------- C6 mutation validity
def test_c6_discards_mutants_that_break_no_hidden_test():
    muts = [{"id": "m1", "hidden_failed": 2, "own_failed": True},
            {"id": "m2", "hidden_failed": 1, "own_failed": False},
            {"id": "m3", "hidden_failed": 0, "own_failed": True},   # invalid: discarded even though caught
            {"id": "m4", "hidden_failed": 3, "own_failed": True}]
    r = S.c6_from_mutations(muts)
    assert r["valid"] == 3 and r["caught"] == 2 and r["discarded"] == ["m3"]
    assert r["rating"] == pytest.approx(S.rate_c6(2, 3))
    assert S.c6_from_mutations([{"id": "m1", "hidden_failed": 0, "own_failed": True}])["rating"] is None


def test_c6_failing_baseline_means_no_test_bite():
    r = S.c6_from_mutations([{"id": "m1", "hidden_failed": 2, "own_failed": True}], baseline_ok=False)
    assert r["rating"] == 0


# ---------------------------------------------------------------- C3/C4 judges
def test_code_judges_mean_disagreement_and_human_override():
    r = S.code_judges({"opus": {"c3": 4, "c4": 3, "c2_cap": 5}, "sol": {"c3": 2, "c4": 3, "c2_cap": 4}})
    assert r["c3"] == 3 and r["c4"] == 3 and r["c2_cap"] == 4
    assert r["needs_human"] == ["c3"]
    r = S.code_judges({"opus": {"c3": 4, "c4": 3}, "sol": {"c3": 2, "c4": 3}}, human={"c3": 3.5})
    assert r["c3"] == 3.5 and r["source"]["c3"] == "human"
    assert S.code_judges({}) is None


# ---------------------------------------------------------------- maintenance
def test_maintenance_metric():
    assert S.maintenance_metric(m_pass=0.8, m_regression=0.25, m_cost=2.0) == pytest.approx(0.8 * 0.75 / 2.0)
    assert S.maintenance_metric(1.0, 0.0, 0.0) is None


def test_regressions_between_validations():
    before = [t("a", "R1"), t("b", "R2"), t("c", "R3", "fail")]
    after = [t("a", "R1", "fail"), t("b", "R2"), t("c", "R3")]
    r = S.regressions(before, after)
    assert r["ids"] == ["a"] and r["rate"] == pytest.approx(0.5)


# ---------------------------------------------------------------- success rule
def cell_scores(dpb, dpp, dpr, model="sonnet"):
    """Per rep r: ponytail - base = dpb[r], ponytail - placebo = dpp[r], PR(pony) - PR(base) = dpr[r]."""
    out = []
    for rep in (1, 2, 3):
        for p in ("p1", "p2", "p3"):
            out += [{"model": model, "project": p, "rep": rep, "arm": "base", "S": 50.0, "PR": 80.0},
                    {"model": model, "project": p, "rep": rep, "arm": "ponytail", "S": 50.0 + dpb[rep - 1],
                     "PR": 80.0 + dpr[rep - 1]},
                    {"model": model, "project": p, "rep": rep, "arm": "placebo", "S": 50.0 + dpb[rep - 1] - dpp[rep - 1],
                     "PR": 80.0}]
    return out


@pytest.mark.parametrize("dpb,dpp,dpr,verdict", [
    ([4, 3, 5], [3, 4, 3], [0, 1, 0], "effective"),
    ([4, 3, 5], [1, 0, 2], [0, 1, 0], "effect not attributable to the minimalist content"),
    ([4, 3, 5], [3, 4, 3], [-5, -1, 0], "improvement with protection loss"),
    ([1, 0, 2], [3, 4, 3], [0, 0, 0], "no demonstrated effect"),
])
def test_success_rule_three_conditions(dpb, dpp, dpr, verdict):
    r = S.success_rule(cell_scores(dpb, dpp, dpr))["sonnet"]
    assert r["verdict"] == verdict
    assert r["median_delta_vs_base"] == pytest.approx(sorted(dpb)[1])


def test_success_rule_reports_permutation_p_with_holm_across_models():
    rows = cell_scores([4, 3, 5], [3, 4, 3], [0, 0, 0]) + cell_scores([1, 0, 2], [1, 1, 1], [0, 0, 0], model="luna")
    r = S.success_rule(rows)
    son = r["sonnet"]["permutation"]["vs_base"]
    assert son["n_blocks"] == 9 and son["n_permutations"] == 512
    assert son["p"] == pytest.approx(1 / 512)
    assert son["p_holm"] >= son["p"]
    assert r["luna"]["verdict"] == "no demonstrated effect"


def test_success_rule_incomplete_blocks_are_reported_not_imputed():
    rows = [x for x in cell_scores([4, 3, 5], [3, 4, 3], [0, 0, 0]) if not (x["rep"] == 3 and x["arm"] == "placebo")]
    r = S.success_rule(rows)["sonnet"]
    assert r["permutation"]["vs_placebo"]["n_blocks"] == 6
    assert r["incomplete_blocks"]


def test_suite_hash_consistency():
    probs = S.check_suite_hashes([{"run_id": "a", "project": "p1", "suite_sha256": "x"},
                                  {"run_id": "b", "project": "p1", "suite_sha256": "y"},
                                  {"run_id": "c", "project": "p2", "suite_sha256": "z"}])
    assert len(probs) == 1 and "p1" in probs[0]
