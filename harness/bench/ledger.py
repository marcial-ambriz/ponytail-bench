"""Global spend ledger and budget guard (plan §10; gap 7).

The ledger is an append-only JSONL file with one entry per model attempt, judge call, maintenance turn, UX agent or
mutation agent. The guard is checked before every block launch and before every model turn:
- hard cap 600 USD billed: no turn starts once it is reached; no block/run launches whose projection exceeds what is left;
- alerts at 50% (300) and 80% (480): new launches pause until the level is acknowledged (`bench budget ack 50`);
  turns already in flight continue (the block finishes);
- per-run stop-loss (Sonnet 15, luna 25 USD; model turns of that run only): the run stops and is scored as is.
"""

import json
import statistics
import threading
from datetime import datetime, timezone
from pathlib import Path

CAP_USD = 600.0
ALERT_LEVELS = (50, 80)
STOP_LOSS_USD = {"sonnet": 15.0, "luna": 25.0}
PLAN_RUN_ESTIMATE_USD = {"sonnet": 5.5, "luna": 10.0}
KINDS = ("model", "judge", "maintenance", "ux", "mutation", "other")
REQUIRED = ("run_id", "kind", "attempt_id", "billed_usd", "list_estimate_usd", "billing_mode")


class Ledger:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def append(self, entry):
        missing = [k for k in REQUIRED if k not in entry]
        if missing:
            raise ValueError(f"ledger entry missing {missing}")
        if entry["kind"] not in KINDS:
            raise ValueError(f"unknown ledger kind {entry['kind']!r}")
        for k in ("billed_usd", "list_estimate_usd"):
            if not isinstance(entry[k], (int, float)) or entry[k] < 0:
                raise ValueError(f"{k} must be a non-negative number")
        e = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), **entry}
        with self._lock, open(self.path, "a") as f:
            f.write(json.dumps(e, sort_keys=True) + "\n")
        return e

    def entries(self):
        if not self.path.exists():
            return []
        return [json.loads(x) for x in self.path.read_text().splitlines() if x.strip()]

    def total_billed(self):
        return sum(e["billed_usd"] for e in self.entries())

    def total_list_estimate(self):
        return sum(e["list_estimate_usd"] for e in self.entries())

    def run_billed(self, run_id, kinds=None):
        return sum(e["billed_usd"] for e in self.entries()
                   if e["run_id"] == run_id and (kinds is None or e["kind"] in kinds))

    def run_list_estimate(self, run_id, kinds=None):
        return sum(e["list_estimate_usd"] for e in self.entries()
                   if e["run_id"] == run_id and (kinds is None or e["kind"] in kinds))

    def by_kind(self):
        out = {}
        for e in self.entries():
            out[e["kind"]] = out.get(e["kind"], 0.0) + e["billed_usd"]
        return out


def model_of(run_id):
    from .schedule import parse_run_id
    try:
        return parse_run_id(run_id)["model"]
    except ValueError:
        return None


class BudgetGuard:
    def __init__(self, ledger, state_path, cap=CAP_USD, alert_levels=ALERT_LEVELS, stop_loss=None,
                 plan_estimates=None):
        self.ledger, self.state_path = ledger, Path(state_path)
        self.cap, self.alert_levels = cap, tuple(alert_levels)
        self.stop_loss = dict(STOP_LOSS_USD if stop_loss is None else stop_loss)
        self.plan_estimates = dict(PLAN_RUN_ESTIMATE_USD if plan_estimates is None else plan_estimates)

    # ---- persisted acknowledgements and finished runs
    def _state(self):
        if self.state_path.exists():
            return json.loads(self.state_path.read_text())
        return {"acked": [], "finished_runs": []}

    def _save(self, st):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps(st, indent=2))

    def ack(self, level):
        st = self._state()
        if level not in st["acked"]:
            st["acked"].append(level)
        self._save(st)

    def mark_run_finished(self, run_id):
        st = self._state()
        if run_id not in st["finished_runs"]:
            st["finished_runs"].append(run_id)
        self._save(st)

    # ---- status
    def status(self):
        billed = self.ledger.total_billed()
        crossed = [lvl for lvl in self.alert_levels if billed >= self.cap * lvl / 100]
        acked = self._state()["acked"]
        pending = [lvl for lvl in crossed if lvl not in acked]
        return {"billed_usd": round(billed, 6), "list_estimate_usd": round(self.ledger.total_list_estimate(), 6),
                "cap_usd": self.cap, "remaining_usd": round(self.cap - billed, 6), "alerts_crossed": crossed,
                "paused_at": pending[-1] if pending else None, "by_kind": self.ledger.by_kind()}

    def check_launch(self, projection_usd):
        s = self.status()
        if s["remaining_usd"] <= 0:
            return False, f"hard cap {self.cap} USD reached"
        if s["paused_at"] is not None:
            return False, (f"paused at the {s['paused_at']}% alert ({s['billed_usd']:.2f} USD billed): re-project and "
                           f"run `benchctl.py budget ack {s['paused_at']}` to continue")
        if projection_usd > s["remaining_usd"]:
            return False, (f"projection {projection_usd:.2f} USD would exceed the remaining budget "
                           f"{s['remaining_usd']:.2f} USD")
        return True, "ok"

    def run_remaining(self, run_id, model_key):
        spent = self.ledger.run_billed(run_id, kinds=("model",))
        limit = self.stop_loss.get(model_key, min(self.stop_loss.values()))
        return max(0.0, min(limit - spent, self.cap - self.ledger.total_billed()))

    def check_turn(self, run_id, model_key):
        if self.ledger.total_billed() >= self.cap:
            return False, f"hard cap {self.cap} USD reached"
        spent = self.ledger.run_billed(run_id, kinds=("model",))
        limit = self.stop_loss.get(model_key, min(self.stop_loss.values()))
        if spent >= limit:
            return False, f"stop-loss {limit} USD reached for {run_id} ({spent:.2f} USD)"
        return True, "ok"

    # ---- projections
    def estimate_run_cost(self, model_key):
        done = [r for r in self._state()["finished_runs"] if model_of(r) == model_key]
        costs = [self.ledger.run_billed(r) for r in done]
        costs = [c for c in costs if c > 0]
        return statistics.mean(costs) if costs else self.plan_estimates.get(model_key, max(self.plan_estimates.values()))

    def estimate_block_cost(self, model_key, arms=3):
        return arms * self.estimate_run_cost(model_key)
