#!/usr/bin/env python3
"""install.py — install the sanitized WOS-style Pi harness config from Wisdom-OS-Core/pi-config onto a new box.

  python3 install.py                 plan only: print every target, its source and status; writes NOTHING
  python3 install.py --apply         write the plan (refuses if any target already exists)
  python3 install.py --apply --backup   move existing targets to <agent-dir>/backup-<utc>/ first (undo = move back)

Placeholders come from the environment (see README "Placeholders"). Required: WISDOM_OS_ROOT, DEFAULT_PROVIDER,
DEFAULT_MODEL. Optional: AGENT_MODEL (default DEFAULT_PROVIDER/DEFAULT_MODEL), PI_SUBAGENTS_PKG, PI_OM_PKG,
OM_OBSERVER_PROVIDER/OM_OBSERVER_MODEL, OM_CONSOLIDATOR_PROVIDER/OM_CONSOLIDATOR_MODEL, MCP_SERVER_NAME/
MCP_SERVER_COMMAND. Targets: $PI_CODING_AGENT_DIR (default ~/.pi/agent), $WOS_RUNTIME (default ~/.wos-runtime),
~/bin, and $WISDOM_OS_ROOT/AGENTS.md. After writing, every file is re-read and must contain no `__X__` placeholder.
"""
import json, os, re, shutil, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser("~")
AGENT = os.environ.get("PI_CODING_AGENT_DIR", os.path.join(HOME, ".pi", "agent"))
RUNTIME = os.environ.get("WOS_RUNTIME", os.path.join(HOME, ".wos-runtime"))
KNOWN = ("WISDOM_OS_ROOT", "DEFAULT_PROVIDER", "DEFAULT_MODEL", "AGENT_MODEL", "PI_SUBAGENTS_PKG", "PI_OM_PKG",
         "OM_OBSERVER_PROVIDER", "OM_OBSERVER_MODEL", "OM_CONSOLIDATOR_PROVIDER", "OM_CONSOLIDATOR_MODEL",
         "MCP_SERVER_NAME", "MCP_SERVER_COMMAND")
PH = re.compile(r"__(" + "|".join(KNOWN) + r")__")   # only these; code may legitimately contain other __X__


def env(k, default=None):
    v = os.environ.get(k, "").strip()
    return v or default


def values():
    v = {k: env(k) for k in ("WISDOM_OS_ROOT", "DEFAULT_PROVIDER", "DEFAULT_MODEL", "PI_SUBAGENTS_PKG", "PI_OM_PKG",
                             "OM_OBSERVER_PROVIDER", "OM_OBSERVER_MODEL", "OM_CONSOLIDATOR_PROVIDER",
                             "OM_CONSOLIDATOR_MODEL", "MCP_SERVER_NAME", "MCP_SERVER_COMMAND")}
    v["AGENT_MODEL"] = env("AGENT_MODEL", "%s/%s" % (v["DEFAULT_PROVIDER"], v["DEFAULT_MODEL"]))
    missing = [k for k in ("WISDOM_OS_ROOT", "DEFAULT_PROVIDER", "DEFAULT_MODEL") if not v[k]]
    return v, missing


def fill(text, v):
    return PH.sub(lambda m: v.get(m.group(1)) or m.group(0), text)


def settings(v):
    s = json.load(open(os.path.join(HERE, "settings.template.json")))
    s["packages"] = [p for p in ([v["PI_SUBAGENTS_PKG"]] + [v["PI_OM_PKG"]]) if p]
    om = s.get("observational-memory", {}).get("models", {})
    if not v["PI_OM_PKG"] or not all(v[k] for k in ("OM_OBSERVER_PROVIDER", "OM_OBSERVER_MODEL",
                                                    "OM_CONSOLIDATOR_PROVIDER", "OM_CONSOLIDATOR_MODEL")):
        s.pop("observational-memory", None)
    elif om:
        s["observational-memory"] = json.loads(fill(json.dumps(s["observational-memory"]), v))
    return fill(json.dumps(s, indent=2, ensure_ascii=False), v) + "\n"


def mcp(v):
    if not (v["MCP_SERVER_NAME"] and v["MCP_SERVER_COMMAND"]):
        return json.dumps({"mcpServers": {}}, indent=2) + "\n"
    return fill(open(os.path.join(HERE, "mcp.template.json")).read(), v)


def plan(v):
    P = []  # (target, content, mode)
    rd = lambda rel: open(os.path.join(HERE, rel), encoding="utf-8").read()
    P.append((os.path.join(AGENT, "settings.json"), settings(v), 0o600))
    P.append((os.path.join(AGENT, "mcp.json"), mcp(v), 0o644))
    for rel in ("models.json", "APPEND_SYSTEM.md"):
        P.append((os.path.join(AGENT, rel), fill(rd(rel), v), 0o644))
    for sub, dst in (("extensions", os.path.join(AGENT, "extensions")), ("agents", os.path.join(AGENT, "agents"))):
        for n in sorted(os.listdir(os.path.join(HERE, sub))):
            P.append((os.path.join(dst, n), fill(rd(os.path.join(sub, n)), v), 0o644))
    P.append((os.path.join(RUNTIME, "harness", "mcp_allowlist.yaml"), rd("templates/mcp_allowlist.yaml"), 0o644))
    P.append((os.path.join(RUNTIME, "fleet", "model_choices.yaml"), rd("templates/model_choices.yaml"), 0o644))
    P.append((os.path.join(RUNTIME, "director", "directors.yaml"), rd("templates/directors.yaml"), 0o644))
    for d, _, fs in sorted(os.walk(os.path.join(HERE, "runtime"))):
        for f in sorted(fs):
            rel = os.path.relpath(os.path.join(d, f), os.path.join(HERE, "runtime"))
            P.append((os.path.join(RUNTIME, rel), fill(rd(os.path.join("runtime", rel)), v),
                      0o755 if f.endswith((".py", ".sh")) or "." not in f else 0o644))
    for n in sorted(os.listdir(os.path.join(HERE, "bin"))):
        P.append((os.path.join(HOME, "bin", n), fill(rd(os.path.join("bin", n)), v), 0o755))
    if v["WISDOM_OS_ROOT"]:
        P.append((os.path.join(v["WISDOM_OS_ROOT"], "AGENTS.md"), fill(rd("templates/AGENTS.md.template"), v), 0o644))
    return P


def main(a):
    v, missing = values()
    if missing:
        print("install: missing required placeholder values: %s (set them in the environment)" % ", ".join(missing))
        return 2
    P = plan(v)
    left = sorted({m for _, c, _ in P for m in PH.findall(c)})
    exists = [t for t, _, _ in P if os.path.lexists(t)]
    for t, c, _ in P:
        print("%-7s %s" % ("EXISTS" if os.path.lexists(t) else "new", t))
    print("install: %d targets, %d exist; unfilled placeholders: %s" % (len(P), len(exists), left or "none"))
    if left:
        print("install: REFUSED — fill the placeholders above first"); return 2
    if "--apply" not in a:
        print("install: plan only — nothing written (re-run with --apply)"); return 0
    if exists and "--backup" not in a:
        print("install: REFUSED — %d targets exist; re-run with --backup to move them aside first" % len(exists)); return 3
    if exists:
        bk = os.path.join(AGENT, "backup-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
        for t in exists:
            dst = os.path.join(bk, os.path.relpath(t, "/"))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(t, dst)
        print("install: moved %d existing targets to %s" % (len(exists), bk))
    for t, c, mode in P:
        os.makedirs(os.path.dirname(t), exist_ok=True)
        tmp = t + ".install-tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(c)
        os.chmod(tmp, mode)
        os.replace(tmp, t)
        if open(t, encoding="utf-8").read() != c or PH.search(c):
            print("install: FAIL read-back %s" % t); return 4
    print("install: wrote %d files; read-back ok. Next: `pi --help`, then `pi -p 'say ok'`." % len(P))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
