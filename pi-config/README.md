# pi-config — a sanitized, installable WOS-style Pi harness

This directory is a **generated, sanitized export** of a working, heavily customized Pi harness: the
Pi settings, guard and statusline extensions, subagent role profiles, the `AGENTS.md` operating
contract (as a template), the model-choice table, the MCP gate allowlist, and the fleet scripts a
Director uses (`wos_send`, the Director registry, the Herdr launch helpers).

It contains **no private data**. A deterministic exporter rewrites the live files, and a gate refuses the
whole export if a single hit remains. The gate checks people names, unixname, home paths, hosts, ids,
tokens and project names. Soul, Cases, people files, the personal database, sessions and memory content
are never read. See `EXCLUDED.md` for what stays private and why. `MANIFEST.json` lists every file with its sha256.

Do not edit files here by hand. The next weekly export overwrites them.

## Install on a new box

Prerequisites: Pi (`pi --version`), Node ≥ 20, Python ≥ 3.9, and optionally Herdr (fleet panes) and tmux.

1. **Get the subagents package** (needed for the `subagent` tool and the role profiles):
   `git clone https://github.com/amosblomqvist/pi-interactive-subagents ~/src/pi-interactive-subagents`
   and, optionally, an observational-memory Pi package.
2. **Choose a Wisdom OS root**: the folder that holds your vault, `AGENTS.md` and `.claude/skills`.
   `mkdir -p ~/wisdom-os/.claude/skills`
3. **Fill the placeholders** in your environment (table below). Only the first three are required.
4. **Plan**, read it, then **apply**:

   ```bash
   cd Wisdom-OS-Core/pi-config
   export WISDOM_OS_ROOT=~/wisdom-os DEFAULT_PROVIDER=anthropic DEFAULT_MODEL=<model-id>
   export PI_SUBAGENTS_PKG=~/src/pi-interactive-subagents
   python3 install.py              # plan: lists every target; writes nothing
   python3 install.py --apply      # refuses if a target exists; add --backup to move existing files aside
   ```

5. **Authenticate your provider** the normal Pi way (`/login` or the provider's API-key variable). No
   credentials ship here.
6. **Smoke test**: `pi --help`, then `pi -p 'say ok'`. Extensions whose private runtime helpers are absent
   fail open; a load error names the file.
7. **Make it yours**. Fill every `<<FILL: …>>` block in `$WISDOM_OS_ROOT/AGENTS.md`, which is the contract every
   session reads. `examples/AGENTS.owner-example.md` is the original owner's filled-in version, for reference. Then
   edit `~/.wos-runtime/director/directors.yaml` (your Directors), `~/.wos-runtime/fleet/model_choices.yaml`
   (models per role), and `~/.wos-runtime/harness/mcp_allowlist.yaml` (read-only MCP tools you admit).

Undo: with `--backup`, the previous files sit under `~/.pi/agent/backup-<utc>/` at their absolute paths.
Move them back. Without it, nothing was overwritten. Delete the new files to undo.

## Placeholders

| Variable | Required | Fills |
|---|---|---|
| `WISDOM_OS_ROOT` | yes | skills path, Director `cwd`, `AGENTS.md` location |
| `DEFAULT_PROVIDER`, `DEFAULT_MODEL` | yes | `settings.json` default + enabled model |
| `AGENT_MODEL` | no (default `provider/model` above) | `model:` of every role profile in `agents/` |
| `PI_SUBAGENTS_PKG` | no, but the `subagent` tool needs it | `settings.json` packages |
| `PI_OM_PKG` + `OM_OBSERVER_PROVIDER/MODEL` + `OM_CONSOLIDATOR_PROVIDER/MODEL` | no (all or none) | observational-memory block |
| `MCP_SERVER_NAME`, `MCP_SERVER_COMMAND` | no (else `mcp.json` has no servers) | `mcp.json` |
| `PI_CODING_AGENT_DIR` | no (default `~/.pi/agent`) | where Pi config is written |
| `WOS_RUNTIME` | no (default `~/.wos-runtime`) | fleet scripts, registry, allowlist |

## Layout

| Path | Installs to | What |
|---|---|---|
| `settings.template.json`, `models.json`, `mcp.template.json`, `APPEND_SYSTEM.md` | `~/.pi/agent/` | Pi config |
| `extensions/*.ts` | `~/.pi/agent/extensions/` | guards (destructive, Soul, empty-reply, MCP gate, protected writes), statusline, return/lease/stall plumbing |
| `agents/*.md` | `~/.pi/agent/agents/` | subagent role profiles (scout, researcher, analyst, implementer, verifier, worker, wos-director) |
| `templates/AGENTS.md.template` | `$WISDOM_OS_ROOT/AGENTS.md` | neutral operating contract with `<<FILL>>` placeholders |
| `examples/AGENTS.owner-example.md` | — (read only) | the owner's filled-in contract as a worked example |
| `templates/{directors,model_choices,mcp_allowlist}.yaml` | `~/.wos-runtime/…` | registry, model table, MCP allowlist |
| `runtime/` | `~/.wos-runtime/` | `wos_send`, model-choice checker, statusline sources, Herdr shell env / guard / tmux conf |
| `bin/wos-fleet-restart` | `~/bin/` | one-command Director restart wrapper |

The fleet scripts are reference implementations. Some call helpers from the private runtime that are
not exported, such as spawn, liveness and cron installers. Port those on demand.
