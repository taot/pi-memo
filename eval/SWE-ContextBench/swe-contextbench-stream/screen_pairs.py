#!/usr/bin/env python3
"""Screen the 32 clean pairs for whether the experience could actually teach the
related task anything, and whether the related task's issue text is self-sufficient.

    ../swe-contextbench/.venv/bin/python screen_pairs.py

`select_subset.py`'s two filters remove pairs that leak the answer (same PR) and
pairs where the "experience" happened later. Neither says anything about the third
problem, which NOTES.md 结论 8 exposed: the relationship table records a *citation*
between issues, and a citation is not shared knowledge. `16988` (FiniteSet ∩ Symbol)
cites `16946` (the `is_empty` API contract); they are different work in the same
package, so nothing the agent could learn from the first helps with the second.

That cannot be filtered by metadata alone, so this script computes proxies and
ranks the pairs for a human to read. Two families:

  overlap   -- do the two gold patches touch the same files, and the same
               functions/classes within them? Same file is weak evidence, same
               enclosing symbol is strong: it means the related task must modify
               code the experience task already had to understand.

  self-суff -- is the related task's issue text enough to derive the contract?
               NOTES.md 结论 6 and 结论 7 are both failures of this: `12426`'s
               fixture semantics change is unstated, and `16946` points at a
               GitHub comment for the spec. A statement carrying a concrete
               expected-output block is the good case; one whose spec is behind a
               URL is the bad case.

Selecting instances with the gold patch is oracle information. That is legitimate
for curating a frozen subset -- it happens once, before any run, and is recorded --
but the ranking must never be revisited after seeing scores.
"""

import re
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
DATA = HERE.parent / "swe-contextbench" / "data"

FILE_RE = re.compile(r"^diff --git a/(\S+) b/", re.M)
# `@@ -a,b +c,d @@ <enclosing symbol>` -- git's hunk header carries the nearest
# preceding def/class, which is a free structural signal.
HUNK_RE = re.compile(r"^@@ [^@]+ @@\s*(.+)$", re.M)
SYMBOL_RE = re.compile(r"(?:def|class)\s+(\w+)")
URL_RE = re.compile(r"https?://\S+")
DOCTEST_RE = re.compile(r"^\s*>>> ", re.M)


def files(patch: str) -> set:
    return set(FILE_RE.findall(patch))


def symbols(patch: str) -> set:
    """Enclosing def/class names from git's hunk headers.

    An earlier version also took the first bare word of every hunk header as a
    fallback, which meant `class`/`def`/`return` counted as shared symbols and the
    column read 1 or 2 for essentially every pair -- noise dressed as signal.
    Only real declarations count now, so an empty result is an honest empty.
    """
    return {n for ctx in HUNK_RE.findall(patch) for n in SYMBOL_RE.findall(ctx)}


def patch_size(patch: str) -> int:
    return sum(
        1 for l in patch.splitlines() if (l.startswith("+") or l.startswith("-")) and not l.startswith(("+++", "---"))
    )


def main() -> None:
    exp = pd.read_parquet(DATA / "SWEContextBench_Lite_Experience.parquet").drop_duplicates("instance_id").set_index("instance_id")
    rel = pd.read_parquet(DATA / "SWEContextBench_Related_Lite.parquet").drop_duplicates("instance_id").set_index("instance_id")
    rl = pd.read_parquet(DATA / "SWEContextBench_Relationship.parquet").drop_duplicates()

    p = rl[rl.related_instance_id.isin(rel.index) & rl.experience_instance_id.isin(exp.index)].copy()
    p = p[p.related_pr_url != p.experience_pr_url]
    p["rel_date"] = pd.to_datetime(p.related_instance_id.map(rel.created_at).astype(str).str[:10])
    p["exp_date"] = pd.to_datetime(p.experience_instance_id.map(exp.created_at).astype(str).str[:10])
    p = p[(p.rel_date - p.exp_date).dt.days > 0].drop_duplicates(["related_instance_id", "experience_instance_id"])

    rows = []
    for _, x in p.iterrows():
        r, e = rel.loc[x.related_instance_id], exp.loc[x.experience_instance_id]
        rf, ef = files(r.patch), files(e.patch)
        rs, es = symbols(r.patch), symbols(e.patch)
        stmt = r.problem_statement or ""
        rows.append(
            {
                "repo": r.repo.split("/")[-1],
                "related": x.related_instance_id.split("-")[-1],
                "experience": x.experience_instance_id.split("-")[-1],
                "same_files": len(rf & ef),
                "rel_files": len(rf),
                "same_symbols": len(rs & es),
                "rel_lines": patch_size(r.patch),
                "stmt_len": len(stmt),
                "doctest": bool(DOCTEST_RE.search(stmt)),
                "urls": len(URL_RE.findall(stmt)),
                # The 结论 7 shape: the statement defers the specification to a
                # link the sandbox will refuse to fetch.
                "spec_behind_url": bool(re.search(r"(see|discussion|comment|described|details).{0,60}https?://", stmt, re.I | re.S)),
                # Two defects the pr_url and date filters both let through, found
                # on psf__requests-3362 -> 3359 (NOTES.md 结论 9):
                #   same_statement -- the related task's issue text is the
                #     experience's issue text verbatim. Different PR, three months
                #     apart, but the same reported bug: the "experience" is an
                #     earlier attempt at the same fix, in the same lines.
                #   The sibling check below catches the other half: two related
                #     tasks in one cluster carrying byte-identical gold patches,
                #     i.e. the same task counted twice.
                "same_statement": (stmt or "").strip() == (e.problem_statement or "").strip(),
                "shared": sorted(rf & ef),
                "_patch": r.patch,
            }
        )

    df = pd.DataFrame(rows)
    # Related tasks sharing one experience whose gold patches are identical are
    # one task, not several.
    dup = (
        df.groupby("experience")["_patch"]
        .transform(lambda g: g.duplicated(keep=False) if len(g) > 1 else False)
        .fillna(False)
    )
    df["dup_sibling"] = dup
    df = df.drop(columns=["_patch"])
    # Rank: shared enclosing symbols first (strong), then shared files, then a
    # small related patch and a statement that shows expected output.
    # Shared enclosing symbol is the strongest evidence that the experience task
    # had to understand the code the related task must change. Shared file is
    # weaker the bigger the file (sympy/sets/sets.py is ~1800 lines: two PRs can
    # share it and share nothing). A small related patch is what buys the dynamic
    # range NOTES.md 结论 2 says the eval is missing.
    df["score"] = (
        df.same_symbols * 5
        + df.same_files * 2
        + df.doctest.astype(int) * 2
        - (df.rel_lines > 80).astype(int) * 3
        - (df.spec_behind_url).astype(int) * 2
        - df.same_statement.astype(int) * 10
        - df.dup_sibling.astype(int) * 10
    )
    df = df.sort_values(["score", "same_files"], ascending=False)

    pd.set_option("display.width", 200, "display.max_colwidth", 46)
    print(df.drop(columns=["shared", "urls", "stmt_len"]).to_string(index=False))
    bad = df[df.same_statement | df.dup_sibling]
    if len(bad):
        print(f"\n被新增两条筛选剔除的 {len(bad)} 对（题面与经验逐字相同，或同簇内 gold patch 重复）:")
        for _, r in bad.iterrows():
            why = []
            if r.same_statement: why.append("题面与经验相同")
            if r.dup_sibling: why.append("与同簇另一道 patch 相同")
            print(f"  {r.repo:12s} {r.experience} -> {r.related}   {'; '.join(why)}")
    print("\n共享文件的配对（记忆有可能真的用得上的那些）:")
    for _, r in df[df.same_files > 0].iterrows():
        print(f"  {r.repo:12s} {r.experience} -> {r.related}   符号重合 {r.same_symbols}   {r.shared}")


if __name__ == "__main__":
    main()
