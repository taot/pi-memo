#!/usr/bin/env bash
# Run one SWE-ContextBench experience task through a real pi agent with pi-memo
# loaded, and keep everything the run touched.
#
#   ./run.sh A    # task prompt only        -> does it write memory on its own?
#   ./run.sh B    # task prompt + a nudge   -> can it write memory at all?
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
ARM="${1:-A}"
RUN="$HERE/runs/$ARM"

BASE="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['base_commit'])" "$HERE/instance.json")"

# Fresh workspace at base_commit. The prune clears registrations left behind by
# an `rm -rf runs/` that skipped `worktree remove`.
git -C "$HERE/repos/flask" worktree remove --force "$RUN/workspace" 2>/dev/null || true
rm -rf "$RUN"
git -C "$HERE/repos/flask" worktree prune
mkdir -p "$RUN"
git -C "$HERE/repos/flask" worktree add --quiet --detach "$RUN/workspace" "$BASE"

python3 "$HERE/prompt.py" "$ARM" > "$RUN/prompt.txt"

# Isolated global store. The project store lands in workspace/.pi/memo.
export PI_MEMO_HOME="$RUN/memo-global"
mkdir -p "$PI_MEMO_HOME"

echo "arm:       $ARM"
echo "workspace: $RUN/workspace"
echo "memo home: $PI_MEMO_HOME"
echo "running pi..."

# -ne/-ns/-nc: load nothing but pi-memo, so the trace is about pi-memo only.
cd "$RUN/workspace"
pi -p --mode json -ne -ns -nc -e "$REPO_ROOT/index.ts" "$(cat "$RUN/prompt.txt")" \
  > "$RUN/trace.jsonl" 2> "$RUN/stderr.log" || echo "pi exited non-zero (see stderr.log)"

# The candidate SWE-bench patch, minus anything pi-memo itself wrote.
git -C "$RUN/workspace" diff -- . ':(exclude).pi' > "$RUN/patch.diff" || true

echo "done -> $RUN"
