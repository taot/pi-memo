#!/usr/bin/env python3
"""Turn one instance's pre/post grade into a gold-gate verdict.

    python3 gate_verdict.py gold/<instance_id> <instance_id>

Split out of validate_gold.sh so the verdict can be recomputed from results
already on disk without re-running the tests.

Two halves:

  pre  (tests present, fix absent)  -- every FAIL_TO_PASS must fail. A test that
       already passes at base cannot distinguish a fix from no fix.
  post (fix applied)                -- every FAIL_TO_PASS and every PASS_TO_PASS
       must pass.

With one carve-out: a PASS_TO_PASS test that **already fails in the pre state**
is excluded, by id, and recorded. Such a test is broken by the environment, not
by anything an agent will do -- PASS_TO_PASS exists to catch regressions, and a
test that was already red cannot show one. sympy__sympy-12427 has exactly one
(`test_query.py::test_nan`, `assert None is False` under Python 3.9).

The exclusions are written to excluded_p2p.json and grade.py is handed the same
file for the agent runs, so the gate and the real runs score identically.
"""

import json
import sys
from pathlib import Path

d, iid = Path(sys.argv[1]), sys.argv[2]
pre = json.loads((d / "pre.json").read_text())
post = json.loads((d / "post.json").read_text())

pre_f2p = pre.get("fail_to_pass", {})
pre_p2p = pre.get("pass_to_pass", {})
pre_ok = bool(pre_f2p) and all(v != "passed" for v in pre_f2p.values()) and "error" not in pre

excluded = sorted(k for k, v in pre_p2p.items() if v != "passed")
(d / "excluded_p2p.json").write_text(json.dumps(excluded, indent=2) + "\n")

post_f2p = post.get("fail_to_pass", {})
post_p2p = {k: v for k, v in post.get("pass_to_pass", {}).items() if k not in set(excluded)}
post_ok = (
    bool(post_f2p)
    and all(v == "passed" for v in post_f2p.values())
    and all(v == "passed" for v in post_p2p.values())
)

verdict = {
    "instance_id": iid,
    "gate": "pass" if (pre_ok and post_ok) else "fail",
    "pre_f2p_all_fail": pre_ok,
    "post_resolved_excluding": post_ok,
    "excluded_p2p": excluded,
    "excluded_p2p_count": len(excluded),
    "p2p_total": len(pre_p2p),
    "pre_f2p": pre_f2p,
    "pre_counts": pre.get("counts"),
    "post_counts": post.get("counts"),
    "post_f2p_not_passed": {k: v for k, v in post_f2p.items() if v != "passed"},
    "post_p2p_not_passed": {k: v for k, v in post_p2p.items() if v != "passed"},
}
(d / "gate.json").write_text(json.dumps(verdict, indent=2) + "\n")
excl = f", {len(excluded)} P2P excluded (red at base)" if excluded else ""
print(f"  gate={verdict['gate']}  pre_f2p_all_fail={pre_ok}  post_resolved={post_ok}{excl}")
