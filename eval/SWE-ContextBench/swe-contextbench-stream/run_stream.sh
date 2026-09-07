#!/usr/bin/env bash
# The eval proper: for each cluster, solve the experience task, keep whatever
# memory that run left behind, and hand it to each of the related tasks.
#
#   ./run_stream.sh                       # all clusters
#   ./run_stream.sh C1                    # just these
#   RUN_ID=my-run ARM=fresh ./run_stream.sh
#
# ARM=persistent (default)
#   memory carries from the experience run into every related run of its cluster.
#   This is the condition under test.
#
# ARM=fresh
#   identical in every other respect, but each instance starts from an empty
#   store. The baseline that would let a resolve-rate difference be attributed to
#   memory. Built in, deliberately not run yet: with only the persistent arm, the
#   results say what the agent did with memory, not whether memory helped.
#
# The related tasks of one cluster FAN OUT: each starts from the same snapshot
# taken right after the experience run, not from whatever the previous related
# run left. One experience thereby gets two or three independent observations,
# and a later task cannot inherit an earlier task's memories -- which would make
# it impossible to say which memory did the work.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"
require_tools

ARM="${ARM:-persistent}"
case "$ARM" in persistent|fresh) ;; *) echo "ARM must be persistent or fresh" >&2; exit 1 ;; esac
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M)-$ARM}"
ROOT="$HERE/runs/$RUN_ID"

mapfile -t WANT < <(PYTHONPATH="$HERE" python3 -c "
import instance, sys
want = sys.argv[1:]
for c in instance.clusters():
    if not want or c['cluster'] in want:
        print(c['cluster'], c['experience']['instance_id'], *[r['instance_id'] for r in c['related']])
" "$@")
[ "${#WANT[@]}" -gt 0 ] || { echo "no clusters selected" >&2; exit 1; }

# Refuse to spend agent runs on an instance the harness cannot score. The gate is
# cheap and must have been run first; see validate_gold.sh.
PYTHONPATH="$HERE" python3 - "$HERE" "${WANT[@]}" <<'PY'
import json, sys
from pathlib import Path
here = Path(sys.argv[1])
ids = [i for line in sys.argv[2:] for i in line.split()[1:]]
missing, failed = [], []
for i in ids:
    g = here / "gold" / i / "gate.json"
    if not g.exists():
        missing.append(i)
    elif json.loads(g.read_text())["gate"] != "pass":
        failed.append(i)
if missing or failed:
    sys.exit(f"gold gate not clean -- missing: {missing} failed: {failed}\nrun ./validate_gold.sh first")
PY

mkdir -p "$ROOT"
{
	echo "run_id:    $RUN_ID"
	echo "arm:       $ARM"
	echo "started:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo "pi_memo:   $(git -C "$REPO_ROOT" rev-parse HEAD)"
	echo "extension: ${MEMO_EXT:-$REPO_ROOT/index.ts}"
	echo "sympy:     $(git -C "$SYMPY_REPO" rev-parse HEAD)"
	echo "clusters:  ${WANT[*]}"
	echo
} >> "$ROOT/manifest.txt"   # appended: the same RUN_ID may be extended one cluster at a time
tail -8 "$ROOT/manifest.txt"

for line in "${WANT[@]}"; do
	read -r cluster experience related <<<"$line"
	# shellcheck disable=SC2206
	related=($related)
	echo
	echo "########## $cluster: $experience -> ${related[*]}"

	GSTORE="$ROOT/$cluster/stores/global"
	PSNAP="$ROOT/$cluster/stores/project-after-experience"
	mkdir -p "$GSTORE"

	if [ "$ARM" = persistent ]; then
		"$HERE/run_instance.sh" --instance "$experience" --run "$ROOT/$cluster/experience" \
			--global-store "$GSTORE" --project-out "$PSNAP"
		# The global store the experience run wrote is what every related run of
		# this cluster starts from, so snapshot it before they can change it.
		cp -a "$GSTORE" "$ROOT/$cluster/stores/global-after-experience"
	else
		# In the fresh arm the experience task is still solved -- it is part of the
		# stream -- but nothing it writes is carried anywhere.
		"$HERE/run_instance.sh" --instance "$experience" --run "$ROOT/$cluster/experience" \
			--global-store "$ROOT/$cluster/experience/global-store"
	fi

	for r in "${related[@]}"; do
		if [ "$ARM" = persistent ]; then
			# Fan-out: each related run gets its own copy of the post-experience
			# global store, so run order cannot leak between them.
			rgstore="$ROOT/$cluster/related-$r/global-store"
			mkdir -p "$(dirname "$rgstore")"
			rm -rf "$rgstore"
			cp -a "$ROOT/$cluster/stores/global-after-experience" "$rgstore"
			"$HERE/run_instance.sh" --instance "$r" --run "$ROOT/$cluster/related-$r" \
				--global-store "$rgstore" --project-seed "$PSNAP"
		else
			"$HERE/run_instance.sh" --instance "$r" --run "$ROOT/$cluster/related-$r" \
				--global-store "$ROOT/$cluster/related-$r/global-store"
		fi
	done
done

echo
python3 "$HERE/report.py" --run "$ROOT"
