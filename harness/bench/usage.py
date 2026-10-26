"""Token usage and cost accounting (plan §6.4; gaps 4, 5, 6).

Every attempt of every turn (including rate-limited and interrupted ones) is written to its own transcript file
(`<label>.a<n>.jsonl`, never overwritten) and its usage is summed. Token keys: input (uncached), output, cache_read,
cache_write, reasoning (informational: already inside output for OpenAI, never billed twice).

Prices come from a prices.json captured at freeze (USD per 1M tokens). Cost is split into:
- billed_usd: spend on API keys (billing_mode "api"); this is what the budget guard caps. It is token x frozen list
  price and must be reconciled with the providers' usage/cost reports (> 5% drift is reported).
- list_estimate_usd: the same computation for every attempt, including subscription-billed ones (billed 0).
"""

import hashlib
import json
import re
import time
from pathlib import Path

KEYS = ("input", "output", "cache_read", "cache_write", "reasoning")
PRICE_KEYS = ("input", "output", "cache_read", "cache_write")
BILLING_MODES = ("api", "subscription")
# Round 1 observed that Codex `turn.completed` usage is cumulative over a resumed thread (score.py per_turn_usage).
# Deltas are taken per session; the reconciliation against the provider report is the check that this stays true.
CODEX_USAGE_CUMULATIVE = True
RATE_LIMIT = re.compile(r"rate.?limit|usage limit|429|too many requests", re.I)


class PriceError(ValueError):
    pass


def zero():
    return {k: 0 for k in KEYS}


def sum_usage(items):
    t = zero()
    for u in items:
        for k in KEYS:
            t[k] += int(u.get(k) or 0)
    return t


def _events(lines):
    for line in lines:
        try:
            d = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(d, dict):
            yield d


def parse_claude_stream(lines):
    """Claude Code `--output-format stream-json --verbose`. Usage is taken per API call (assistant message id,
    last/maximum value of each field, since one message is streamed as several events). The result event's usage and
    total_cost_usd are kept raw for reconciliation only (total_cost_usd is session-cumulative on resumed sessions)."""
    calls, out = {}, {"session_id": None, "complete": False, "rate_limited_until": None, "final_message": None,
                      "result_usage": None, "reported_cost_usd": None, "model_usage": None, "is_error": None,
                      "num_turns": None}
    for d in _events(lines):
        t = d.get("type")
        if d.get("session_id") and not out["session_id"]:
            out["session_id"] = d["session_id"]
        if t == "assistant":
            msg = d.get("message") or {}
            u = msg.get("usage") or {}
            mid = msg.get("id") or f"anon-{len(calls)}"
            c = calls.setdefault(mid, {"message_id": mid, "model": msg.get("model"), **zero()})
            vals = {"input": u.get("input_tokens"), "output": u.get("output_tokens"),
                    "cache_read": u.get("cache_read_input_tokens"), "cache_write": u.get("cache_creation_input_tokens")}
            for k, v in vals.items():
                c[k] = max(c[k], int(v or 0))
            if msg.get("model"):
                c["model"] = msg["model"]
        elif t == "rate_limit_event":
            info = d.get("rate_limit_info") or {}
            if info.get("status") not in ("allowed", "allowed_warning", None):
                out["rate_limited_until"] = info.get("resetsAt") or time.time() + 15 * 60
        elif t == "result":
            out["complete"] = True
            out["result_usage"] = d.get("usage")
            out["reported_cost_usd"] = d.get("total_cost_usd")
            out["model_usage"] = d.get("modelUsage")
            out["final_message"] = (d.get("result") or "")[-1500:]
            out["is_error"] = d.get("is_error")
            out["num_turns"] = d.get("num_turns")
            if d.get("is_error") and RATE_LIMIT.search(json.dumps(d)):
                out["rate_limited_until"] = out["rate_limited_until"] or time.time() + 15 * 60
    out["calls"] = list(calls.values())
    out["totals"] = sum_usage(out["calls"])
    out["model_ids"] = sorted({c["model"] for c in out["calls"] if c.get("model")})
    return out


def parse_codex_stream(lines):
    """Codex `exec --json`. `cumulative` keeps the raw counters of the last turn.completed (None if none arrived)."""
    out = {"session_id": None, "cumulative": None, "complete": False, "rate_limited_until": None,
           "final_message": None, "is_error": False, "model_ids": [], "items": 0}
    for d in _events(lines):
        t = d.get("type")
        out["items"] += 1
        if t == "thread.started":
            out["session_id"] = d.get("thread_id")
        elif t == "turn.completed":
            u = d.get("usage") or {}
            out["cumulative"] = {"input": int(u.get("input_tokens") or 0), "cached": int(u.get("cached_input_tokens") or 0),
                                 "output": int(u.get("output_tokens") or 0),
                                 "reasoning": int(u.get("reasoning_output_tokens") or 0)}
            out["complete"] = True
        elif t == "item.completed" and (d.get("item") or {}).get("type") == "agent_message":
            out["final_message"] = (d["item"].get("text") or "")[-1500:]
        elif t in ("turn.failed", "error"):
            out["is_error"] = True
            if RATE_LIMIT.search(json.dumps(d)):
                out["rate_limited_until"] = time.time() + 15 * 60
        model = d.get("model") or (d.get("item") or {}).get("model")
        if model and model not in out["model_ids"]:
            out["model_ids"].append(model)
    return out


def codex_deltas(attempts):
    """Per-attempt usage from Codex counters, in chronological order (session-cumulative -> deltas)."""
    prev, prev_sid, res = None, None, []
    for a in attempts:
        cum = a.get("cumulative")
        if cum is None:
            res.append(zero())
            continue
        if a.get("session_id") != prev_sid or not CODEX_USAGE_CUMULATIVE:
            prev = None
        if prev and any(cum[k] < prev[k] for k in cum):
            prev = None  # counter decreased: treat as a reset, never produce negative usage
        base = prev or {"input": 0, "cached": 0, "output": 0, "reasoning": 0}
        d_in, d_cached = cum["input"] - base["input"], cum["cached"] - base["cached"]
        res.append({"input": d_in - d_cached, "output": cum["output"] - base["output"], "cache_read": d_cached,
                    "cache_write": 0, "reasoning": cum["reasoning"] - base["reasoning"]})
        prev, prev_sid = cum, a.get("session_id")
    return res


def load_prices(path):
    raw = Path(path).read_bytes()
    d = json.loads(raw)
    models = d.get("models") or {}
    if not models:
        raise PriceError(f"{path}: no models")
    for m, p in models.items():
        for k in PRICE_KEYS:
            v = p.get(k)
            if not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0:
                raise PriceError(f"{path}: {m}.{k} is {v!r}; fill every price before freezing (USD per 1M tokens)")
    if not d.get("captured_at") or not d.get("source"):
        raise PriceError(f"{path}: captured_at and source are required")
    d["sha256"] = hashlib.sha256(raw).hexdigest()
    return d


def model_prices(prices, model_id):
    models = prices["models"]
    if model_id in models:
        return models[model_id]
    best = max((m for m in models if model_id.startswith(m)), key=len, default=None)
    if best is None:
        raise PriceError(f"no price for model {model_id!r}")
    return models[best]


def price(u, p):
    return sum(int(u.get(k) or 0) * float(p[k]) for k in PRICE_KEYS) / 1e6


def split_cost(usd, billing_mode):
    if billing_mode not in BILLING_MODES:
        raise ValueError(f"billing_mode must be one of {BILLING_MODES}")
    return {"billed_usd": usd if billing_mode == "api" else 0.0, "list_estimate_usd": usd, "billing_mode": billing_mode}


def next_attempt_path(directory, label):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    n = 1
    while (directory / f"{label}.a{n}.jsonl").exists():
        n += 1
    p = directory / f"{label}.a{n}.jsonl"
    p.touch(exist_ok=False)
    return p


def reconcile(computed, invoiced, threshold=0.05):
    if not invoiced:
        return {"computed": computed, "invoiced": invoiced, "drift": None, "flag": computed > 0}
    drift = abs(invoiced - computed) / invoiced
    return {"computed": computed, "invoiced": invoiced, "drift": drift, "flag": drift > threshold}
