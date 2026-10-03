#!/usr/bin/python3
"""statusline_sources.py — the footer's slow sources, computed OFF the Pi render path (request 2026-09-27).

ai-cost-status.ts runs this asynchronously (execFile, ≥60 s timer) and keeps the JSON in memory; the footer's
render() only reads memory. One process, one JSON line on stdout, ~0.1 s. Never writes anything.

  statusline_sources.py --session <pi session uuid> [--artifact-dir <parent artifact dir>]

Output keys (every one may be null = "unknown", which the footer renders as nothing — calm, never a false alarm):
  me       Director label whose CURRENT binding is this session (director/om_current.json, the projection
           director_om.current_gen() reads; no Herdr call).  e.g. "DIR-wos", "Butler".
  owner     len(director_brief.compute()[me]["owner"]) — this Director's "need the owner" rows (same function the brief uses).
  overdue  this session's dispatch records that are non-final (reserved|live|indeterminate), older than
           2 × expectedRuntimeMs (undeclared → 30 min), and have no report-delivery receipt — the record-level
           half of pi-interactive-subagents overdue-sweep.ts (no /proc, no herdr, no transcript reads).
  cache    {"hit": 0.81, "n": 20} iff cache_monitor's latest snapshot lists THIS session in hit_floor_breaches
           (the health-audit floor, policy.hit_floor); read, never recomputed.
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime

WDB = os.environ.get("WOS_WDB") or os.path.expanduser("~/.wos-runtime")
OM_CURRENT = os.environ.get("STATUSLINE_OM_CURRENT") or os.path.join(WDB, "director", "om_current.json")
CACHE_HEALTH = os.environ.get("STATUSLINE_CACHE_HEALTH") or os.path.join(WDB, "butler", "state", "cache_health.json")
BUTLER_DIR = os.environ.get("STATUSLINE_BUTLER_DIR") or os.path.join(WDB, "butler")
NON_FINAL = {"reserved", "live", "indeterminate"}
OVERDUE_MULTIPLIER = 2
UNDECLARED_MS = 30 * 60_000


def _load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def who_am_i(session):
    doc = _load(OM_CURRENT)
    if not isinstance(doc, dict) or not session:
        return None
    hits = [k for k, v in doc.items() if isinstance(v, dict) and v.get("session_uuid") == session]
    return hits[0] if len(hits) == 1 else None  # ambiguous binding ⇒ no label, never a guess


def need_bing(me):
    if not me:
        return None
    try:
        sys.path.insert(0, BUTLER_DIR)
        import director_brief  # noqa: E402
        scopes = director_brief.compute()
        scope = scopes.get(me)
        return len(scope["owner"]) if scope else None
    except Exception:  # noqa: BLE001 — a broken brief shows nothing, never a crash
        return None


def _ms(iso):
    if not iso:
        return None
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def _receipt(artifact_dir, rec):
    run = rec.get("runGeneration") or "legacy:%s" % (rec.get("startedAt") or rec.get("claimedAt") or "")
    key = "%s\x00%s\x00%s\x00%s" % (rec.get("parentSessionId"), rec.get("name"), rec.get("childSessionFile"), run)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", str(rec.get("name") or ""))[:80] or "subagent"
    return os.path.join(artifact_dir, "report-delivery", "%s.%s.json" % (safe, digest))


def overdue(artifact_dir, now_ms):
    if not artifact_dir or not os.path.isdir(os.path.join(artifact_dir, "dispatch")):
        return None
    n = 0
    for path in glob.glob(os.path.join(artifact_dir, "dispatch", "*.json")):
        rec = _load(path)
        if not isinstance(rec, dict) or rec.get("state") not in NON_FINAL:
            continue
        exp = rec.get("expectedRuntimeMs")
        exp = exp if isinstance(exp, (int, float)) and exp > 0 else UNDECLARED_MS
        start = _ms(rec.get("startedAt") or rec.get("claimedAt"))
        if start is None:
            try:
                start = os.path.getmtime(path) * 1000
            except OSError:
                continue
        if now_ms - start <= OVERDUE_MULTIPLIER * exp:
            continue
        if rec.get("childSessionFile") and os.path.exists(_receipt(artifact_dir, rec)):
            continue
        n += 1
    return n


def cache_floor(session):
    doc = _load(CACHE_HEALTH)
    if not isinstance(doc, dict) or not session:
        return None
    for row in doc.get("hit_floor_breaches") or []:
        if isinstance(row, dict) and (row.get("session") == session or session in str(row.get("path") or "")):
            hit = row.get("hit")
            return {"hit": hit if isinstance(hit, (int, float)) else None, "n": row.get("n")}
    return None


def main(argv):
    args = {}
    it = iter(argv)
    for a in it:
        if a in ("--session", "--artifact-dir"):
            args[a] = next(it, "")
    session = args.get("--session", "")
    me = who_am_i(session)
    out = {"me": me, "owner": need_bing(me), "overdue": overdue(args.get("--artifact-dir"), time.time() * 1000),
           "cache": cache_floor(session)}
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
