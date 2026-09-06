#!/usr/bin/env bash
# Gold gate. Before any agent run, prove the harness can tell a solved instance
# from an unsolved one:
#
#   without the gold patch -> every FAIL_TO_PASS test must FAIL
#   with the gold patch    -> every FAIL_TO_PASS and PASS_TO_PASS test must PASS
#
# An instance that misses either half is not gradeable here and gets dropped from
# the subset. Costs no LLM budget, so it runs first and it runs on all of them.
#
#   ./validate_gold.sh                       # every instance in subset.json
#   ./validate_gold.sh sympy__sympy-12419    # just these
#
# Workspaces land in gold/<instance_id>/ and are kept: a failing gate is something
# you want to poke at, and a passing one proves the venv recipe works.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib.sh"
require_tools

if [ $# -gt 0 ]; then
	INSTANCES=("$@")
else
	mapfile -t INSTANCES < <(PYTHONPATH="$HERE" python3 -c "
import instance
for i in instance.all_instances(): print(i)")
fi

OUT="$HERE/gold"
mkdir -p "$OUT"

for id in "${INSTANCES[@]}"; do
	echo "=== $id"
	ws="$OUT/$id/workspace"
	build_workspace "$id" "$ws" gold
	venv="$OUT/$id/venv"
	build_venv "$id" "$venv" "$ws"

	# Pre-state: tests exist (grade.py applies test_patch) but the fix does not.
	python3 "$HERE/grade.py" --instance "$id" --workspace "$ws" --venv "$venv" \
		--out "$OUT/$id/pre.json" --log "$OUT/$id/pre.log" || true

	# Post-state: same tree plus the gold patch. Rebuilt from scratch so the gold
	# patch applies to a clean base rather than on top of the test patch's context.
	build_workspace "$id" "$ws" gold
	python3 "$HERE/instance.py" "$id" patch > "$ws/.git/swecb-gold.patch"
	git -C "$ws" apply "$ws/.git/swecb-gold.patch"
	python3 "$HERE/grade.py" --instance "$id" --workspace "$ws" --venv "$venv" \
		--out "$OUT/$id/post.json" --log "$OUT/$id/post.log" || true

	python3 "$HERE/gate_verdict.py" "$OUT/$id" "$id"
done

echo
echo "=== summary"
python3 - "$OUT" <<'PY'
import json, sys
from pathlib import Path
rows = sorted(Path(sys.argv[1]).glob("*/gate.json"))
for r in rows:
    v = json.loads(r.read_text())
    excl = f"  ({v['excluded_p2p_count']} of {v['p2p_total']} P2P excluded)" if v["excluded_p2p_count"] else ""
    print(f"{v['gate']:5s} {v['instance_id']}{excl}")
n = sum(json.loads(r.read_text())["gate"] == "pass" for r in rows)
print(f"{n}/{len(rows)} instances gradeable")
PY
