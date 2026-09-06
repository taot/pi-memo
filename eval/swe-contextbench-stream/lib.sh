# Shared pieces of a run: the workspace, the Python environment and the sandbox
# config. Sourced by validate_gold.sh and run_instance.sh.
#
# Every non-obvious line here was paid for once already in ../agent-smoke/NOTES.md;
# the comments say which conclusion.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SYMPY_REPO="$HERE/repos/sympy"

field() { python3 "$HERE/instance.py" "$1" "$2"; }

# Far future: build backends are not part of what --exclude-newer is pinning.
BUILD_DEPS_CUTOFF="2030-01-01T00:00:00Z"

require_tools() {
	for t in git uv python3 jq; do
		command -v "$t" >/dev/null || { echo "missing $t" >&2; exit 1; }
	done
	[ -d "$SYMPY_REPO/.git" ] || {
		echo "no sympy clone at $SYMPY_REPO -- git clone https://github.com/sympy/sympy repos/sympy" >&2
		exit 1
	}
}

# build_workspace <instance_id> <dest> [tag]
#
# Real history truncated at base_commit: everything the repository knew at the
# time, nothing after it. A worktree or a plain local clone shares every ref and
# lets the agent read the upstream fix straight out of `git log --all`
# (NOTES.md 结论 2); a single synthetic commit closes that but also takes away the
# repository's own past, which a real checkout has (结论 7).
build_workspace() {
	local id="$1" dest="$2" tag="${3:-run}"
	local base; base="$(field "$id" base_commit)"
	local branch="eval-snapshot-$tag-$id-$$"

	rm -rf "$dest"
	mkdir -p "$(dirname "$dest")"
	git -C "$SYMPY_REPO" worktree prune
	git -C "$SYMPY_REPO" branch -f "$branch" "$base"
	# file:// (not a plain path) forces the git transport: a local-path clone
	# hardlinks the whole object database and ignores --depth. --single-branch also
	# keeps out the tags newer than base.
	git clone --quiet --depth "${DEPTH:-500}" --single-branch --branch "$branch" \
		"file://$SYMPY_REPO" "$dest"
	git -C "$SYMPY_REPO" branch -q -D "$branch"
	# The clone is self-contained (no alternates), so dropping the remote leaves
	# nothing pointing back at the full repo.
	git -C "$dest" remote remove origin
	git -C "$dest" branch -m "$branch" main

	assert_workspace "$dest" "$base"
	echo ".venv/" >> "$dest/.git/info/exclude"
	echo ".pi/" >> "$dest/.git/info/exclude"
}

# The four properties the truncation has to have. Checked every time, not once.
assert_workspace() {
	local dest="$1" base="$2"
	[ "$(git -C "$dest" rev-parse HEAD)" = "$base" ] || { echo "workspace HEAD is not $base" >&2; exit 1; }
	[ -f "$dest/.git/shallow" ] || { echo "workspace clone is not shallow" >&2; exit 1; }
	[ -z "$(git -C "$dest" rev-list --all --not HEAD)" ] || { echo "workspace has commits outside base" >&2; exit 1; }
	[ -z "$(git -C "$dest" remote)" ] || { echo "workspace still has a remote" >&2; exit 1; }
}

# build_venv <instance_id> <venv_dir> <workspace>
#
# sympy is a flat layout -- the package IS the repo root -- so nothing is
# installed from the workspace and PYTHONPATH=<workspace> makes the agent's edits
# take effect with no reinstall. That avoids flask's install-then-uninstall dance
# (结论 6) entirely.
#
# --exclude-newer dates dependency resolution at the instance's own date, so the
# environment matches what the instance was written against rather than what PyPI
# serves today. It covers mpmath, sympy's one runtime dependency.
#
# pytest is deliberately NOT pinned to the instance date: the 2017-era pytest that
# --exclude-newer selects does not install on any interpreter uv can fetch. The
# gold gate is what decides whether a modern pytest can run an old sympy.
# The venv lives OUTSIDE the workspace: the workspace is rebuilt between the two
# halves of the gold gate, and a venv inside it would be deleted along with it.
build_venv() {
	local id="$1" venv="$2" ws="$3"
	local created; created="$(field "$id" created_at)"
	local pyver; pyver="$(field "$id" pyver)"
	uv venv --quiet --clear --python "$pyver" "$venv"
	# setuptools/wheel are exempt from the cutoff: mpmath 0.19 ships no wheel, and
	# the 2017 setuptools --exclude-newer would otherwise pick has no PEP 517
	# backend, so the sdist cannot be built at all. Only the runtime dependency's
	# own version is what the date is meant to pin.
	uv pip install --python "$venv/bin/python" --quiet --exclude-newer "$created" \
		--exclude-newer-package "setuptools=$BUILD_DEPS_CUTOFF" \
		--exclude-newer-package "wheel=$BUILD_DEPS_CUTOFF" \
		mpmath
	uv pip install --python "$venv/bin/python" --quiet ${PYTEST_SPEC:-pytest}
	"$venv/bin/python" -c "import mpmath" || { echo "venv build failed for $id" >&2; exit 1; }
	(cd "$ws" && PYTHONPATH="$ws" "$venv/bin/python" -c "import sympy") \
		|| { echo "cannot import sympy from $ws" >&2; exit 1; }
}

# write_sandbox_config <workspace> <package>
#
# Deny all egress. The task is a local code fix and needs no network, while the
# inherited allowlist names github.com and pypi.org outright -- and instance_id IS
# the PR number, so `git ls-remote ... refs/pull/<id>/head` is a one-command path
# to the answer (结论 8). Arrays merge as a union of global+project, so a project
# file cannot remove those; deniedDomains is checked first and wins, and "*"
# matches every host. allowAllUnixSockets:false restores the seccomp AF_UNIX block
# the global config turns off.
#
# And deny reading any system-installed copy of the package under test. This host
# carries sympy 1.14.0 at /usr/lib/python3.14/site-packages/sympy -- a release that
# contains the merged fix for every instance in the subset. pi-sandbox's default
# denyRead is ["/Users", "/home"], which covers other checkouts and uv's cache but
# says nothing about /usr, so the first full run walked straight in: three of eight
# related runs read it (16946 touched it 56 times) and one wrote the lesson down as
# `consult-system-sympy-when-offline`, noting that shell reads get around the read
# tool's own path denial. Same shape as the git-history leak (结论 2) and the
# network leak (结论 4): the fix exists somewhere the agent can reach, so it stops
# solving and starts copying.
#
# The paths are computed rather than hardcoded because this is not a sympy problem
# -- any repo whose package is also installed system-wide has it.
write_sandbox_config() {
	local ws="$1" pkg="$2"
	mkdir -p "$ws/.pi"
	python3 - "$ws/.pi/sandbox.json" "$pkg" <<'PYEOF'
import glob, json, os, sys

out, pkg = sys.argv[1], sys.argv[2]
roots = [
    "/usr/lib/python*/site-packages",
    "/usr/lib/python*/dist-packages",
    "/usr/lib64/python*/site-packages",
    "/usr/local/lib/python*/site-packages",
    "/usr/local/lib/python*/dist-packages",
]
# Deduplicate by real path. /usr/lib64 is a symlink to lib on this host, so the
# globs find the same directory twice, and handing bubblewrap two hide requests
# for one real path hangs the sandbox before it ever starts the agent -- an empty
# trace.jsonl and an empty stderr.log, ten minutes of nothing.
deny = sorted({os.path.realpath(p) for r in roots for p in glob.glob(f"{r}/{pkg}")})
json.dump(
    {
        "network": {"deniedDomains": ["*"]},
        "allowAllUnixSockets": False,
        "filesystem": {"denyRead": deny},
    },
    open(out, "w"),
    indent=2,
)
print(f"sandbox denyRead: {deny or '(no system copy of ' + pkg + ' found)'}")
PYEOF
}

# Path to pi-sandbox, refusing to continue without it. Without rg, pi-sandbox
# catches its own init failure and continues with the sandbox silently OFF
# (pi-sandbox/src/extension.ts:128-135), which is how every run before 结论 4 was
# unsandboxed -- fail here instead.
sandbox_path() {
	local sandbox="$HOME/.pi/agent/npm/node_modules/pi-sandbox/index.ts"
	[ -f "$sandbox" ] || { echo "pi-sandbox not installed; refusing to run unsandboxed" >&2; exit 1; }
	command -v rg >/dev/null || { echo "pi-sandbox needs ripgrep (rg) on PATH" >&2; exit 1; }
	echo "$sandbox"
}
