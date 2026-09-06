#!/usr/bin/env python3
"""Score one workspace against the instance's official tests.

    python3 grade.py --instance sympy__sympy-12426 --workspace <dir> \
        --venv <dir> --out grade.json

Does three things, in this order:

1. Restores the files the official `test_patch` touches. The agent is asked to fix
   the product code; two of the three agent-smoke runs also edited the test file
   on their way there (NOTES.md 结论 3, 结论 8). Whatever it wrote there is not
   part of the candidate patch and must not be part of the graded tree either.
2. Applies the official `test_patch`, which is what brings the FAIL_TO_PASS tests
   into existence at all.
3. Runs FAIL_TO_PASS + PASS_TO_PASS and reports each node id separately.

The dataset writes test ids two ways. The related instances use pytest node ids
(`sympy/sets/tests/test_sets.py::test_imageset`); the three experience instances
use bare function names (`test_Identity`), the form SWE-bench's own sympy runner
takes. Every bare-name instance touches exactly one test file, so the name is
resolved against that file -- and a name that does not resolve is an error, not a
silently skipped test.

It does NOT apply the gold patch: validate_gold.sh applies that itself before
calling this, so the same script grades both the gold gate and the agent runs.

A node id pytest never reported on is `missing`, never `passed` -- a typo'd or
uncollectable id would otherwise read as a silent success.
"""

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

import instance

# sympy's slower test files (e.g. test_fancysets) take minutes; a whole
# PASS_TO_PASS set of 443 needs room. Well under an agent run's own cost.
TIMEOUT = 3600

# `pytest -rA` short summary lines: "PASSED path::test", "FAILED path::test - msg".
SUMMARY = re.compile(r"^(PASSED|FAILED|ERROR|XFAIL|XPASS|SKIPPED)\s+(\S+)")


def resolve_ids(rec: dict, ids: list[str]) -> list[str]:
    """Turn bare test names into node ids using the instance's own test file."""
    files = instance.test_files(rec)
    out = []
    for i in ids:
        if "::" in i:
            out.append(i)
            continue
        if len(files) != 1:
            sys.exit(f"{rec['instance_id']}: bare test name {i!r} but {len(files)} test files; cannot resolve")
        out.append(f"{files[0]}::{i}")
    return out


def run_pytest(venv: Path, workspace: Path, node_ids: list[str]) -> tuple[dict, str, int, float]:
    cmd = [
        str(venv / "bin" / "python"),
        "-m",
        "pytest",
        "-rA",
        "--no-header",
        "-p",
        "no:cacheprovider",
        "--continue-on-collection-errors",
        *node_ids,
    ]
    env = {
        "PATH": f"{venv / 'bin'}:/usr/bin:/bin",
        "HOME": str(workspace),
        # sympy is a flat layout: the package is the repo root, so nothing is
        # installed and the agent's edits are what gets imported.
        "PYTHONPATH": str(workspace),
        "PYTHONDONTWRITEBYTECODE": "1",
        # Keeps sympy's own test output stable across terminals.
        "COLUMNS": "80",
        "TERM": "dumb",
    }
    started = time.time()
    try:
        p = subprocess.run(cmd, cwd=workspace, env=env, capture_output=True, text=True, timeout=TIMEOUT)
        out, code = p.stdout + p.stderr, p.returncode
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode(errors="replace") + (e.stderr or b"").decode(errors="replace")
        out += f"\n[grade.py] TIMEOUT after {TIMEOUT}s\n"
        code = -1
    status = {}
    for line in out.splitlines():
        m = SUMMARY.match(line.strip())
        if m:
            # A node reported twice (parametrised ids collapse) keeps the worse
            # outcome; PASSED must not overwrite an earlier FAILED.
            verdict, node = m.group(1).lower(), m.group(2)
            if status.get(node) in ("failed", "error"):
                continue
            status[node] = verdict
    return status, out, code, time.time() - started


def restore_test_files(workspace: Path, paths: list[str]) -> list[str]:
    """Drop agent edits to the official test files. Returns the ones it changed."""
    reverted = []
    for path in paths:
        if not (workspace / path).exists():
            continue
        dirty = subprocess.run(
            ["git", "status", "--porcelain", "--", path], cwd=workspace, capture_output=True, text=True
        ).stdout.strip()
        if dirty:
            subprocess.run(["git", "checkout", "--", path], cwd=workspace, check=True)
            reverted.append(path)
    return reverted


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance", required=True)
    ap.add_argument("--workspace", required=True, type=Path)
    ap.add_argument("--venv", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--log", type=Path, help="where to write the raw pytest output")
    ap.add_argument(
        "--exclude-file",
        type=Path,
        help="JSON list of PASS_TO_PASS node ids to exclude from `resolved` -- the ones the "
        "gold gate found already failing at base, which cannot show a regression. "
        "They are still run and still reported, marked `excluded`.",
    )
    args = ap.parse_args()

    rec = instance.load(args.instance)
    tests = instance.test_files(rec)

    reverted = restore_test_files(args.workspace, tests)

    patch_file = args.workspace / ".git" / "swecb-test.patch"
    patch_file.write_text(rec["test_patch"])
    applied = subprocess.run(
        ["git", "apply", "--verbose", str(patch_file)], cwd=args.workspace, capture_output=True, text=True
    )
    if applied.returncode != 0:
        args.out.write_text(
            json.dumps(
                {
                    "instance_id": args.instance,
                    "resolved": False,
                    "error": "test_patch did not apply",
                    "detail": applied.stderr,
                    "reverted_test_files": reverted,
                },
                indent=2,
            )
            + "\n"
        )
        sys.exit("test_patch did not apply:\n" + applied.stderr)

    f2p = resolve_ids(rec, rec["FAIL_TO_PASS"])
    p2p = resolve_ids(rec, rec["PASS_TO_PASS"])
    status, out, code, secs = run_pytest(args.venv, args.workspace, f2p + p2p)
    if args.log:
        args.log.write_text(out)

    def verdicts(ids):
        return {i: status.get(i, "missing") for i in ids}

    excluded = set(json.loads(args.exclude_file.read_text())) if args.exclude_file else set()
    f2p_v, p2p_v = verdicts(f2p), verdicts(p2p)
    scored_p2p = {k: v for k, v in p2p_v.items() if k not in excluded}
    result = {
        "instance_id": args.instance,
        "resolved": all(v == "passed" for v in f2p_v.values())
        and all(v == "passed" for v in scored_p2p.values()),
        "fail_to_pass": f2p_v,
        "pass_to_pass": p2p_v,
        "excluded_p2p": sorted(excluded & set(p2p_v)),
        "counts": {
            "f2p_passed": sum(v == "passed" for v in f2p_v.values()),
            "f2p_total": len(f2p_v),
            "p2p_passed": sum(v == "passed" for v in scored_p2p.values()),
            "p2p_total": len(scored_p2p),
            "p2p_excluded": len(excluded & set(p2p_v)),
        },
        "reverted_test_files": reverted,
        "pytest_exit_code": code,
        "seconds": round(secs, 1),
    }
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    c = result["counts"]
    print(
        f"{args.instance}: resolved={result['resolved']} "
        f"F2P {c['f2p_passed']}/{c['f2p_total']}  P2P {c['p2p_passed']}/{c['p2p_total']}  ({secs:.0f}s)"
    )


if __name__ == "__main__":
    main()
