import json

import pytest

from bench import ledger as L


def mk(tmp_path, **kw):
    lg = L.Ledger(tmp_path / "ledger.jsonl")
    g = L.BudgetGuard(lg, state_path=tmp_path / "budget-state.json", **kw)
    return lg, g


def spend(lg, usd, run="p1-sonnet-base-r1", kind="model", mode="api", attempt=None):
    lg.append({"run_id": run, "kind": kind, "attempt_id": attempt or f"a{len(lg.entries())}",
               "billed_usd": usd if mode == "api" else 0.0, "list_estimate_usd": usd, "billing_mode": mode})


def test_ledger_is_append_only_and_persistent(tmp_path):
    lg, _ = mk(tmp_path)
    spend(lg, 1.25)
    spend(lg, 2.0, run="p1-luna-base-r1", kind="judge")
    again = L.Ledger(tmp_path / "ledger.jsonl")
    assert again.total_billed() == pytest.approx(3.25)
    assert again.run_billed("p1-luna-base-r1") == pytest.approx(2.0)
    assert again.by_kind()["judge"] == pytest.approx(2.0)
    lines = (tmp_path / "ledger.jsonl").read_text().splitlines()
    assert len(lines) == 2 and all("ts" in json.loads(x) for x in lines)


def test_ledger_rejects_entries_missing_cost_fields(tmp_path):
    lg, _ = mk(tmp_path)
    with pytest.raises(ValueError):
        lg.append({"run_id": "x", "kind": "model"})
    with pytest.raises(ValueError):
        lg.append({"run_id": "x", "kind": "model", "attempt_id": "a", "billed_usd": -1, "list_estimate_usd": 0,
                   "billing_mode": "api"})


def test_subscription_list_estimate_not_counted_as_billed(tmp_path):
    lg, g = mk(tmp_path)
    spend(lg, 100.0, mode="subscription")
    assert lg.total_billed() == 0.0 and lg.total_list_estimate() == pytest.approx(100.0)
    assert g.status()["billed_usd"] == 0.0


def test_launch_refused_when_projection_exceeds_remaining(tmp_path):
    lg, g = mk(tmp_path)
    spend(lg, 250.0)
    ok, _ = g.check_launch(projection_usd=60.0)
    assert ok
    spend(lg, 290.0)  # 540 total -> also past both alerts
    g.ack(50), g.ack(80)
    ok, why = g.check_launch(projection_usd=61.0)
    assert not ok and "exceed" in why
    assert g.check_launch(projection_usd=59.0)[0]


def test_alerts_pause_at_50_and_80_percent_until_acknowledged(tmp_path):
    lg, g = mk(tmp_path)
    spend(lg, 299.0)
    assert g.check_launch(1.0)[0]
    spend(lg, 2.0)
    ok, why = g.check_launch(1.0)
    assert not ok and "50%" in why
    assert g.status()["alerts_crossed"] == [50]
    g.ack(50)
    assert g.check_launch(1.0)[0]
    spend(lg, 180.0)  # 481
    ok, why = g.check_launch(1.0)
    assert not ok and "80%" in why
    g.ack(80)
    assert g.check_launch(1.0)[0]
    # acknowledgements persist across processes
    g2 = L.BudgetGuard(L.Ledger(tmp_path / "ledger.jsonl"), state_path=tmp_path / "budget-state.json")
    assert g2.check_launch(1.0)[0]


def test_alert_does_not_stop_turns_in_flight_but_hard_cap_does(tmp_path):
    lg, g = mk(tmp_path)
    spend(lg, 301.0)
    assert g.check_turn("p1-sonnet-base-r9", "sonnet")[0]
    spend(lg, 299.0, run="other")
    ok, why = g.check_turn("p1-sonnet-base-r9", "sonnet")
    assert not ok and "cap" in why


def test_per_run_stop_loss_and_remaining(tmp_path):
    lg, g = mk(tmp_path)
    spend(lg, 14.0, run="p1-invoicing-sonnet-base-r1")
    assert g.run_remaining("p1-invoicing-sonnet-base-r1", "sonnet") == pytest.approx(1.0)
    assert g.check_turn("p1-invoicing-sonnet-base-r1", "sonnet")[0]
    spend(lg, 1.0, run="p1-invoicing-sonnet-base-r1")
    ok, why = g.check_turn("p1-invoicing-sonnet-base-r1", "sonnet")
    assert not ok and "stop-loss" in why
    spend(lg, 24.9, run="p1-invoicing-luna-base-r1")
    assert g.check_turn("p1-invoicing-luna-base-r1", "luna")[0]


def test_run_remaining_never_exceeds_global_remaining(tmp_path):
    lg, g = mk(tmp_path)
    spend(lg, 595.0, run="other")
    assert g.run_remaining("p1-invoicing-luna-base-r1", "luna") == pytest.approx(5.0)


def test_only_model_turns_count_toward_run_stop_loss(tmp_path):
    lg, g = mk(tmp_path)
    spend(lg, 10.0, run="p1-invoicing-sonnet-base-r1", kind="maintenance")
    assert g.run_remaining("p1-invoicing-sonnet-base-r1", "sonnet") == pytest.approx(15.0)


def test_run_cost_estimate_uses_actuals_then_plan_default(tmp_path):
    lg, g = mk(tmp_path)
    assert g.estimate_run_cost("sonnet") == pytest.approx(5.5)
    assert g.estimate_run_cost("luna") == pytest.approx(10.0)
    spend(lg, 8.0, run="p1-invoicing-sonnet-base-r1")
    spend(lg, 4.0, run="p2-ctfd-sonnet-base-r1")
    g.mark_run_finished("p1-invoicing-sonnet-base-r1")
    g.mark_run_finished("p2-ctfd-sonnet-base-r1")
    assert g.estimate_run_cost("sonnet") == pytest.approx(6.0)
    assert g.estimate_block_cost("sonnet") == pytest.approx(18.0)


def test_stop_loss_values_match_plan():
    assert L.STOP_LOSS_USD == {"sonnet": 15.0, "luna": 25.0}
    assert L.CAP_USD == 600.0
