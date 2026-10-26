import importlib.util
import os
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

from ctfd import Suite, write_result  # noqa: E402

TASKS = ["t1", "t2", "t3", "t4", "t5"]


def load(task, suite):
    spec = importlib.util.spec_from_file_location(task, os.path.join(HERE, f"{task}.py"))
    mod = importlib.util.module_from_spec(spec)
    mod.suite = suite
    spec.loader.exec_module(mod)


def main():
    task = sys.argv[1] if len(sys.argv) > 1 else "all"
    tasks = TASKS if task == "all" else [task]
    if any(t not in TASKS for t in tasks):
        print(f"unknown task {task}; expected one of {TASKS} or all", file=sys.stderr)
        return 2
    suite = Suite("acceptance")
    for t in tasks:
        load(t, suite)
    write_result(suite.run(), {"suite": "acceptance", "task": task})
    return 0


if __name__ == "__main__":
    sys.exit(main())
