#!/usr/bin/python3
"""model_choices.py — the owner's "Model Choices" table, enforced (request 2026-10-03).

  model_choices.py admit   < {"role":…, "roles":[…], "model":…, "source":…, "request_id":…, "session_files":[…]}
        → one JSON verdict on stdout: {"verdict": "admit"|"refuse"|"ungoverned", "kind", "role", "default", "reason",
          "evidence"?}. Exit 0 whenever a verdict was reached (refusals included); exit 2 on bad input.
        Used by the subagent dispatch guard (pi-interactive-subagents model-choice-guard.ts) for every spawn and every
        resume substitution. It never routes a question to the owner.
  model_choices.py check [--offline] [--write-state] [--json]
        → compare the yaml with the live doc (internal-cli google.docs get), the agent profiles and the OM settings; report
          drift. Exit 0 = in sync, 1 = drift, 3 = cannot measure. `--write-state` writes
          fleet/state/model_choices_check.json (read by doctor.d/model_choices.sh).
  model_choices.py replay [--days 7] [--json]
        → re-judge every dispatch record of the window with the table: how many would have been refused.

Policy (the owner 2026-10-03; quotes in the yaml `rulings`):
  * role in the table, model == its default (host aliases applied)            → admit
  * model == an allowed_fallback whose `when` holds, with evidence             → admit (kind=fallback)
      provider_policy_refusal: a PRIOR child of the same request_id and role, on the role default, ended on a provider
      usage-policy/content refusal — read from its dispatch record providerEventLog or its transcript.
  * anything else                                                              → refuse back to the dispatching agent
  * availability (503/429/unroutable) is never a fallback condition: the dispatcher retries the SAME model later
    (or leaves the request pending for its owning Director). Scope: single-user accident guard, not anti-forgery.
Env seams (tests): MODEL_CHOICES_YAML, MODEL_CHOICES_SESSIONS, MODEL_CHOICES_AGENTS_DIRS (os.pathsep list),
MODEL_CHOICES_SETTINGS, MODEL_CHOICES_STATE_DIR, MODEL_CHOICES_DOC_FILE (markdown) + MODEL_CHOICES_DOC_REVISION, MODEL_CHOICES_NOW.
"""
import datetime as dt
import glob
import json
import os
import re
import subprocess
import sys

HOME = os.path.expanduser("~")
WDB = os.path.join(HOME, ".wos-runtime")
# Roles that run outside Pi subagents, so no agents/<role>.md profile exists (like om-*). front-door = the owner Bot,
# the Slack front agent on Pi Durable (request 2026-10-03).
NON_PROFILE_ROLES = frozenset({"front-door"})
YAML_PATH = os.environ.get("MODEL_CHOICES_YAML") or os.path.join(WDB, "fleet", "model_choices.yaml")
SESSIONS = os.environ.get("MODEL_CHOICES_SESSIONS") or os.path.join(HOME, ".pi", "agent", "sessions")
STATE_DIR = os.environ.get("MODEL_CHOICES_STATE_DIR") or os.path.join(WDB, "fleet", "state")
SETTINGS = os.environ.get("MODEL_CHOICES_SETTINGS") or os.path.join(HOME, ".pi", "agent", "settings.json")
PKG_AGENTS = os.path.join(HOME, "wisdom-os", "Obsidian Vault", "Context", "99_Reference",
                          "pi-interactive-subagents", "agents")
AGENT_DIRS = (os.environ.get("MODEL_CHOICES_AGENTS_DIRS") or os.pathsep.join([
    os.path.join(HOME, "wisdom-os", ".pi", "agents"),   # cwd-local (WOS root) — wins when present
    os.path.join(HOME, ".pi", "agent", "agents"),                          # user config dir
    PKG_AGENTS,                                                            # bundled
])).split(os.pathsep)
MEMBERS_OM = {"om-observer": "observer", "om-consolidator": "consolidator"}
LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")
LEVEL_SUFFIX = re.compile(r":(%s)$" % "|".join(LEVELS))
# A provider usage-policy / content refusal. Availability words are deliberately NOT here.
POLICY = re.compile(r"usage polic|content polic|acceptable use polic|violative|refusals-and-fallback|"
                    r"blocked under .{0,40}polic", re.I)
SEP = "Model Choices (GDoc DOC_ID)"


class TableError(Exception):
    pass


def now_utc():
    t = os.environ.get("MODEL_CHOICES_NOW")
    return dt.datetime.fromtimestamp(float(t), dt.timezone.utc) if t else dt.datetime.now(dt.timezone.utc)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


# ── table ──────────────────────────────────────────────────────────────────────────────────────────────
def load_table(path=None):
    import yaml  # PyYAML (system python3)
    path = path or YAML_PATH
    try:
        with open(path, encoding="utf-8") as fh:
            t = yaml.safe_load(fh)
    except FileNotFoundError:
        raise TableError("table %s is missing" % path)
    except Exception as e:
        raise TableError("table %s is unreadable (%s)" % (path, type(e).__name__))
    if not isinstance(t, dict) or t.get("schema") != "wos.model_choices/v1" or not isinstance(t.get("roles"), dict):
        raise TableError("table %s has no wos.model_choices/v1 roles map" % path)
    conds = t.get("fallback_conditions") or {}
    for role, r in t["roles"].items():
        if not isinstance(r, dict) or not isinstance(r.get("model"), str) or r.get("thinking") not in LEVELS:
            raise TableError("role %r needs model + thinking" % role)
        fbs = r.get("allowed_fallbacks")
        if not isinstance(fbs, list):
            raise TableError("role %r: allowed_fallbacks must be a list (empty = none)" % role)
        for fb in fbs:
            if not isinstance(fb, dict) or not isinstance(fb.get("model"), str) or fb.get("when") not in conds:
                raise TableError("role %r: every fallback needs model + a `when` from fallback_conditions" % role)
    t.setdefault("host_aliases", {})
    return t


def canon(model, table):
    """'openai/gpt-5.6-sol-1m:high' → ('openai/gpt-5.6-sol[1m]', 'high'); aliases are identity-preserving renames."""
    m = (model or "").strip()
    level = None
    mm = LEVEL_SUFFIX.search(m)
    if mm:
        level, m = mm.group(1), m[: mm.start()]
    m = (table.get("host_aliases") or {}).get(m, m)
    return m, level


def governed_role(roles, table):
    for r in roles:
        if r and r in table["roles"]:
            return r
    return None


# ── evidence: a prior child of the same request ended on a provider policy refusal ─────────────────────
def _load_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _loadout_roles(session_file):
    lo = _load_json(session_file + ".loadout.json") if session_file else None
    if not isinstance(lo, dict):
        return set(), None
    return {x for x in (lo.get("agent"), lo.get("routeRole")) if x}, lo.get("model")


def _model_matches(event_model, default_canon):
    if not event_model:
        return False
    em = str(event_model)
    return em == default_canon or em == default_canon.split("/", 1)[-1]


def transcript_refusal(session_file, default_canon):
    """The LAST assistant message of the transcript is a provider policy refusal on the default model."""
    last = None
    try:
        with open(session_file, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if '"assistant"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                m = d.get("message") if isinstance(d, dict) else None
                if isinstance(m, dict) and m.get("role") == "assistant":
                    last = m
    except OSError:
        return None
    if not last or last.get("stopReason") not in ("error", "refusal"):
        return None
    text = str(last.get("errorMessage") or "")
    full = "%s/%s" % (last.get("provider"), last.get("model"))
    if not (last.get("stopReason") == "refusal" or POLICY.search(text)):
        return None
    if not (_model_matches(full, default_canon) or _model_matches(last.get("model"), default_canon)):
        return None
    return {"source": "transcript", "file": session_file, "model": full, "stopReason": last.get("stopReason"),
            "text": text[:200]}


def record_refusal(rec, default_canon):
    for e in rec.get("providerEventLog") or []:
        if not isinstance(e, dict) or e.get("kind") != "failed":
            continue
        text = str(e.get("errorText") or "")
        if (e.get("rawStopReason") == "refusal" or POLICY.search(text)) and _model_matches(e.get("model"), default_canon):
            return {"source": "dispatch-record.providerEventLog", "sequence": e.get("sequence"),
                    "model": e.get("model"), "rawStopReason": e.get("rawStopReason"), "text": text[:200]}
    return None


def _ts(s):
    try:
        return dt.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=dt.timezone.utc)
    except Exception:
        return None


def iter_dispatch_records(root=None):
    for p in glob.glob(os.path.join(root or SESSIONS, "*", "artifacts", "*", "dispatch", "*.json")):
        yield p


def find_policy_refusal(role, default_canon, request_id, session_files=(), before=None, exclude=()):
    """Evidence or None. Searches (a) the explicitly named prior sessions (a resume's stored transcript) and (b) every
    dispatch record carrying the same request_id, claimed before `before`. Role is proven by the child's loadout."""
    searched = 0
    excl = {os.path.abspath(x) for x in exclude if x}
    for sf in session_files or ():
        if not sf or os.path.abspath(sf) in excl:
            continue
        searched += 1
        roles, _ = _loadout_roles(sf)
        if role not in roles:
            continue
        ev = transcript_refusal(sf, default_canon)
        if ev:
            return ev, searched
    if not request_id:
        return None, searched
    needle = '"%s"' % request_id
    for p in iter_dispatch_records():
        try:
            with open(p, encoding="utf-8") as fh:
                txt = fh.read()
        except OSError:
            continue
        if needle not in txt:
            continue
        try:
            rec = json.loads(txt)
        except ValueError:
            continue
        if ((rec.get("requestEnvelope") or {}).get("request_id")) != request_id:
            continue
        child = rec.get("childSessionFile")
        if child and os.path.abspath(child) in excl:
            continue
        claimed = _ts(rec.get("claimedAt") or "")
        if before is not None and (claimed is None or claimed >= before):
            continue
        searched += 1
        roles, _ = _loadout_roles(child)
        if role not in roles:
            continue
        if not _model_matches(rec.get("model"), default_canon):
            continue
        ev = record_refusal(rec, default_canon) or (transcript_refusal(child, default_canon) if child else None)
        if ev:
            ev.update({"dispatch_record": p, "name": rec.get("name"), "request_id": request_id})
            return ev, searched
    return None, searched


# ── admit ──────────────────────────────────────────────────────────────────────────────────────────────
def admit(req, table=None, before=None):
    roles = [req.get("role")] + list(req.get("roles") or [])
    model = req.get("model")
    source = req.get("source") or "override"
    if table is None:
        try:
            table = load_table()
        except TableError as e:
            # Fail closed for anything a caller or a harness chose; a profile pin stands (the daily check flags it).
            if source == "profile":
                return {"verdict": "admit", "kind": "table-unreadable-profile", "reason": str(e)}
            return {"verdict": "refuse", "kind": "table-unreadable",
                    "reason": "%s; a non-profile model cannot be checked against %s, so it is refused. "
                              "Dispatch without `model:` (the profile pin is used)." % (e, SEP)}
    role = governed_role(roles, table)
    if not role:
        return {"verdict": "ungoverned", "kind": "role-not-in-table", "role": next((r for r in roles if r), None),
                "reason": "role not in %s" % SEP}
    r = table["roles"][role]
    default, _ = canon(r["model"], table)
    want, level = canon(model, table)
    out = {"role": role, "default": default, "thinking": r["thinking"], "requested": model}
    if not want:
        return dict(out, verdict="refuse", kind="no-model", reason="no model resolved for role %s" % role)
    if level and level != r["thinking"]:
        return dict(out, verdict="refuse", kind="off-table-thinking",
                    reason="thinking `%s` for role %s is not in %s (the role runs %s at `%s`). Refused back to the "
                           "dispatcher: drop the `:%s` suffix / `model:` override and use the role default."
                           % (level, role, SEP, default, r["thinking"], level))
    if want == default:
        return dict(out, verdict="admit", kind="default", reason="role default")
    for fb in r["allowed_fallbacks"]:
        fbm, _ = canon(fb["model"], table)
        if fbm != want:
            continue
        if fb["when"] == "provider_policy_refusal":
            ev, n = find_policy_refusal(role, default, req.get("request_id"), req.get("session_files") or (),
                                        before=before or now_utc(), exclude=req.get("exclude_sessions") or ())
            if ev:
                return dict(out, verdict="admit", kind="fallback", when=fb["when"], evidence=ev,
                            reason="conditional fallback %s admitted: the prior %s child of request %s ended on a "
                                   "provider policy refusal of %s (%s)" % (want, role, req.get("request_id"), default,
                                                                           ev.get("source")))
            return dict(out, verdict="refuse", kind="fallback-without-evidence", when=fb["when"], searched=n,
                        reason="%s is allowed for role %s ONLY after a provider usage-policy refusal of %s on the same "
                               "request (%s). No such evidence for request %s (%d prior record(s) searched). Refused "
                               "back to the dispatcher: use the role default %s. If %s is unavailable (503/429), "
                               "wait and retry the same model; availability is not a fallback condition."
                               % (want, role, default, SEP, req.get("request_id") or "(none)", n, default, default))
    return dict(out, verdict="refuse", kind="off-table",
                reason="model %s is not in %s for role %s (default %s at `%s`; allowed fallbacks: %s). Refused back "
                       "to the dispatcher: drop the `model:` override and use the role default. If %s is "
                       "unavailable, retry the same model later or leave the request pending for its owning "
                       "Director; no other model is tried."
                       % (want, SEP, role, default, r["thinking"],
                          ", ".join("%s when %s" % (f["model"], f["when"]) for f in r["allowed_fallbacks"]) or "none",
                          default))


# ── check (sync) ───────────────────────────────────────────────────────────────────────────────────────
def fetch_doc(doc_id):
    f = os.environ.get("MODEL_CHOICES_DOC_FILE")
    if f:
        return open(f, encoding="utf-8").read(), os.environ.get("MODEL_CHOICES_DOC_REVISION")
    md = subprocess.run(["internal-cli", "google.docs", "get", "--id", doc_id, "--output=markdown", "--images=strip"],
                        capture_output=True, text=True, timeout=120)
    if md.returncode != 0 or "|" not in md.stdout:
        raise RuntimeError("doc fetch failed rc=%s %s" % (md.returncode, (md.stderr or "")[:160]))
    rev = None
    rj = subprocess.run(["internal-cli", "google.docs", "get", "--id", doc_id, "--output=raw-json"],
                        capture_output=True, text=True, timeout=120)
    if rj.returncode == 0:
        try:
            rev = json.loads(rj.stdout).get("revisionId")
        except ValueError:
            rev = None
    return md.stdout, rev


def parse_doc_table(md, table):
    labels = table.get("doc_row_labels") or {}
    rows = {}
    for line in md.splitlines():
        if not line.strip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 3:
            continue
        label = cells[0].replace("\\", "")
        if label in labels:
            rows[labels[label]] = {"model": cells[1].replace("\\", ""), "thinking": cells[2].strip().lower()}
    for k, v in list(rows.items()):           # "= consolidator"
        m = re.match(r"^=\s*(\S+)$", v["model"])
        if m:
            ref = "om-" + m.group(1) if ("om-" + m.group(1)) in rows else m.group(1)
            if ref in rows:
                rows[k] = dict(v, model=rows[ref]["model"])
    return rows


def read_frontmatter(path):
    try:
        txt = open(path, encoding="utf-8").read()
    except OSError:
        return None
    m = re.match(r"^---\n(.*?)\n---", txt, re.S)
    if not m:
        return {}
    out = {}
    for ln in m.group(1).splitlines():
        if ":" in ln and not ln.startswith(" "):
            k, v = ln.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def check(offline=False):
    rep = {"at": iso(now_utc()), "drift": [], "notes": [], "status": "in-sync"}
    try:
        table = load_table()
    except TableError as e:
        rep.update(status="cannot-measure", error=str(e))
        return rep
    src = table.get("source") or {}
    # 1. live doc
    if offline:
        rep["notes"].append("doc not fetched (--offline)")
    else:
        try:
            md, rev = fetch_doc(src.get("doc_id"))
            rows = parse_doc_table(md, table)
            rep["doc_revision"] = rev
            if rev and rev != src.get("revision_id"):
                rep["notes"].append("doc revision changed since the mirror (%s… → %s…)"
                                    % (str(src.get("revision_id"))[:12], rev[:12]))
            for role, r in table["roles"].items():
                d = rows.get(role)
                if not d:
                    rep["drift"].append({"kind": "doc-row-missing", "role": role})
                    continue
                if canon(d["model"], table)[0] != canon(r["model"], table)[0] or d["thinking"] != r["thinking"]:
                    rep["drift"].append({"kind": "yaml-vs-doc", "role": role, "doc": d,
                                         "yaml": {"model": r["model"], "thinking": r["thinking"]}})
            for role in rows:
                if role not in table["roles"]:
                    rep["drift"].append({"kind": "doc-row-not-in-yaml", "role": role, "doc": rows[role]})
        except Exception as e:
            rep["status"] = "cannot-measure"
            rep["error"] = "live doc: %s" % e
    # 2. agent profiles (the defaults `subagents_list` shows): first existing file per role wins, like the loader
    for role, r in table["roles"].items():
        if role.startswith("om-") or role in NON_PROFILE_ROLES:
            continue
        hits = [os.path.join(d, role + ".md") for d in AGENT_DIRS if os.path.isfile(os.path.join(d, role + ".md"))]
        if not hits:
            rep["drift"].append({"kind": "profile-missing", "role": role})
            continue
        fm = read_frontmatter(hits[0]) or {}
        pm, plevel = canon(fm.get("model", ""), table)
        if pm != canon(r["model"], table)[0] or (fm.get("thinking") or plevel) != r["thinking"]:
            rep["drift"].append({"kind": "profile-vs-yaml", "role": role, "file": hits[0],
                                 "profile": {"model": fm.get("model"), "thinking": fm.get("thinking")},
                                 "yaml": {"model": r["model"], "thinking": r["thinking"]}})
    # 3. OM settings (observer / consolidator / any automatic fallback)
    s = _load_json(SETTINGS)
    om = ((s or {}).get("observational-memory") or {}).get("models") if isinstance(s, dict) else None
    if not isinstance(om, dict):
        rep["notes"].append("no observational-memory.models in %s" % SETTINGS)
    else:
        for role, key in MEMBERS_OM.items():
            v = om.get(key)
            r = table["roles"].get(role)
            if not r:
                continue
            got = ("%s/%s" % (v.get("provider"), v.get("id"))) if isinstance(v, dict) else None
            if not got or canon(got, table)[0] != canon(r["model"], table)[0] or v.get("thinking") != r["thinking"]:
                rep["drift"].append({"kind": "om-settings-vs-yaml", "role": role, "settings": v,
                                     "yaml": {"model": r["model"], "thinking": r["thinking"]}})
        for key, v in om.items():
            if key in MEMBERS_OM.values():
                continue
            got = ("%s/%s" % (v.get("provider"), v.get("id"))) if isinstance(v, dict) else str(v)
            rep["drift"].append({"kind": "om-automatic-fallback", "key": key, "model": got,
                                 "why": "an automatic OM model substitution outside the table (availability is not a "
                                        "fallback condition)"})
    # 4. staged-off harness demotion switch
    flag = os.path.join(WDB, "fleet", "state", "recurring_watch", "pin_demotion.on")
    if os.path.exists(flag):
        rep["notes"].append("pin_demotion.on present: mid-run pin demotion is ON; the dispatch guard refuses any "
                            "off-table demotion target and keeps the pin")
    if rep["drift"] and rep["status"] != "cannot-measure":
        rep["status"] = "drift"
    return rep


# ── replay ─────────────────────────────────────────────────────────────────────────────────────────────
def replay(days=7):
    table = load_table()
    end = now_utc()
    start = end - dt.timedelta(days=days)
    rows = []
    for p in iter_dispatch_records():
        rec = _load_json(p)
        if not isinstance(rec, dict):
            continue
        claimed = _ts(rec.get("claimedAt") or "")
        if not claimed or claimed < start or claimed > end:
            continue
        child = rec.get("childSessionFile")
        roles, lo_model = _loadout_roles(child)
        lo = _load_json(child + ".loadout.json") if child else None
        agent = (lo or {}).get("agent")
        route = (lo or {}).get("routeRole")
        model = rec.get("model") or lo_model
        req = {"role": agent, "roles": [route], "model": model, "source": "override",
               "request_id": (rec.get("requestEnvelope") or {}).get("request_id"),
               "session_files": [], "exclude_sessions": [child]}
        if rec.get("kind") == "resume" and isinstance(rec.get("forkedFrom"), str):
            req["session_files"] = [rec["forkedFrom"]]
        v = admit(req, table=table, before=claimed)
        thinking = (lo or {}).get("thinking")
        role = v.get("role")
        off_thinking = bool(role and thinking and thinking != table["roles"][role]["thinking"])
        rows.append({"name": rec.get("name"), "claimedAt": rec.get("claimedAt"), "kind": rec.get("kind"),
                     "agent": agent, "model": model, "thinking": thinking, "verdict": v["verdict"],
                     "vkind": v.get("kind"), "off_table_thinking": off_thinking,
                     "request_id": req["request_id"], "record": p})
    summ = {"window": [iso(start), iso(end)], "records": len(rows)}
    for k in ("admit", "refuse", "ungoverned"):
        summ[k] = sum(1 for r in rows if r["verdict"] == k)
    summ["admit_fallback"] = sum(1 for r in rows if r["vkind"] == "fallback")
    summ["no_loadout"] = sum(1 for r in rows if not r["agent"])
    summ["off_table_thinking"] = sum(1 for r in rows if r["off_table_thinking"])
    by = {}
    for r in rows:
        if r["verdict"] == "refuse":
            key = "%s→%s" % (r["agent"], r["model"])
            by[key] = by.get(key, 0) + 1
    summ["refused_by_role_model"] = dict(sorted(by.items(), key=lambda kv: -kv[1]))
    return summ, rows


def main(argv):
    if not argv:
        print(__doc__); return 2
    verb, rest = argv[0], argv[1:]
    if verb == "admit":
        try:
            req = json.loads(sys.stdin.read() or "{}")
            assert isinstance(req, dict)
        except Exception:
            print(json.dumps({"verdict": "refuse", "kind": "bad-input", "reason": "admit input is not a JSON object"}))
            return 2
        print(json.dumps(admit(req), ensure_ascii=False))
        return 0
    if verb == "check":
        rep = check(offline="--offline" in rest)
        if "--write-state" in rest:
            os.makedirs(STATE_DIR, exist_ok=True)
            tmp = os.path.join(STATE_DIR, ".model_choices_check.json.%d" % os.getpid())
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(rep, fh, ensure_ascii=False, indent=1)
            os.replace(tmp, os.path.join(STATE_DIR, "model_choices_check.json"))
        if "--json" in rest:
            print(json.dumps(rep, ensure_ascii=False, indent=1))
        else:
            print("model_choices check: %s (%d drift, %d note)" % (rep["status"], len(rep["drift"]), len(rep["notes"])))
            for d in rep["drift"]:
                print("  DRIFT", json.dumps(d, ensure_ascii=False))
            for n in rep["notes"]:
                print("  note ", n)
            if rep.get("error"):
                print("  ERROR", rep["error"])
        return {"in-sync": 0, "drift": 1}.get(rep["status"], 3)
    if verb == "replay":
        days = 7
        if "--days" in rest:
            days = float(rest[rest.index("--days") + 1])
        summ, rows = replay(days)
        if "--json" in rest:
            print(json.dumps({"summary": summ, "rows": rows}, ensure_ascii=False, indent=1))
        else:
            print(json.dumps(summ, ensure_ascii=False, indent=1))
            for r in rows:
                if r["verdict"] == "refuse":
                    print("  REFUSE %s %s %-28s %-10s %s %s" % (r["claimedAt"], r["kind"], r["name"], r["agent"],
                                                                r["model"], r["vkind"]))
        return 0
    print(__doc__); return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
