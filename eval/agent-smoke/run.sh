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

read -r INSTANCE BASE <<<"$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
print(d['instance_id'], d['base_commit'])
" "$HERE/instance.json")"

# Fresh workspace: the tree at base_commit and nothing else. A worktree of
# repos/flask would share its object database and all of its refs, which lets the
# agent find the upstream fix with `git log --all` and copy it -- see NOTES.md.
rm -rf "$RUN"
# Clears registrations left behind by worktrees from earlier versions of this script.
git -C "$HERE/repos/flask" worktree prune
mkdir -p "$RUN/workspace"
git -C "$HERE/repos/flask" archive --format=tar "$BASE" | tar -x -C "$RUN/workspace"
git -C "$RUN/workspace" init --quiet -b main
# -f: flask's own .gitignore covers tracked fixtures (tests/test_apps/.env,
# .flaskenv), which plain `add -A` would leave untracked and out of the diff.
git -C "$RUN/workspace" add -A -f
# -c so the run does not depend on the user's global git identity.
git -C "$RUN/workspace" \
	-c user.name="eval" -c user.email="eval@localhost" \
	commit --quiet -m "$INSTANCE base $BASE"

# The whole point of the snapshot: one commit, no remotes, no future refs.
if [ "$(git -C "$RUN/workspace" rev-list --count HEAD)" != 1 ]; then
	echo "workspace is not a clean snapshot" >&2
	exit 1
fi

python3 "$HERE/prompt.py" "$ARM" > "$RUN/prompt.txt"

# Isolated global store. The project store lands in workspace/.pi/memo.
export PI_MEMO_HOME="$RUN/memo-global"
mkdir -p "$PI_MEMO_HOME"

# Langfuse tracing. The telemetry extension is a pi package, so -ne skips it --
# load it explicitly. Its langfuse credentials live in the `pi-telemetry` section
# of ~/.pi/agent/settings.json; this script neither reads nor copies them.
#
# PI_TELEMETRY_TRACE_ID pins the root trace id so the run dir can name it (the
# extension otherwise generates one internally and never prints it).
# PI_TELEMETRY_TASK_RUN_ID rides along on every span, which is how these runs
# stay separable from ordinary pi usage in the same langfuse project.
TELEMETRY="$HOME/.pi/agent/npm/node_modules/@amaster.ai/pi-telemetry/dist/index.js"
telemetry_args=()
if [ -f "$TELEMETRY" ]; then
	PI_TELEMETRY_TRACE_ID="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
	export PI_TELEMETRY_TRACE_ID
	export PI_TELEMETRY_TASK_RUN_ID="agent-smoke/$ARM/$INSTANCE"
	telemetry_args=(-e "$TELEMETRY")
	{
		echo "trace_id:    $PI_TELEMETRY_TRACE_ID"
		echo "task_run_id: $PI_TELEMETRY_TASK_RUN_ID"
	} > "$RUN/langfuse.txt"
	LANGFUSE_NOTE="trace $PI_TELEMETRY_TRACE_ID"
else
	LANGFUSE_NOTE="skipped, @amaster.ai/pi-telemetry not installed"
fi

echo "arm:       $ARM"
echo "workspace: $RUN/workspace"
echo "memo home: $PI_MEMO_HOME"
echo "langfuse:  $LANGFUSE_NOTE"
echo "running pi..."

# -ne/-ns/-nc: load nothing but pi-memo and, when present, telemetry.
cd "$RUN/workspace"
pi -p --mode json -ne -ns -nc \
  -e "$REPO_ROOT/index.ts" ${telemetry_args[@]+"${telemetry_args[@]}"} \
  "$(cat "$RUN/prompt.txt")" \
  > "$RUN/trace.jsonl" 2> "$RUN/stderr.log" || echo "pi exited non-zero (see stderr.log)"

# The candidate SWE-bench patch, minus anything pi-memo itself wrote.
git -C "$RUN/workspace" diff -- . ':(exclude).pi' > "$RUN/patch.diff" || true

echo "done -> $RUN"
