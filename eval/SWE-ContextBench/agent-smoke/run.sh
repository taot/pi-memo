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
# MEMO_EXT: which build of pi-memo to load. Defaults to this checkout; point it at
# another tree (e.g. `git archive <sha>` unpacked with node_modules symlinked) to run
# an arm against an older version of the extension.
MEMO_EXT="${MEMO_EXT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/index.ts}"
RUN="$HERE/runs/$ARM"

# CREATED_AT dates the dependency resolution, so the env matches what the instance
# was written against rather than what PyPI serves today.
read -r INSTANCE BASE CREATED_AT <<<"$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
print(d['instance_id'], d['base_commit'], d['created_at'])
" "$HERE/instance.json")"

# Fresh workspace: real history truncated at base_commit. A worktree (or a plain
# clone) of repos/flask shares every ref, which lets the agent find the upstream fix
# with `git log --all` and copy it -- see NOTES.md. The earlier fix went the other
# way and gave the agent a single synthetic commit, which removes the leak but also
# removes something a real checkout has: the repository's own past. A shallow clone
# of a branch pinned at base_commit gives the true history up to base and nothing
# after it.
#
# file:// (not a plain path) forces the git transport: a local-path clone hardlinks
# the whole object database and ignores --depth.
DEPTH="${DEPTH:-500}"
# ARM is in the name so two arms can build their workspaces at the same time without
# clobbering each other's branch in repos/flask.
SNAP_BRANCH="eval-snapshot-$ARM-$INSTANCE"
rm -rf "$RUN"
# Clears registrations left behind by worktrees from earlier versions of this script.
git -C "$HERE/repos/flask" worktree prune
mkdir -p "$RUN"
git -C "$HERE/repos/flask" branch -f "$SNAP_BRANCH" "$BASE"
git clone --quiet --depth "$DEPTH" --single-branch --branch "$SNAP_BRANCH" \
	"file://$HERE/repos/flask" "$RUN/workspace"
git -C "$HERE/repos/flask" branch -q -D "$SNAP_BRANCH"
# The clone is self-contained (no alternates), so dropping the remote leaves nothing
# pointing back at the full repo -- and no remote-tracking ref to fetch from.
git -C "$RUN/workspace" remote remove origin
git -C "$RUN/workspace" branch -m "$SNAP_BRANCH" main

# The whole point of the truncation: HEAD is base, history is real but shallow, and
# nothing outside base's ancestry is reachable from any ref.
if [ "$(git -C "$RUN/workspace" rev-parse HEAD)" != "$BASE" ]; then
	echo "workspace HEAD is not $BASE" >&2
	exit 1
fi
if [ ! -f "$RUN/workspace/.git/shallow" ]; then
	echo "workspace clone is not shallow" >&2
	exit 1
fi
if [ -n "$(git -C "$RUN/workspace" rev-list --all --not HEAD)" ]; then
	echo "workspace has commits outside base's ancestry" >&2
	exit 1
fi
if [ -n "$(git -C "$RUN/workspace" remote)" ]; then
	echo "workspace still has a remote" >&2
	exit 1
fi

python3 "$HERE/prompt.py" "$ARM" > "$RUN/prompt.txt"
# instance.json is rewritten whenever the task changes; keep the one this run used.
cp "$HERE/instance.json" "$RUN/instance.json"
echo "$MEMO_EXT" > "$RUN/extension-path.txt"

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
# PYVER: the system interpreter is far too new for these pinned dependency sets, so
# uv fetches one. 3.9 suits the 2021 instances; the 2023 ones (flask 2.3) need 3.11,
# where tomllib exists and the resolved wheels are built.
PYVER="${PYVER:-3.9}"
VENV="$RUN/workspace/.venv"
uv venv --quiet --python "$PYVER" "$VENV"
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
# PI_TELEMETRY_TASK_RUN_ID rides along on every span (langfuse stores it as
# metadata.taskRunId), which is how these runs stay separable from ordinary pi usage
# in the same langfuse project -- and it is the ONLY reliable way to find the run.
#
# PI_TELEMETRY_TRACE_ID is deliberately not set: the extension only applies a preset
# id inside its `input` handler (pi-telemetry/dist/extension.js:216), which `pi -p`
# never reaches, so it falls back to a random id (line 227-228) and the id we printed
# matched nothing in langfuse. Verified: the three runs are there under their
# taskRunId, with ids the extension minted itself.
TELEMETRY="$HOME/.pi/agent/npm/node_modules/@amaster.ai/pi-telemetry/dist/index.js"
telemetry_args=()
if [ -f "$TELEMETRY" ]; then
	export PI_TELEMETRY_TASK_RUN_ID="agent-smoke/$ARM/$INSTANCE"
	telemetry_args=(-e "$TELEMETRY")
	{
		echo "task_run_id: $PI_TELEMETRY_TASK_RUN_ID"
		echo "started:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
		echo
		echo "Find it in langfuse by metadata.taskRunId (the trace id is minted by the"
		echo "extension and is not knowable from here):"
		echo "  Traces -> filter Metadata taskRunId = $PI_TELEMETRY_TASK_RUN_ID"
	} > "$RUN/langfuse.txt"
	LANGFUSE_NOTE="task_run_id $PI_TELEMETRY_TASK_RUN_ID"
else
	LANGFUSE_NOTE="skipped, @amaster.ai/pi-telemetry not installed"
fi

echo "arm:       $ARM"
echo "extension: $MEMO_EXT"
echo "workspace: $RUN/workspace"
echo "memo home: $PI_MEMO_HOME"
echo "langfuse:  $LANGFUSE_NOTE"
echo "sandbox:   $SANDBOX (network: deny all)"
echo "running pi..."

# -ne/-ns/-nc: load nothing but pi-memo, pi-sandbox and, when present, telemetry.
cd "$RUN/workspace"
pi -p --mode json -ne -ns -nc \
  -e "$MEMO_EXT" -e "$SANDBOX" ${telemetry_args[@]+"${telemetry_args[@]}"} \
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

# Resolve the langfuse trace and session ids, which only exist after the run: the
# extension mints both internally (see the PI_TELEMETRY_TRACE_ID note above; the
# session id is a fresh randomUUID at extension init). The lookup goes by
# taskRunId. It reads the langfuse credentials from ~/.pi/agent/settings.json --
# read-only, sent only to the baseUrl configured there, never printed -- and never
# fails the run.
if [ -f "$RUN/langfuse.txt" ]; then
	python3 "$HERE/langfuse_lookup.py" "$PI_TELEMETRY_TASK_RUN_ID" >> "$RUN/langfuse.txt" || true
fi

echo "done -> $RUN"
