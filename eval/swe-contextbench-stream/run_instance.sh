#!/usr/bin/env bash
# One instance: build an isolated workspace and environment, hand the task to a
# real pi agent with pi-memo loaded, then grade what it produced.
#
#   ./run_instance.sh --instance sympy__sympy-12419 --run runs/<id>/C1/experience \
#       --global-store <dir> [--project-seed <dir>] [--project-out <dir>]
#
# --global-store   PI_MEMO_HOME for this run. Carried across instances by
#                  run_stream.sh, so global memories persist.
# --project-seed   a project store to copy into the workspace before the run.
#                  Omitted for an experience run (nothing to carry yet) and for
#                  the whole `fresh` arm.
# --project-out    where to copy the workspace's project store after the run.
#
# Everything the run touched is kept under --run. The real ~/.pi/memo is never
# read or written: the global store is --global-store and the project store lives
# inside the throwaway workspace.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"

INSTANCE="" RUN="" GLOBAL_STORE="" PROJECT_SEED="" PROJECT_OUT=""
while [ $# -gt 0 ]; do
	case "$1" in
		--instance) INSTANCE="$2"; shift 2 ;;
		--run) RUN="$2"; shift 2 ;;
		--global-store) GLOBAL_STORE="$2"; shift 2 ;;
		--project-seed) PROJECT_SEED="$2"; shift 2 ;;
		--project-out) PROJECT_OUT="$2"; shift 2 ;;
		*) echo "unknown argument: $1" >&2; exit 1 ;;
	esac
done
[ -n "$INSTANCE" ] && [ -n "$RUN" ] && [ -n "$GLOBAL_STORE" ] || {
	echo "usage: run_instance.sh --instance <id> --run <dir> --global-store <dir> [--project-seed <dir>] [--project-out <dir>]" >&2
	exit 1
}
require_tools

# Absolutise every path argument. build_venv's import check runs inside a subshell
# that cds into the workspace, so a relative --run silently resolves against the
# wrong directory there. run_stream.sh always passes absolute paths; a hand-run
# does not have to.
abspath() { python3 -c "import os,sys;print(os.path.abspath(sys.argv[1]))" "$1"; }
RUN="$(abspath "$RUN")"
GLOBAL_STORE="$(abspath "$GLOBAL_STORE")"
[ -n "$PROJECT_SEED" ] && PROJECT_SEED="$(abspath "$PROJECT_SEED")"
[ -n "$PROJECT_OUT" ] && PROJECT_OUT="$(abspath "$PROJECT_OUT")"

# MEMO_EXT: which build of pi-memo to load. Defaults to this checkout.
MEMO_EXT="${MEMO_EXT:-$REPO_ROOT/index.ts}"
SANDBOX="$(sandbox_path)"

mkdir -p "$RUN"
WS="$RUN/workspace"
# The venv lives INSIDE the workspace. pi-sandbox confines the agent's bash tool to
# the workspace (it puts the agent's HOME there too), so a venv one directory up is
# not reachable and `python` falls back to the system interpreter -- 3.14 here,
# which cannot even import a 2017 sympy. The first run of C1 did exactly that and
# spent its memory_write on `legacy-sympy-python314-compat`: a fact about our
# harness, not about the task, which is the failure ../agent-smoke/NOTES.md 结论 6
# already named once. ../agent-smoke/run.sh puts it at workspace/.venv for the same
# reason. The gold gate keeps its venv outside because it rebuilds the workspace
# between the two halves.
VENV="$WS/.venv"

build_workspace "$INSTANCE" "$WS" run
build_venv "$INSTANCE" "$VENV" "$WS"
# Written after the clone so it stays untracked and out of the candidate patch.
write_sandbox_config "$WS" sympy

# Seed the project store. It lives at <repo root>/.pi/memo (src/store/paths.ts),
# and the workspace is rebuilt for every instance, so a memory written during the
# experience run only survives into the next one if it is copied in here. The
# whole directory goes, .cache/ and .local/usage.json included: hit and recency
# ranking read usage, and a store restored without it ranks differently than the
# one the previous run left behind.
mkdir -p "$GLOBAL_STORE"
if [ -n "$PROJECT_SEED" ] && [ -d "$PROJECT_SEED" ]; then
	mkdir -p "$WS/.pi/memo"
	cp -a "$PROJECT_SEED/." "$WS/.pi/memo/"
	echo "seeded project store from $PROJECT_SEED"
fi

python3 "$HERE/prompt.py" "$INSTANCE" > "$RUN/prompt.txt"
PYTHONPATH="$HERE" python3 -c "
import json,sys,instance
json.dump(instance.load(sys.argv[1]), open(sys.argv[2],'w'), indent=2)" "$INSTANCE" "$RUN/instance.json"
echo "$MEMO_EXT" > "$RUN/extension-path.txt"

export PI_MEMO_HOME="$GLOBAL_STORE"
export PATH="$VENV/bin:$PATH"
export PYTHONPATH="$WS"

# Langfuse tracing. The telemetry extension is a pi package, so -ne skips it --
# load it explicitly. PI_TELEMETRY_TASK_RUN_ID rides along on every span and is
# the only reliable way to find the run again; PI_TELEMETRY_TRACE_ID is not set
# because `pi -p` never reaches the handler that would apply it
# (../agent-smoke/run.sh has the full story).
TELEMETRY="$HOME/.pi/agent/npm/node_modules/@amaster.ai/pi-telemetry/dist/index.js"
telemetry_args=()
if [ -f "$TELEMETRY" ]; then
	export PI_TELEMETRY_TASK_RUN_ID="swecb-stream/$(basename "$(dirname "$RUN")")/$INSTANCE"
	telemetry_args=(-e "$TELEMETRY")
	echo "task_run_id: $PI_TELEMETRY_TASK_RUN_ID" > "$RUN/langfuse.txt"
fi

echo "instance:  $INSTANCE"
echo "workspace: $WS"
echo "memo home: $PI_MEMO_HOME"
echo "sandbox:   $SANDBOX (network: deny all)"
echo "running pi..."

started=$(date +%s)
(
	cd "$WS"
	pi -p --mode json -ne -ns -nc \
		-e "$MEMO_EXT" -e "$SANDBOX" ${telemetry_args[@]+"${telemetry_args[@]}"} \
		"$(cat "$RUN/prompt.txt")"
) > "$RUN/trace.jsonl" 2> "$RUN/stderr.log" || echo "pi exited non-zero (see stderr.log)"
echo $(( $(date +%s) - started )) > "$RUN/seconds.txt"

# Keep the store as the agent left it, before grading touches the tree.
[ -d "$WS/.pi/memo" ] && cp -a "$WS/.pi/memo" "$RUN/memo-project-after" || true
if [ -n "$PROJECT_OUT" ] && [ -d "$WS/.pi/memo" ]; then
	rm -rf "$PROJECT_OUT"
	mkdir -p "$(dirname "$PROJECT_OUT")"
	cp -a "$WS/.pi/memo" "$PROJECT_OUT"
fi

# The candidate patch: product code only. `.pi` is pi-memo's own output, and the
# official test files belong to the benchmark -- two of three agent-smoke runs
# edited the test file on their way to a fix (NOTES.md 结论 3, 结论 8), and
# grade.py reverts those before scoring, so they must not count as a patch either.
exclude_args=(":(exclude).pi")
while IFS= read -r f; do [ -n "$f" ] && exclude_args+=(":(exclude)$f"); done < <(field "$INSTANCE" test_files)
git -C "$WS" diff -- . "${exclude_args[@]}" > "$RUN/patch.diff" || true

# How many times the agent tried to reach the network and was refused. Non-zero
# is the evidence that isolation is doing work; zero means either it never tried
# or the sandbox is off -- check stderr.log before believing it. Each client
# renders the refused CONNECT differently, hence the three alternatives.
grep -ciE 'tunnel( connection)? failed|blocked by network allowlist|is blocked \(not in allowedDomains\)' \
	"$RUN/trace.jsonl" > "$RUN/net-blocked-count.txt" || true

python3 "$HERE/trace_metrics.py" --run "$RUN"
# The gold gate's exclusion list travels with the instance, so an agent run is
# scored on exactly the tests the gate proved can distinguish a fix from no fix.
exclude_arg=()
[ -f "$HERE/gold/$INSTANCE/excluded_p2p.json" ] && exclude_arg=(--exclude-file "$HERE/gold/$INSTANCE/excluded_p2p.json")
python3 "$HERE/grade.py" --instance "$INSTANCE" --workspace "$WS" --venv "$VENV" \
	--out "$RUN/grade.json" --log "$RUN/pytest.log" ${exclude_arg[@]+"${exclude_arg[@]}"} || true

if [ -f "$RUN/langfuse.txt" ] && [ -f "$HERE/../agent-smoke/langfuse_lookup.py" ]; then
	python3 "$HERE/../agent-smoke/langfuse_lookup.py" "$PI_TELEMETRY_TASK_RUN_ID" >> "$RUN/langfuse.txt" || true
fi

echo "done -> $RUN"
