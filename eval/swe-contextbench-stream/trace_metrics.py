#!/usr/bin/env python3
"""Pull the tool trace of one run into metrics.json.

    python3 trace_metrics.py --run <run dir>

Counts come from `tool_execution_start` / `tool_execution_end`, which appear
exactly once per call and carry a `toolCallId`. Do NOT count tool names in
`message_update`: the same call is re-emitted on every streaming delta and the
count comes out three to four times too high (../agent-smoke/NOTES.md 结论 7).

What matters here beyond the counts is which memory entries the run read. With no
no-memory baseline, "the related run recalled the entry the experience run wrote"
is the only directly observable evidence of reuse -- resolve rate alone cannot
show it. So every recalled id is recorded, and run_stream.sh intersects them with
the ids the experience run created.
"""

import argparse
import json
import re
from pathlib import Path

MEMORY_TOOLS = ("memory_recall", "memory_write", "memory_revise", "memory_forget")

# Egress accounting. The old approach -- grep the trace for the proxy's refusal
# text -- reported 0 for runs that were in fact blocked every time, because what
# lands in the trace is each client's own rendering and some clients render
# nothing recognisable at all: `curl -s ... | python -c` swallows the 403 body and
# surfaces a JSON decode traceback, and uv says "Failed to fetch". That is 结论 4's
# counter trap again with new clients, and it matters because a silent 0 reads as
# "the sandbox may be off".
#
# So count both sides and let them be compared: what the agent tried, and what
# came back looking like a refusal. Neither number is the guarantee -- the
# guarantee is `deniedDomains: ["*"]` in workspace/.pi/sandbox.json plus the two
# assertions run_instance.sh makes before starting. These are corroboration, and
# `attempted > 0 with refusals == 0` is a row to go read by hand, not a verdict.
NET_ATTEMPT = re.compile(
    r"\bcurl\b|\bwget\b|pip install|uv pip|ls-remote|git fetch|git clone https?://|"
    r"urlopen|urllib|requests\.get|nc -|openssl s_client",
    re.I,
)
NET_REFUSED = re.compile(
    r"tunnel( connection)? failed|blocked by network allowlist|is blocked \(not in allowedDomains\)|"
    r"failed to fetch|error sending request for url|could not resolve host|connection refused|"
    r"403 Forbidden|network is unreachable",
    re.I,
)

# Two renderings, both from src/tools/format.ts, and recall can return either:
#   formatEntry     -> "## <id>  [<scope>/<kind>]"   (a full entry)
#   summarizeEntry  -> "[<scope>/<kind>] <id> — <title>"  (a search hit list)
# An earlier version of this file looked for an "id:" front-matter line instead.
# There is no such line in tool output -- it exists only in the stored .md file --
# so every recall parsed as returning nothing, and the reuse column, which is the
# one number this whole eval exists to produce, silently read 0/8 on a run where
# every related task had in fact recalled the experience entry by id.
ENTRY_HEADING = re.compile(r"^## ([A-Za-z0-9._-]+)\s+\[\w+/\w+\]", re.M)
ENTRY_SUMMARY = re.compile(r"^\[\w+/\w+\] ([A-Za-z0-9._-]+) — ", re.M)


def entry_ids(body: str) -> list[str]:
    return sorted(set(ENTRY_HEADING.findall(body)) | set(ENTRY_SUMMARY.findall(body)))


def read_trace(path: Path) -> list[dict]:
    events = []
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def text_of(result: dict) -> str:
    return "\n".join(c.get("text", "") for c in (result or {}).get("content", []) if c.get("type") == "text")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, type=Path)
    args = ap.parse_args()

    events = read_trace(args.run / "trace.jsonl")
    calls, results = {}, {}
    for e in events:
        if e.get("type") == "tool_execution_start":
            calls[e["toolCallId"]] = {"tool": e.get("toolName"), "args": e.get("args", {})}
        elif e.get("type") == "tool_execution_end":
            results[e["toolCallId"]] = e

    by_tool: dict[str, int] = {}
    memory_calls = []
    net_attempts, net_refused = 0, 0
    for cid, call in calls.items():
        by_tool[call["tool"]] = by_tool.get(call["tool"], 0) + 1
        end = results.get(cid, {})
        body = text_of(end.get("result"))
        if call["tool"] == "bash" and NET_ATTEMPT.search(str(call["args"].get("command", ""))):
            net_attempts += 1
            if NET_REFUSED.search(body):
                net_refused += 1
        if call["tool"] not in MEMORY_TOOLS:
            continue
        memory_calls.append(
            {
                "tool": call["tool"],
                "args": call["args"],
                "is_error": bool(end.get("isError")),
                # What the agent asked for, and what actually came back. The two
                # differ when a recall by id misses or a query returns other entries.
                "requested_ids": sorted(call["args"].get("ids", []) or []),
                "entry_ids": entry_ids(body),
                "result_excerpt": body[:800],
            }
        )

    recalled = sorted({i for c in memory_calls if c["tool"] == "memory_recall" for i in c["entry_ids"]})
    requested = sorted({i for c in memory_calls if c["tool"] == "memory_recall" for i in c["requested_ids"]})
    written = sorted(
        {
            c["args"].get("id")
            for c in memory_calls
            if c["tool"] in ("memory_write", "memory_revise") and not c["is_error"] and c["args"].get("id")
        }
    )

    metrics = {
        "tool_calls_total": len(calls),
        "tool_calls_by_name": dict(sorted(by_tool.items(), key=lambda kv: -kv[1])),
        "memory_calls": {t: by_tool.get(t, 0) for t in MEMORY_TOOLS},
        "net_attempts": net_attempts,
        "net_refused": net_refused,
        "net_unexplained": net_attempts - net_refused,
        "recall_calls": by_tool.get("memory_recall", 0),
        "requested_entry_ids": requested,
        "recalled_entry_ids": recalled,
        "written_entry_ids": written,
        "memory_call_detail": memory_calls,
    }
    (args.run / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    print(
        f"{args.run.name}: {len(calls)} tool calls  "
        + "  ".join(f"{t.removeprefix('memory_')}={metrics['memory_calls'][t]}" for t in MEMORY_TOOLS)
    )


if __name__ == "__main__":
    main()
