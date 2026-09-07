#!/usr/bin/env python3
"""Collect one stream run into results.json and report.md.

    python3 report.py --run runs/<run-id>

The headline is not the resolve rate. With only the persistent arm there is no
counterfactual, so a resolve rate says how hard these instances are, not whether
memory helped. The number that does carry information is the reuse column: did
the related run call memory_recall at all, and did what came back include an
entry the experience run wrote. That is observable without a baseline, and it is
the mechanism the whole stream exists to exercise.
"""

import argparse
import json
from pathlib import Path

import instance


def read(path: Path):
    return json.loads(path.read_text()) if path.exists() else None


def collect_run(d: Path) -> dict | None:
    inst = read(d / "instance.json")
    if inst is None:
        return None
    metrics = read(d / "metrics.json") or {}
    grade = read(d / "grade.json") or {}
    seconds = int((d / "seconds.txt").read_text().strip()) if (d / "seconds.txt").exists() else None
    blocked = (d / "net-blocked-count.txt")
    patch = (d / "patch.diff").read_text() if (d / "patch.diff").exists() else ""
    return {
        "dir": str(d),
        "instance_id": inst["instance_id"],
        "role": inst["role"],
        "resolved": grade.get("resolved"),
        "grade_counts": grade.get("counts"),
        "grade_error": grade.get("error"),
        "excluded_p2p": grade.get("excluded_p2p", []),
        "tool_calls": metrics.get("tool_calls_total"),
        "tool_calls_by_name": metrics.get("tool_calls_by_name", {}),
        "memory_calls": metrics.get("memory_calls", {}),
        "written_entry_ids": metrics.get("written_entry_ids", []),
        "recalled_entry_ids": metrics.get("recalled_entry_ids", []),
        "patch_files": patch.count("diff --git"),
        "patch_lines": sum(
            1 for l in patch.splitlines() if (l.startswith("+") or l.startswith("-")) and not l.startswith(("+++", "---"))
        ),
        "net_attempts": metrics.get("net_attempts", 0),
        "net_refused": metrics.get("net_refused", 0),
        "net_unexplained": metrics.get("net_unexplained", 0),
        "seconds": seconds,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, type=Path)
    args = ap.parse_args()
    root = args.run

    clusters = []
    for c in instance.clusters():
        cdir = root / c["cluster"]
        if not cdir.exists():
            continue
        exp = collect_run(cdir / "experience")
        rels = [r for r in (collect_run(cdir / f"related-{x['instance_id']}") for x in c["related"]) if r]
        if exp is None:
            continue
        # The reuse signal: of the entries this related run recalled, how many did
        # the experience run create. Ids are unique per store, so set overlap is
        # exact -- no matching heuristics.
        created = set(exp["written_entry_ids"])
        for r in rels:
            reused = sorted(set(r["recalled_entry_ids"]) & created)
            r["reused_experience_entry_ids"] = reused
            r["recalled_anything"] = bool(r["recalled_entry_ids"])
            r["called_recall"] = r["memory_calls"].get("memory_recall", 0) > 0
        clusters.append({"cluster": c["cluster"], "experience": exp, "related": rels})

    runs = [r for c in clusters for r in [c["experience"], *c["related"]]]
    rel_runs = [r for c in clusters for r in c["related"]]
    summary = {
        "runs": len(runs),
        "related_runs": len(rel_runs),
        "related_resolved": sum(1 for r in rel_runs if r["resolved"]),
        "experience_resolved": sum(1 for c in clusters if c["experience"]["resolved"]),
        "runs_that_wrote": sum(1 for r in runs if r["memory_calls"].get("memory_write", 0) > 0),
        "related_that_called_recall": sum(1 for r in rel_runs if r["called_recall"]),
        "related_that_got_entries_back": sum(1 for r in rel_runs if r["recalled_anything"]),
        "related_that_reused_experience_entry": sum(1 for r in rel_runs if r["reused_experience_entry_ids"]),
        "runs_with_unexplained_egress": [r["instance_id"] for r in runs if r["net_unexplained"]],
    }
    (root / "results.json").write_text(json.dumps({"summary": summary, "clusters": clusters}, indent=2) + "\n")

    manifest = (root / "manifest.txt").read_text() if (root / "manifest.txt").exists() else ""
    md = [
        f"# {root.name}",
        "",
        "```text",
        manifest.strip(),
        "```",
        "",
        "**单臂运行，没有 no-memory 基线**（`ARM=fresh` 存在但未跑）。所以下面的 resolve rate",
        "只说明这些实例有多难，**不能**读成「记忆带来了收益」。有信息量的是 reuse 两列：",
        "related 运行有没有召回，召回的里面有没有 experience 运行写下的那条。",
        "",
        "## 汇总",
        "",
        "| 项 | 值 |",
        "|---|---|",
        f"| 运行数 | {summary['runs']} |",
        f"| experience 解出 | {summary['experience_resolved']}/{len(clusters)} |",
        f"| related 解出 | {summary['related_resolved']}/{summary['related_runs']} |",
        f"| 写了记忆的运行 | {summary['runs_that_wrote']}/{summary['runs']} |",
        f"| 调用过 recall 的 related 运行 | {summary['related_that_called_recall']}/{summary['related_runs']} |",
        f"| recall 确实返回了条目 | {summary['related_that_got_entries_back']}/{summary['related_runs']} |",
        f"| **召回到 experience 写下的条目** | **{summary['related_that_reused_experience_entry']}/{summary['related_runs']}** |",
        "",
    ]
    for c in clusters:
        md += [
            f"## {c['cluster']}",
            "",
            "| 角色 | instance | resolved | F2P | P2P | tools | w/r/rev/f | 写下 | 召回到 experience 的条目 | 外联 试/拒 |",
            "|---|---|---|---|---|---|---|---|---|---|",
        ]
        for r in [c["experience"], *c["related"]]:
            g = r["grade_counts"] or {}
            m = r["memory_calls"]
            mc = "/".join(
                str(m.get(k, 0)) for k in ("memory_write", "memory_recall", "memory_revise", "memory_forget")
            )
            reused = ", ".join(r.get("reused_experience_entry_ids", [])) or ("—" if r["role"] == "related" else "")
            md.append(
                f"| {r['role']} | `{r['instance_id']}` | {r['resolved']} "
                f"| {g.get('f2p_passed', '?')}/{g.get('f2p_total', '?')} "
                f"| {g.get('p2p_passed', '?')}/{g.get('p2p_total', '?')}"
                + (f" (−{g['p2p_excluded']})" if g.get("p2p_excluded") else "")
                + " "
                f"| {r['tool_calls']} | {mc} | {', '.join(r['written_entry_ids']) or '—'} "
                f"| {reused} | {r['net_attempts']}/{r['net_refused']} |"
            )
        md.append("")
        entries = c["experience"]["written_entry_ids"]
        if entries:
            md += [f"experience 写下：{', '.join('`' + e + '`' for e in entries)}", ""]

    excl = {r["instance_id"]: r["excluded_p2p"] for r in runs if r["excluded_p2p"]}
    if excl:
        md += [
            "> P2P 列的 `−n` 是被排除的测试：gold gate 发现它们在 base 上就已经失败，",
            "> 那是环境产物，不可能反映 agent 造成的回归。逐条记在 `gold/<id>/excluded_p2p.json`。",
            "",
        ]
        for i, ids in excl.items():
            md += [f"> - `{i}`: " + ", ".join(f"`{x}`" for x in ids), ""]

    if summary["runs_with_unexplained_egress"]:
        md += [
            "> 外联列是「尝试次数 / 看起来被拒的次数」。两者不等不代表漏了：`curl -s ... | python`",
            "> 会把 403 的响应体吞掉，只留下一个 JSON 解析 traceback，客户端根本没渲染出可识别的字样。",
            "> 隔离的保证来自 `workspace/.pi/sandbox.json` 里的 `deniedDomains: [\"*\"]`，以及",
            "> `run_instance.sh` 开跑前对 pi-sandbox 和 `rg` 的两条断言；这两个数字只是旁证。",
            "> 需要人工看一眼的：" + ", ".join(f"`{i}`" for i in summary["runs_with_unexplained_egress"]),
            "",
        ]

    (root / "report.md").write_text("\n".join(md))
    print(f"wrote {root}/results.json and {root}/report.md")
    print(
        f"  related resolved {summary['related_resolved']}/{summary['related_runs']}, "
        f"reused an experience entry {summary['related_that_reused_experience_entry']}/{summary['related_runs']}"
    )


if __name__ == "__main__":
    main()
