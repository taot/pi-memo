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

# CREATED_AT dates the dependency resolution, so the env matches what the instance
# was written against rather than what PyPI serves today.
read -r INSTANCE BASE CREATED_AT <<<"$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
print(d['instance_id'], d['base_commit'], d['created_at'])
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

# Network isolation. pi-sandbox is a pi package, so -ne skips it just like
# telemetry -- and every run before this one was therefore UNSANDBOXED, which is
# how the agent reached the upstream fix over HTTP (NOTES.md 结论 4). It wraps only
# the bash tool, so pi's own calls to the model API are unaffected.
SANDBOX="$HOME/.pi/agent/npm/node_modules/pi-sandbox/index.ts"
[ -f "$SANDBOX" ] || { echo "pi-sandbox not installed; refusing to run unsandboxed" >&2; exit 1; }
# Without rg, pi-sandbox catches its own init failure and continues with the
# sandbox silently OFF (pi-sandbox/src/extension.ts:128-135). Fail here instead.
command -v rg >/dev/null || { echo "pi-sandbox needs ripgrep (rg) on PATH" >&2; exit 1; }

# Deny all egress. The task is a local code fix and needs no network at all, while
# the inherited allowlist names github.com, api.github.com, raw.githubusercontent.com
# and pypi.org outright -- any one of which hands over the answer. Arrays merge as a
# union of global+project (pi-sandbox/src/config.ts:75-147), so a project file cannot
# remove those; deniedDomains is checked first and wins, and "*" matches every host.
# allowAllUnixSockets:false restores the seccomp AF_UNIX block that the global config
# turns off, closing the unix-socket path out of the namespace.
#
# Written after the snapshot commit so it stays untracked and out of patch.diff.
mkdir -p "$RUN/workspace/.pi"
cat > "$RUN/workspace/.pi/sandbox.json" <<'JSON'
{
  "network": { "deniedDomains": ["*"] },
  "allowAllUnixSockets": false
}
JSON

# Working Python environment, built here (outside the sandbox) because the agent
# has no network. Without it the agent cannot run the tests, so it verifies with
# `py_compile` and then records "this checkout has no dependencies" as its lesson --
# a fact about our harness, not about the task.
#
# --exclude-newer resolves as of the instance's own date: flask 2.0 declares
# `Werkzeug>=2.0`, which today means Werkzeug 3.x and a broken import. It also pins
# setuptools back to 2021, which has no `build_editable` -- hence a plain install
# plus PYTHONPATH=src rather than `-e .`. src-layout means the agent's edits take
# effect with no reinstall. setuptools is explicit because uv venv omits it and two
# tests need pkg_resources; flask itself is uninstalled so only src/ is importable.
VENV="$RUN/workspace/.venv"
uv venv --quiet --python 3.9 "$VENV"
(
	cd "$RUN/workspace"
	install_args=(. setuptools)
	[ -f requirements/tests.txt ] && install_args+=(-r requirements/tests.txt)
	uv pip install --python "$VENV/bin/python" --exclude-newer "$CREATED_AT" --quiet \
		"${install_args[@]}"
)
uv pip uninstall --python "$VENV/bin/python" --quiet flask
# Keep it out of the agent's `git status`; patch.diff only tracks tracked files anyway.
echo ".venv/" >> "$RUN/workspace/.git/info/exclude"

export PATH="$VENV/bin:$PATH"
export PYTHONPATH="$RUN/workspace/src"

if ! (cd "$RUN/workspace" && PYTHONPATH="$RUN/workspace/src" "$VENV/bin/python" -c "import flask" 2>/dev/null); then
	echo "python env build failed: cannot import flask from src/" >&2
	exit 1
fi

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
echo "sandbox:   $SANDBOX (network: deny all)"
echo "running pi..."

# -ne/-ns/-nc: load nothing but pi-memo, pi-sandbox and, when present, telemetry.
cd "$RUN/workspace"
pi -p --mode json -ne -ns -nc \
  -e "$REPO_ROOT/index.ts" -e "$SANDBOX" ${telemetry_args[@]+"${telemetry_args[@]}"} \
  "$(cat "$RUN/prompt.txt")" \
  > "$RUN/trace.jsonl" 2> "$RUN/stderr.log" || echo "pi exited non-zero (see stderr.log)"

# The candidate SWE-bench patch, minus anything pi-memo itself wrote.
git -C "$RUN/workspace" diff -- . ':(exclude).pi' > "$RUN/patch.diff" || true

# How many times the agent tried to reach the network and was refused. Non-zero is
# expected and is the evidence that isolation is doing work; zero means either the
# agent never tried, or the sandbox is off -- check stderr.log before believing it.
#
# The proxy's own text ("Connection blocked by network allowlist") only shows up if
# the client prints the response body, which curl -o /dev/null and git never do.
# What actually lands in the trace is each client's rendering of the refused
# CONNECT: git says "CONNECT tunnel failed, response 403", urllib says "Tunnel
# connection failed: 403 Forbidden". Match those too, or this reports 0 on a run
# where the agent tried three times and was blocked every time.
grep -ciE 'tunnel( connection)? failed|blocked by network allowlist|is blocked \(not in allowedDomains\)' \
	"$RUN/trace.jsonl" > "$RUN/net-blocked-count.txt" || true

echo "done -> $RUN"
