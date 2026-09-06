#!/usr/bin/env python3
"""Read one instance out of the frozen subset.json.

Imported by grade.py, and callable from shell for a single field:

    python3 instance.py sympy__sympy-12419 base_commit
    python3 instance.py sympy__sympy-12419 test_patch > /tmp/t.patch
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
SUBSET = HERE / "subset.json"


def all_instances() -> dict:
    """instance_id -> record, with `cluster` folded in."""
    out = {}
    for c in json.loads(SUBSET.read_text())["clusters"]:
        for rec in [c["experience"], *c["related"]]:
            rec = dict(rec, cluster=c["cluster"])
            if rec["role"] == "related":
                rec["gap_days"] = c["gap_days"][rec["instance_id"]]
                rec["experience_of"] = c["experience"]["instance_id"]
            out[rec["instance_id"]] = rec
    return out


def clusters() -> list:
    return json.loads(SUBSET.read_text())["clusters"]


def load(instance_id: str) -> dict:
    every = all_instances()
    if instance_id not in every:
        sys.exit(f"{instance_id} is not in subset.json")
    return every[instance_id]


def test_files(rec: dict) -> list:
    """Paths the official test_patch touches -- the files the agent must not own."""
    prefix = "diff --git a/"
    return sorted(
        {line[len(prefix) :].split(" b/")[0] for line in rec["test_patch"].splitlines() if line.startswith(prefix)}
    )


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("usage: instance.py <instance_id> <field>")
    rec = load(sys.argv[1])
    field = sys.argv[2]
    if field == "test_files":
        print("\n".join(test_files(rec)))
        return
    value = rec[field]
    if isinstance(value, list):
        print("\n".join(value))
    else:
        sys.stdout.write(str(value))
        if not str(value).endswith("\n"):
            sys.stdout.write("\n")


if __name__ == "__main__":
    main()
