"""Pre-registered statistics (plan §8): exact sign-flip permutation, Holm, stratified block bootstrap."""

import itertools
import random
import statistics

EPS = 1e-12


def sign_flip_test(diffs):
    """Exact one-sided sign-flip permutation test on paired block differences (H1: mean > 0).

    Enumerates all 2^n sign assignments (n = 9 blocks per model -> 512, minimum p = 1/512). p counts the flips whose
    mean is >= the observed mean, the identity included.
    """
    diffs = [float(d) for d in diffs]
    if not diffs:
        raise ValueError("sign_flip_test needs at least one difference")
    n = len(diffs)
    obs = sum(diffs) / n
    hits = 0
    for signs in itertools.product((1.0, -1.0), repeat=n):
        if sum(s * d for s, d in zip(signs, diffs)) / n >= obs - EPS:
            hits += 1
    total = 2 ** n
    return {"p": hits / total, "n_permutations": total, "n_blocks": n, "observed_mean": obs, "exact": True,
            "alternative": "greater"}


def holm(pvalues):
    """Holm step-down adjusted p-values, returned in the input order."""
    m = len(pvalues)
    order = sorted(range(m), key=lambda i: pvalues[i])
    adj, running = [0.0] * m, 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * pvalues[i]))
        adj[i] = running
    return adj


def stratified_bootstrap(diffs_by_project, n=10_000, seed=0, level=0.95):
    """Percentile bootstrap of the mean block difference, resampling blocks within each project (orientative)."""
    rng = random.Random(seed)
    strata = [list(v) for v in diffs_by_project.values() if v]
    allv = [x for s in strata for x in s]
    if not allv:
        return {"mean": None, "lo": None, "hi": None, "n": 0, "orientative": True}
    means = []
    for _ in range(n):
        tot = cnt = 0
        for s in strata:
            for _ in range(len(s)):
                tot += s[rng.randrange(len(s))]
                cnt += 1
        means.append(tot / cnt)
    means.sort()
    a = (1 - level) / 2
    return {"mean": statistics.mean(allv), "lo": means[int(a * (n - 1))], "hi": means[int((1 - a) * (n - 1))],
            "n": len(allv), "resamples": n, "seed": seed, "orientative": True}


def cell_summary(values):
    values = list(values)
    if not values:
        return {"median": None, "min": None, "max": None, "n": 0, "values": []}
    return {"median": statistics.median(values), "min": min(values), "max": max(values), "n": len(values),
            "values": values}


def weighted_kappa(a, b, categories=range(6)):
    """Linearly weighted Cohen's kappa between two raters on the 0..5 rating scale (ratings rounded)."""
    if not a or len(a) != len(b):
        return None
    cats = list(categories)
    k = len(cats)
    idx = {c: i for i, c in enumerate(cats)}
    ra = [idx[min(cats, key=lambda c: abs(c - x))] for x in a]
    rb = [idx[min(cats, key=lambda c: abs(c - x))] for x in b]
    n = len(ra)
    w = lambda i, j: abs(i - j) / (k - 1)  # noqa: E731
    obs = sum(w(i, j) for i, j in zip(ra, rb)) / n
    pa = [ra.count(i) / n for i in range(k)]
    pb = [rb.count(i) / n for i in range(k)]
    exp = sum(pa[i] * pb[j] * w(i, j) for i in range(k) for j in range(k))
    if exp == 0:
        return None
    return 1 - obs / exp
