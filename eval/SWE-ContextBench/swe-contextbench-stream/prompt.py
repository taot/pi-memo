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

# Diagnostic track only (run_instance.sh --oracle-test). The default eval never
# shows the agent the official tests: they are the grading criterion, and handing
# them over turns "fix the bug" into "make these assertions pass" -- and, for this
# eval specifically, deletes the information deficit that memory is supposed to
# fill, so both arms would score alike for a reason that has nothing to do with
# memory. This exists to measure a ceiling: given an unambiguous specification,
# can the agent do the task at all?
ORACLE_SUFFIX = (
    "\n\nThe repository already contains failing tests that specify the expected "
    "behavior. Run them, and make them pass."
)


def main() -> None:
    inst = instance.load(sys.argv[1])
    oracle = "--oracle-test" in sys.argv[2:]
    sys.stdout.write(
        "Fix this bug to solve the issue based on manual.yaml:\n"
        f"  instance_id: {inst['instance_id']}\n"
        f"  repo: {inst['repo']}\n"
        f"  base_commit: {inst['base_commit']}\n"
        f"  problem_statement: {inst['problem_statement']}"
        + (ORACLE_SUFFIX if oracle else "")
    )


if __name__ == "__main__":
    main()
