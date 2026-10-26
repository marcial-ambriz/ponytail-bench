import json

import pytest

from bench import usage


def jl(*events):
    return [json.dumps(e) for e in events]


CLAUDE_TURN = jl(
    {"type": "system", "subtype": "init", "session_id": "s-1", "model": "claude-sonnet-5-5"},
    # streaming emits one assistant event per content block; usage repeats and grows for the same message id
    {"type": "assistant", "session_id": "s-1", "message": {"id": "m1", "model": "claude-sonnet-5-5-20261001",
     "usage": {"input_tokens": 10, "output_tokens": 1, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 200}}},
    {"type": "assistant", "session_id": "s-1", "message": {"id": "m1", "model": "claude-sonnet-5-5-20261001",
     "usage": {"input_tokens": 10, "output_tokens": 50, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 200}}},
    {"type": "user", "message": {"content": "tool result"}},
    {"type": "assistant", "session_id": "s-1", "message": {"id": "m2", "model": "claude-sonnet-5-5-20261001",
     "usage": {"input_tokens": 5, "output_tokens": 70, "cache_read_input_tokens": 1200, "cache_creation_input_tokens": 0}}},
    {"type": "result", "subtype": "success", "session_id": "s-1", "total_cost_usd": 0.42, "num_turns": 2,
     "result": "done", "usage": {"input_tokens": 15, "output_tokens": 120, "cache_read_input_tokens": 2200,
                                "cache_creation_input_tokens": 200}},
)


def test_claude_per_call_usage_deduplicates_streamed_message_ids():
    p = usage.parse_claude_stream(CLAUDE_TURN)
    assert p["session_id"] == "s-1"
    assert p["complete"] is True
    assert [c["message_id"] for c in p["calls"]] == ["m1", "m2"]
    assert p["calls"][0]["output"] == 50
    assert p["totals"] == {"input": 15, "output": 120, "cache_read": 2200, "cache_write": 200, "reasoning": 0}
    assert p["model_ids"] == ["claude-sonnet-5-5-20261001"]
    assert p["final_message"] == "done"
    assert p["reported_cost_usd"] == 0.42


def test_claude_interrupted_attempt_keeps_its_tokens():
    p = usage.parse_claude_stream(CLAUDE_TURN[:3] + ["not json {"])
    assert p["complete"] is False
    assert p["totals"]["output"] == 50 and p["totals"]["cache_read"] == 1000


def test_claude_rate_limit_event_detected():
    lines = jl({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": 1900000000}})
    assert usage.parse_claude_stream(lines)["rate_limited_until"] == 1900000000


def test_codex_stream_and_session_cumulative_deltas():
    a1 = usage.parse_codex_stream(jl(
        {"type": "thread.started", "thread_id": "t-1"},
        {"type": "turn.completed", "usage": {"input_tokens": 1000, "cached_input_tokens": 600, "output_tokens": 100,
                                             "reasoning_output_tokens": 40}},
        {"type": "item.completed", "item": {"type": "agent_message", "text": "ok"}},
    ))
    a2 = usage.parse_codex_stream(jl(
        {"type": "thread.started", "thread_id": "t-1"},
        {"type": "turn.completed", "usage": {"input_tokens": 2500, "cached_input_tokens": 1800, "output_tokens": 160,
                                             "reasoning_output_tokens": 60}},
    ))
    assert a1["session_id"] == "t-1" and a1["complete"] and a1["final_message"] == "ok"
    d = usage.codex_deltas([a1, a2])
    # uncached input = input - cached; reasoning is included in output (not billed twice)
    assert d[0] == {"input": 400, "output": 100, "cache_read": 600, "cache_write": 0, "reasoning": 40}
    assert d[1] == {"input": 300, "output": 60, "cache_read": 1200, "cache_write": 0, "reasoning": 20}


def test_codex_counter_decrease_or_new_session_resets():
    mk = lambda sid, i, c, o: {"session_id": sid, "cumulative": {"input": i, "cached": c, "output": o, "reasoning": 0},
                               "complete": True}
    d = usage.codex_deltas([mk("t-1", 100, 0, 10), mk("t-2", 50, 0, 5), mk("t-2", 20, 0, 1)])
    assert d[1]["input"] == 50  # new session: no subtraction
    assert d[2]["input"] == 20  # decrease: treated as reset, never negative


def test_codex_failed_attempt_without_usage_is_zero_and_flagged():
    p = usage.parse_codex_stream(jl({"type": "thread.started", "thread_id": "t-1"},
                                    {"type": "error", "message": "429 rate limit"}))
    assert p["complete"] is False and p["cumulative"] is None and p["rate_limited_until"]
    assert usage.codex_deltas([p])[0]["input"] == 0


PRICES = {"captured_at": "2026-10-25", "source": "test", "models": {
    "claude-sonnet-5-5": {"input": 3.0, "output": 15.0, "cache_read": 0.3, "cache_write": 3.75},
    "gpt-6-luna": {"input": 1.0, "output": 8.0, "cache_read": 0.1, "cache_write": 0.0}}}


def test_load_prices_hashes_and_rejects_placeholders(tmp_path):
    f = tmp_path / "prices.json"
    f.write_text(json.dumps(PRICES))
    p = usage.load_prices(f)
    assert len(p["sha256"]) == 64
    bad = json.loads(json.dumps(PRICES))
    bad["models"]["gpt-6-luna"]["output"] = None
    f.write_text(json.dumps(bad))
    with pytest.raises(usage.PriceError):
        usage.load_prices(f)


def test_price_formula_per_million_tokens():
    u = {"input": 1_000_000, "output": 100_000, "cache_read": 2_000_000, "cache_write": 400_000, "reasoning": 50_000}
    assert usage.price(u, PRICES["models"]["claude-sonnet-5-5"]) == pytest.approx(3.0 + 1.5 + 0.6 + 1.5)


def test_price_lookup_by_snapshot_prefix_and_unknown_model():
    p = {"models": PRICES["models"], "sha256": "x"}
    assert usage.model_prices(p, "claude-sonnet-5-5-20261001") is p["models"]["claude-sonnet-5-5"]
    with pytest.raises(usage.PriceError):
        usage.model_prices(p, "gpt-7")


def test_billed_vs_list_price_estimate():
    assert usage.split_cost(2.5, "api") == {"billed_usd": 2.5, "list_estimate_usd": 2.5, "billing_mode": "api"}
    assert usage.split_cost(2.5, "subscription") == {"billed_usd": 0.0, "list_estimate_usd": 2.5,
                                                     "billing_mode": "subscription"}
    with pytest.raises(ValueError):
        usage.split_cost(1.0, "free")


def test_attempt_files_are_never_overwritten(tmp_path):
    a = usage.next_attempt_path(tmp_path, "cp1-impl")
    a.write_text("first")
    b = usage.next_attempt_path(tmp_path, "cp1-impl")
    assert a.name == "cp1-impl.a1.jsonl" and b.name == "cp1-impl.a2.jsonl"
    assert a.read_text() == "first"


def test_turn_cost_sums_all_attempts_including_interrupted():
    attempts = [
        {"usage": {"input": 100, "output": 10, "cache_read": 0, "cache_write": 0, "reasoning": 0}, "complete": False},
        {"usage": {"input": 200, "output": 20, "cache_read": 0, "cache_write": 0, "reasoning": 0}, "complete": True},
    ]
    t = usage.sum_usage(a["usage"] for a in attempts)
    assert t == {"input": 300, "output": 30, "cache_read": 0, "cache_write": 0, "reasoning": 0}


def test_reconcile_flags_more_than_five_percent_drift():
    assert usage.reconcile(computed=100.0, invoiced=104.0)["flag"] is False
    r = usage.reconcile(computed=100.0, invoiced=106.0)
    assert r["flag"] is True and r["drift"] == pytest.approx(6 / 106)  # relative to the invoice
