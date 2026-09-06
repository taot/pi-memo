#!/usr/bin/env python3
"""Resolve one run's langfuse trace by its task_run_id and print the ids.

The extension mints both the trace id and the session id internally (a preset
PI_TELEMETRY_TRACE_ID is only applied inside its `input` handler, which `pi -p`
never reaches, and the session id is a fresh randomUUID either way). So neither is
knowable before the run -- the only handle we control is PI_TELEMETRY_TASK_RUN_ID,
which langfuse stores as `metadata.taskRunId`. This looks the trace up by it.

Reads the langfuse credentials from ~/.pi/agent/settings.json (`pi-telemetry`
section), sends them only to the baseUrl configured there, and never prints them.
Exits 0 with a note when anything is missing, so a run is never failed by telemetry.

    langfuse_lookup.py <task_run_id> [--timeout SECONDS]
"""

import base64
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SETTINGS = Path.home() / ".pi/agent/settings.json"


def api(base, auth, path, timeout=20):
    req = urllib.request.Request(
        base.rstrip("/") + path, headers={"Authorization": f"Basic {auth}"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def main() -> None:
    task_run_id = sys.argv[1]
    # Ingestion is batched, so the trace can lag the process exit by a few seconds.
    deadline = time.time() + (
        float(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[2] == "--timeout" else 60.0
    )

    try:
        cfg = json.loads(SETTINGS.read_text())["pi-telemetry"]["langfuse"]
        base = cfg["baseUrl"]
        auth = base64.b64encode(
            f"{cfg['publicKey']}:{cfg['secretKey']}".encode()
        ).decode()
    except (OSError, KeyError, ValueError) as exc:
        print(f"lookup skipped: no usable langfuse config ({exc})")
        return

    while True:
        try:
            traces = api(base, auth, "/api/public/traces?limit=50")["data"]
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            print(f"lookup failed: {exc}")
            return
        hits = [
            t for t in traces if (t.get("metadata") or {}).get("taskRunId") == task_run_id
        ]
        if hits or time.time() >= deadline:
            break
        time.sleep(5)

    if not hits:
        print(f"lookup found no trace for taskRunId {task_run_id} (still ingesting?)")
        return

    try:
        project = api(base, auth, "/api/public/projects")["data"][0]["id"]
    except Exception:  # noqa: BLE001 - a missing project id only costs the URL line
        project = None

    # More than one trace per run means pi took several turns; list them all.
    for t in sorted(hits, key=lambda t: t["timestamp"]):
        print(f"trace_id:    {t['id']}")
        print(f"session_id:  {t.get('sessionId')}")
        print(f"timestamp:   {t['timestamp']}")
        if project:
            print(f"trace_url:   {base.rstrip('/')}/project/{project}/traces/{t['id']}")
            print(
                f"session_url: {base.rstrip('/')}/project/{project}"
                f"/sessions/{t.get('sessionId')}"
            )


if __name__ == "__main__":
    main()
