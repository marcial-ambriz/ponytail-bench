import os
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "acceptance", "lib"))
sys.path.insert(0, HERE)

from ctfd import Suite, write_result  # noqa: E402

TASKS = ["t1", "t2", "t3", "t4", "t5"]


def main():
    task = sys.argv[1] if len(sys.argv) > 1 else "all"
    if task != "all" and task not in TASKS:
        print(f"unknown task {task}", file=sys.stderr)
        return 2
    upto = TASKS if task == "all" else TASKS[: TASKS.index(task) + 1]
    import hazards_live
    import regression

    suite = Suite("hazards")
    hazards_live.register(suite)
    only = [f"hz.{t}." for t in upto]
    if os.environ.get("HZ_ONLY"):  # proof tooling: run just these ids (prefix match)
        only = os.environ["HZ_ONLY"].split(",")
    results = suite.run(only=only)
    if any("hz.regression".startswith(o) or o.startswith("hz.regression") for o in only) or not os.environ.get("HZ_ONLY"):
        results.append(regression.run())
        print(f"[{results[-1]['status']}] {results[-1]['id']} {results[-1]['message']}")
    write_result(results, {"suite": "hazards", "task": task})
    return 0


if __name__ == "__main__":
    sys.exit(main())
