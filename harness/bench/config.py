"""Fixed study configuration (plan §3, §4, §10). Changing anything here after freeze is a logged deviation."""

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

HARNESS = Path(__file__).resolve().parents[1]
REPO = HARNESS.parent
PROJECTS_DIR = REPO / "projects"
PLAN_DIR = REPO / "plan"
SKILLS_DIR = HARNESS / "skills"
PROMPTS_DIR = HARNESS / "prompts"

# Subjects: exact snapshot ids are recorded from every response (gap 20).
MODELS = {
    "sonnet": {"provider": "claude", "model": "claude-sonnet-5-5", "effort": "medium"},
    "luna": {"provider": "codex", "model": "gpt-6-luna", "effort": "medium"},
}
ARMS = ("base", "ponytail", "placebo")
REPS = (1, 2, 3)
PROJECTS = ("p1-invoicing", "p2-ctfd", "p3-inventory")
# Non-subject judges (plan §6.1 C10, §9) and the fixed maintenance agent (§6.3).
JUDGES = {"opus": {"provider": "claude", "model": "claude-opus-5-5", "effort": "medium"},
          "sol": {"provider": "codex", "model": "gpt-6-sol", "effort": "medium"}}
MAINTENANCE_AGENT = {"provider": "claude", "model": "claude-sonnet-5-5", "effort": "medium"}

MAX_FIX_ATTEMPTS = 3
MAINTENANCE_MAX_FIXES = 2
TURN_TIMEOUT_S = 90 * 60
MAX_CONCURRENT_BLOCKS = 2
PORT_RANGE = {"base": 42000, "block": 10, "count": 200}  # leased per run from a machine-wide registry (42000-43999)
RACE_RETRIES = 1  # a failing concurrency hazard is re-run once, alone on the machine, before it is recorded (gap 19)
GIT_IDENTITY = ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "-c", "commit.gpgsign=false"]

# Credentials are read only from these environment variables at runtime (never from files).
CRED_ENV = {
    "claude": {"api": "BENCH_ANTHROPIC_API_KEY", "subscription": "BENCH_CLAUDE_CODE_OAUTH_TOKEN"},
    "codex": {"api": "BENCH_OPENAI_API_KEY", "subscription": "BENCH_CODEX_AUTH_JSON"},
}

# Node used by the TypeScript projects and the screenshot script; Playwright resolved from this node_modules parent.
NODE_BIN = Path(os.environ.get("BENCH_NODE_BIN", str(Path.home() / ".nvm/versions/node/v22.23.3/bin")))
PLAYWRIGHT_DIR = Path(os.environ.get("BENCH_PLAYWRIGHT_DIR",
                                     str(Path.home() / "Projects/ponytail-bench-worktrees/.harness/acceptance")))


def global_dir():
    """Machine-wide coordination (port leases, validation lock): shared by every checkout, dry run and real run."""
    return Path(os.environ.get("BENCH_GLOBAL_DIR", str(Path.home() / ".cache" / "ponytail-bench")))


@dataclass
class Paths:
    root: Path = HARNESS
    port_base: Optional[int] = None

    def __post_init__(self):
        self.root = Path(self.root)

    @property
    def state(self):
        return self.root / ".state"

    @property
    def runs(self):
        return Path(os.environ.get("BENCH_RUNS_ROOT", self.root / ".runs"))

    @property
    def scores(self):
        return self.root / "scores"

    @property
    def frozen(self):
        return self.root / "frozen"

    def run_state(self, run_id):
        return self.state / run_id

    def run_dir(self, run_id):
        return self.runs / run_id

    def ports(self):
        if self.port_base is None:
            return {"api_base": 3200, "web_base": 5400, "step": 10}
        return {"api_base": self.port_base, "web_base": self.port_base + 1, "step": 2}
