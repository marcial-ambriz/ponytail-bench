import itertools
import statistics

import pytest

from bench import stats


def brute_force_p(diffs):
    obs = statistics.mean(diffs)
    hits = 0
    for signs in itertools.product((1, -1), repeat=len(diffs)):
        if statistics.mean(s * d for s, d in zip(signs, diffs)) >= obs - 1e-12:
            hits += 1
    return hits / 2 ** len(diffs)


def test_sign_flip_enumerates_all_512_flips_for_nine_blocks():
    r = stats.sign_flip_test([1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert r["n_permutations"] == 512
    assert r["exact"] is True
    assert r["p"] == pytest.approx(1 / 512)  # the minimum attainable p (~0.002)
    assert r["observed_mean"] == pytest.approx(5.0)


@pytest.mark.parametrize("diffs", [
    [3.0, -1.0, 2.5, 0.0, 4.0, -2.0, 1.0, 5.0, -0.5],
    [-3.0, -1.0, -2.0, -4.0, -1.0, -2.0, -1.0, -5.0, -0.5],
    [1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0],
])
def test_sign_flip_matches_brute_force_one_sided(diffs):
    assert stats.sign_flip_test(diffs)["p"] == pytest.approx(brute_force_p(diffs))


def test_sign_flip_all_zero_differences_gives_p_one():
    assert stats.sign_flip_test([0.0] * 9)["p"] == pytest.approx(1.0)


def test_sign_flip_rejects_empty_and_reports_n():
    with pytest.raises(ValueError):
        stats.sign_flip_test([])
    assert stats.sign_flip_test([1.0, 2.0, 3.0])["n_permutations"] == 8  # per-project: min p 0.125


def test_holm_adjusts_and_keeps_order():
    assert stats.holm([0.01, 0.04]) == pytest.approx([0.02, 0.04])
    assert stats.holm([0.03, 0.01]) == pytest.approx([0.03, 0.02])
    assert stats.holm([0.6, 0.7]) == pytest.approx([1.0, 1.0])  # step-down keeps monotonicity


def test_holm_is_monotone_and_capped():
    adj = stats.holm([0.4, 0.3])
    assert all(p <= 1.0 for p in adj)
    assert adj == pytest.approx([0.6, 0.6])


def test_stratified_block_bootstrap_is_seeded_and_bounded():
    diffs = {"p1": [1.0, 2.0, 3.0], "p2": [0.0, -1.0, 1.0], "p3": [4.0, 5.0, 6.0]}
    a = stats.stratified_bootstrap(diffs, n=2000, seed=7)
    b = stats.stratified_bootstrap(diffs, n=2000, seed=7)
    assert a == b
    assert a["lo"] <= a["mean"] <= a["hi"]
    assert a["mean"] == pytest.approx(statistics.mean([1, 2, 3, 0, -1, 1, 4, 5, 6]))
    assert a["orientative"] is True
    # every resample keeps 3 blocks per project, so the CI cannot exceed the extreme per-project means
    assert a["lo"] >= statistics.mean([1, -1, 4]) - 1e-9  # all-min resample
    assert a["hi"] <= statistics.mean([3, 1, 6]) + 1e-9


def test_cell_summary_median_min_max():
    assert stats.cell_summary([3.0, 1.0, 2.0]) == {"median": 2.0, "min": 1.0, "max": 3.0, "n": 3, "values": [3.0, 1.0, 2.0]}


def test_weighted_kappa_perfect_and_chance():
    assert stats.weighted_kappa([0, 3, 5, 4], [0, 3, 5, 4]) == pytest.approx(1.0)
    k = stats.weighted_kappa([1, 2, 3, 4], [4, 3, 2, 1])
    assert k < 0
    assert stats.weighted_kappa([], []) is None
    assert stats.weighted_kappa([3, 3], [3, 3]) is None  # no variance: undefined
