#!/usr/bin/env python3
"""The task prompt, verbatim from ../agent-smoke/prompt.py's arm A.

That wording mirrors the prompt SWE-ContextBench used to generate its own
trajectories, so the agent sees what the benchmark authors gave theirs.

Nothing is appended. Arm B's "record anything worth remembering" sentence stays
out on purpose: the extension already delivers its own write trigger at the tail
of context (src/store/index-file.ts CLOSING_NUDGE), and that is product behaviour
under test. An eval-side nudge on top would measure the harness, not pi-memo.
"""

import sys

import instance


def main() -> None:
    inst = instance.load(sys.argv[1])
    sys.stdout.write(
        "Fix this bug to solve the issue based on manual.yaml:\n"
        f"  instance_id: {inst['instance_id']}\n"
        f"  repo: {inst['repo']}\n"
        f"  base_commit: {inst['base_commit']}\n"
        f"  problem_statement: {inst['problem_statement']}"
    )


if __name__ == "__main__":
    main()
