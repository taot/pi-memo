#!/usr/bin/env python3
"""Export one SWE-ContextBench instance from the parquet files into instance.json.

Run with the sibling venv, which already has pandas/pyarrow:

    ../swe-contextbench/.venv/bin/python export_instance.py [instance_id]

Defaults to pallets__flask-4045: a Lite experience-pool task in a small repo,
single-file gold patch, quick to clone and easy to read.
"""

import json
import sys
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
DATA = HERE.parent / "swe-contextbench" / "data"

FIELDS = [
    "instance_id",
    "repo",
    "base_commit",
    "problem_statement",
    "created_at",
    "version",
    "patch",
    "test_patch",
]


def main() -> None:
    instance_id = sys.argv[1] if len(sys.argv) > 1 else "pallets__flask-4045"

    # instance_id has duplicate rows with non-identical content; keep the first.
    pool = pd.read_parquet(DATA / "SWEContextBench_Lite_Experience.parquet")
    pool = pool.drop_duplicates("instance_id")

    rows = pool[pool.instance_id == instance_id]
    if rows.empty:
        sys.exit(f"{instance_id} not found in SWEContextBench_Lite_Experience.parquet")

    row = rows.iloc[0]
    out = {field: row[field] for field in FIELDS}
    (HERE / "instance.json").write_text(json.dumps(out, indent=2))

    print(f"wrote instance.json: {out['instance_id']} {out['repo']} {out['base_commit']}")


if __name__ == "__main__":
    main()
