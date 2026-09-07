#!/usr/bin/env python3
"""Freeze the eval subset: three sympy clusters, one experience task each.

Run with the sibling venv, which already has pandas/pyarrow:

    ../swe-contextbench/.venv/bin/python select_subset.py

Writes subset.json. The two filters below are the whole argument for why these
pairs and not others; they are code, not prose, so the choice can be re-derived.

Filter 1 -- drop pairs whose two sides are the same PR. SWE-ContextBench builds
its relationship table from issue/PR cross-references, and makes one instance per
*issue*. A PR that closes several issues therefore splits into several instances,
some landing in the "related" (test) set and some in the "experience" pool, all
carrying that one PR's gold patch. 118 of 362 unique pairs are like this and 36
of them have a byte-identical gold patch on both sides: handing the agent that
"prior experience" hands it this task's answer. See ../swe-contextbench/NOTES.md.

Filter 2 -- require the experience to have actually happened first. The table is
a citation graph, not a timeline; only ~31% of pairs have the experience dated
earlier. A "memory" written about a change that had not been made yet is not the
thing we are evaluating.

Lite has 102 pairs; the two filters leave 32, of which sympy holds 12 -- the most
of any repo, and pure Python besides. Of those we keep the three whose experience
task feeds more than one related task, because one experience reused 2-3 times is
the reuse signal, and a 1:1 pair gives one observation for two agent runs.
"""

import json
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
DATA = HERE.parent / "swe-contextbench" / "data"

# The three clusters this eval runs. Keyed by experience instance; the selection
# below asserts that each really does survive both filters, so editing this list
# to something the filters reject fails loudly rather than quietly evaluating a
# leaked pair.
CLUSTERS = {
    "C1": "sympy__sympy-12419",
    "C2": "sympy__sympy-16988",
    "C3": "sympy__sympy-21055",
}

# uv fetches the interpreter, so this is free to differ from the system one. 3.9
# is what SWE-bench uses across every sympy version in range; sympy is pure
# Python and its only runtime dependency is mpmath.
PYVER = "3.9"

FIELDS = [
    "instance_id",
    "repo",
    "base_commit",
    "environment_setup_commit",
    "problem_statement",
    "created_at",
    "version",
    "patch",
    "test_patch",
    "FAIL_TO_PASS",
    "PASS_TO_PASS",
]


def load():
    # instance_id has duplicate rows with non-identical content; keep the first.
    exp = pd.read_parquet(DATA / "SWEContextBench_Lite_Experience.parquet").drop_duplicates("instance_id")
    rel = pd.read_parquet(DATA / "SWEContextBench_Related_Lite.parquet").drop_duplicates("instance_id")
    rl = pd.read_parquet(DATA / "SWEContextBench_Relationship.parquet").drop_duplicates()
    return exp.set_index("instance_id"), rel.set_index("instance_id"), rl


def clean_pairs(exp, rel, rl):
    """Every Lite pair surviving both filters, with the gap in days."""
    p = rl[rl.related_instance_id.isin(rel.index) & rl.experience_instance_id.isin(exp.index)].copy()
    total = len(p)
    p = p[p.related_pr_url != p.experience_pr_url]
    after_pr = len(p)
    p["rel_date"] = pd.to_datetime(p.related_instance_id.map(rel.created_at).astype(str).str[:10])
    p["exp_date"] = pd.to_datetime(p.experience_instance_id.map(exp.created_at).astype(str).str[:10])
    p["gap_days"] = (p.rel_date - p.exp_date).dt.days
    p = p[p.gap_days > 0].drop_duplicates(["related_instance_id", "experience_instance_id"])
    print(f"Lite pairs: {total} -> {after_pr} (different PR) -> {len(p)} (experience is earlier)")
    return p


def main() -> None:
    exp, rel, rl = load()
    pairs = clean_pairs(exp, rel, rl)

    def row(idx, df, role):
        r = df.loc[idx]
        out = {"instance_id": idx}
        out.update({f: r[f] for f in FIELDS if f in df.columns})
        out["role"] = role
        out["pyver"] = PYVER
        # Stored parsed: FAIL_TO_PASS/PASS_TO_PASS are not all valid JSON across the
        # full dataset (see ../swe-contextbench/README.md), but every row we keep is.
        for k in ("FAIL_TO_PASS", "PASS_TO_PASS"):
            out[k] = json.loads(r[k])
        out["created_at"] = str(r["created_at"])
        return out

    clusters = []
    for name, exp_id in CLUSTERS.items():
        mine = pairs[pairs.experience_instance_id == exp_id]
        if mine.empty:
            raise SystemExit(f"{name}: {exp_id} has no pair surviving the filters")
        related = sorted(mine.related_instance_id)
        clusters.append(
            {
                "cluster": name,
                "experience": row(exp_id, exp, "experience"),
                "related": [row(r, rel, "related") for r in related],
                "gap_days": {r: int(mine[mine.related_instance_id == r].gap_days.iloc[0]) for r in related},
            }
        )
        print(f"{name}: {exp_id} -> {', '.join(related)}")

    (HERE / "subset.json").write_text(json.dumps({"clusters": clusters}, indent=2) + "\n")
    n = sum(1 + len(c["related"]) for c in clusters)
    print(f"wrote subset.json: {len(clusters)} clusters, {n} instances")


if __name__ == "__main__":
    main()
