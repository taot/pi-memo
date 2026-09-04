#!/usr/bin/env python3
"""Build the task prompt for one arm.

Arm A mirrors the prompt SWE-ContextBench used to generate its own Claude Code
trajectories (see cases/SWEContextBench Lite Past Experience/*.jsonl), so the
agent sees exactly what the benchmark authors gave theirs.

Arm B appends one sentence asking for a reusable note, to separate "won't write"
from "can't write".
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).parent

NUDGE = (
    "\n\nAfter you are done, record anything worth remembering for the next task "
    "in this repository."
)


def main() -> None:
    arm = sys.argv[1] if len(sys.argv) > 1 else "A"
    inst = json.loads((HERE / "instance.json").read_text())

    prompt = (
        "Fix this bug to solve the issue based on manual.yaml:\n"
        f"  instance_id: {inst['instance_id']}\n"
        f"  repo: {inst['repo']}\n"
        f"  base_commit: {inst['base_commit']}\n"
        f"  problem_statement: {inst['problem_statement']}"
    )

    if arm == "B":
        prompt += NUDGE

    sys.stdout.write(prompt)


if __name__ == "__main__":
    main()
