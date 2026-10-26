"""CliAgent accounting against fake CLIs: every attempt priced, ledgered and kept (no real model is ever called)."""
import json
import stat
import textwrap

import pytest

from bench import agents
from bench import ledger as L

PRICES = {"sha256": "x", "models": {
    "claude-sonnet-5-5": {"input": 3.0, "output": 15.0, "cache_read": 0.3, "cache_write": 3.75},
    "gpt-6-luna": {"input": 1.0, "output": 8.0, "cache_read": 0.1, "cache_write": 0.0}}}

FAKE_CLAUDE = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, sys, pathlib
    n = pathlib.Path(os.environ["FAKE_COUNTER"])
    k = int(n.read_text()) if n.exists() else 0
    n.write_text(str(k + 1))
    pathlib.Path(os.environ["FAKE_ARGS"] + f".{k}").write_text(json.dumps(sys.argv[1:]))
    def out(d): print(json.dumps(d), flush=True)
    out({"type": "system", "subtype": "init", "session_id": "S1", "model": "claude-sonnet-5-5"})
    out({"type": "assistant", "session_id": "S1", "message": {"id": f"m{k}", "model": "claude-sonnet-5-5-20261001",
         "usage": {"input_tokens": 1000, "output_tokens": 100000, "cache_read_input_tokens": 0,
                   "cache_creation_input_tokens": 0}}})
    if k == 0:
        out({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": 0}})
        sys.exit(1)
    out({"type": "result", "session_id": "S1", "result": "done", "total_cost_usd": 9.9,
         "usage": {"input_tokens": 1000, "output_tokens": 100000}})
''')

FAKE_CODEX = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, pathlib
    n = pathlib.Path(os.environ["FAKE_COUNTER"])
    k = int(n.read_text()) if n.exists() else 0
    n.write_text(str(k + 1))
    def out(d): print(json.dumps(d), flush=True)
    out({"type": "thread.started", "thread_id": "T1"})
    cum = [(1000, 400, 100), (2500, 1500, 180)][k]
    out({"type": "turn.completed", "usage": {"input_tokens": cum[0], "cached_input_tokens": cum[1],
         "output_tokens": cum[2], "reasoning_output_tokens": 0}})
''')


def install_fake(tmp_path, name, body, monkeypatch):
    b = tmp_path / "bin"
    b.mkdir(exist_ok=True)
    f = b / name
    f.write_text(body)
    f.chmod(f.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(agents, "NODE_BIN", b)  # base_env puts NODE_BIN first on PATH
    monkeypatch.setenv("FAKE_COUNTER", str(tmp_path / f"{name}.count"))
    monkeypatch.setenv("FAKE_ARGS", str(tmp_path / f"{name}.args"))
    monkeypatch.setattr(agents.time, "sleep", lambda s: None)


def make(tmp_path, provider, model, model_key, run_id):
    lg = L.Ledger(tmp_path / "ledger.jsonl")
    g = L.BudgetGuard(lg, tmp_path / "budget.json")
    a = agents.CliAgent(provider, model, "medium", tmp_path, tmp_path / "cfg", tmp_path / "turns", lg, g, PRICES,
                        run_id, model_key, fake_home=tmp_path / "home")
    return lg, g, a


def test_rate_limited_attempt_is_kept_priced_and_retried(tmp_path, monkeypatch):
    install_fake(tmp_path, "claude", FAKE_CLAUDE, monkeypatch)
    monkeypatch.setenv("BENCH_ANTHROPIC_API_KEY", "test-not-a-key")
    lg, g, a = make(tmp_path, "claude", "claude-sonnet-5-5", "sonnet", "p1-x-sonnet-base-r1")
    t = a.turn("cp1-impl", "do it")
    assert [x["file"] for x in t["attempts"]] == ["cp1-impl.a1.jsonl", "cp1-impl.a2.jsonl"]
    assert (tmp_path / "turns" / "cp1-impl.a1.jsonl").read_text().count("rate_limit_event") == 1
    per = 1000 * 3.0 / 1e6 + 100000 * 15.0 / 1e6
    assert t["billed_usd"] == pytest.approx(2 * per)  # the interrupted attempt's tokens are billed too
    assert t["usage"]["output"] == 200000
    assert len(lg.entries()) == 2 and lg.total_billed() == pytest.approx(2 * per)
    assert t["session_id"] == "S1"
    args = json.loads((tmp_path / "claude.args.1").read_text())
    assert "--max-budget-usd" in args and "--resume" in args  # retry resumes the same session
    assert t["model_ids"] == ["claude-sonnet-5-5-20261001"]


def test_stop_loss_refuses_turn_without_calling_cli(tmp_path, monkeypatch):
    install_fake(tmp_path, "claude", FAKE_CLAUDE, monkeypatch)
    monkeypatch.setenv("BENCH_ANTHROPIC_API_KEY", "test-not-a-key")
    lg, g, a = make(tmp_path, "claude", "claude-sonnet-5-5", "sonnet", "p1-x-sonnet-base-r1")
    lg.append({"run_id": "p1-x-sonnet-base-r1", "kind": "model", "attempt_id": "prev", "billed_usd": 15.0,
               "list_estimate_usd": 15.0, "billing_mode": "api"})
    t = a.turn("cp2-impl", "do it")
    assert t["attempts"] == [] and "stop-loss" in t["stopped"]
    assert not (tmp_path / "claude.count").exists()


def test_subscription_billing_is_list_estimate_only(tmp_path, monkeypatch):
    install_fake(tmp_path, "claude", FAKE_CLAUDE, monkeypatch)
    monkeypatch.delenv("BENCH_ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("BENCH_CLAUDE_CODE_OAUTH_TOKEN", "test-not-a-token")
    (tmp_path / "claude.count").write_text("1")  # skip the rate-limited first attempt
    lg, g, a = make(tmp_path, "claude", "claude-sonnet-5-5", "sonnet", "p1-x-sonnet-base-r1")
    t = a.turn("cp1-impl", "do it")
    assert t["billed_usd"] == 0 and t["list_estimate_usd"] > 0
    assert "--max-budget-usd" not in json.loads((tmp_path / "claude.args.1").read_text())
    assert "CLAUDE_CODE_OAUTH_TOKEN" in a.env() and "ANTHROPIC_API_KEY" not in a.env()


def test_codex_session_cumulative_counters_become_per_turn_deltas(tmp_path, monkeypatch):
    install_fake(tmp_path, "codex", FAKE_CODEX, monkeypatch)
    monkeypatch.setenv("BENCH_OPENAI_API_KEY", "test-not-a-key")
    lg, g, a = make(tmp_path, "codex", "gpt-6-luna", "luna", "p1-x-luna-base-r1")
    t1 = a.turn("cp1-impl", "do it")
    t2 = a.turn("cp2-impl", "next", session_id=t1["session_id"], codex_prev=t1["codex_prev"])
    assert t1["usage"] == {"input": 600, "output": 100, "cache_read": 400, "cache_write": 0, "reasoning": 0}
    assert t2["usage"] == {"input": 400, "output": 80, "cache_read": 1100, "cache_write": 0, "reasoning": 0}
    assert a.env()["HOME"] == str(tmp_path / "home") and a.env()["OPENAI_API_KEY"] == "test-not-a-key"


def test_agent_env_never_inherits_parent_credentials(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "parent-key")
    monkeypatch.setenv("OPENAI_API_KEY", "parent-key")
    monkeypatch.delenv("BENCH_ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("BENCH_CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    e = agents.base_env()
    assert "ANTHROPIC_API_KEY" not in e and "OPENAI_API_KEY" not in e
    lg, g, a = make(tmp_path, "claude", "claude-sonnet-5-5", "sonnet", "p1-x-sonnet-base-r1")
    with pytest.raises(agents.StopTurn):
        a.turn("cp1-impl", "x")
