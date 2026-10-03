# herdr_shell_env.sh — make a HAND-STARTED agent in a herdr pane visible in the sidebar.
# Inert everywhere except inside a herdr pane.
#
# INSTALL (the one line that must exist in ~/.bashrc — an untracked dotfile, which is why the
# substance lives here and only the pointer lives there):
#
#   [ -r "$HOME/.wos-runtime/fleet/herdr_shell_env.sh" ] && . "$HOME/.wos-runtime/fleet/herdr_shell_env.sh"
#
# Asserted by tests/fleet/test_addressability.py::test_the_dotfile_pointers_are_installed —
# without that check, a dotfile reset would disable this silently and the only symptom would
# be the owner quietly disappearing from his own sidebar again.
#
# 🔴 WHY THIS EXISTS. herdr decides which panes hold agents by matching argv[0]/comm of the
# pane's FOREGROUND process against a hard-coded list of agent binaries (claude, codex, pi,
# gemini, ...). `happy` is not on that list and happy_cli pins `process.title = "happy"`, so
# a hand-typed `happy` is not merely misclassified — it is never admitted, and NO DETECTION
# RULE EVER RUNS ON IT. `herdr agent explain <pane>` answers `agent_not_found`.
#
# Every fleet peer already escapes this: `spawn.py` exports NODE_OPTIONS with
# `herdr_title_shim.cjs` at creation time when the backend is herdr. the owner's own console is the
# one agent nobody spawns, so it was the one agent he could not see — which is exactly the
# question he asked on 2026-08-17: "can you see yourself on herdr? why i cannot see it?"
#
# The controlled proof, same pane, same herdr, one morning apart:
#   `happy` -> fg name "happy", in_agents = False, no rule ever evaluated
#   `pi`    -> fg name "pi"   , in_agents = True , agent_status = working
# argv[0] is the whole gate. Not the manifest `aliases` (which do list "happy"), not the pane
# label (tested: labelling the pane changed nothing), not the title shim's own OSC writes.
#
# WHY A FUNCTION AND NOT A BARE `export`. NODE_OPTIONS is inherited by every node process
# started from the shell. Wrapping the launcher scopes it to happy and its children — which
# is the same exposure the fleet already runs with, and nothing more. The shim additionally
# self-guards on HERDR_ENV + HERDR_PANE_ID + a happy/happier argv match, so it is a no-op for
# claude, MCP servers and tooling that inherit the variable anyway.
#
# WHY WOS_LAUNCHER IS DECLARED HERE TOO. Renaming the process makes argv stop being evidence
# of what launched the session, and `fleet_probe.classify()` falls back to argv when nothing
# is declared — it would report the owner's console as launcher `claude` and any restart command
# rebuilt from that would silently lose happy, mobile and resume-by-UUID. A declared fact
# cannot be invalidated by a cosmetic rename; see `spawn.launcher_kind()`.
# `happier` also declares `happy`: the launcher vocabulary is {happy, claude, codex}
# (`kg/pwos_kernel.VALID_SURFACE`) and "happier" is not a member of it.
#
# 🔴 WOS_DIRECTOR IS DELIBERATELY NOT SET. That is the flag that says "this is a fleet peer",
# and the owner's console is not one. `herdr_detection_control.declares_a_director()` reads it to
# tell his console apart from a peer the fleet has lost track of, and `transport._index()`
# refuses to resolve the label herdr auto-assigns it, so the fleet cannot steer him. Visible
# in the sidebar, unaddressable by the machine — those are two different properties and this
# file only grants the first.
#
# KILL SWITCH: delete the `source` line from ~/.bashrc, or `unset -f happy happier`.
# Verify with:  herdr agent explain "$HERDR_PANE_ID"

_wos_herdr_launch() {
    local bin="$1"; shift
    local shim="$HOME/.wos-runtime/fleet/herdr_title_shim.cjs"
    # A missing shim must not take the launcher down with it: `node --require <missing>` is a
    # hard startup failure, and this wraps the binary the owner's phone talks to.
    if [ "${HERDR_ENV:-}" = "1" ] && [ -n "${HERDR_PANE_ID:-}" ] && [ -r "$shim" ]; then
        # Idempotent: a peer already has this exported by spawn.py, and appending a second
        # `--require` of the same path every time a nested launcher runs makes NODE_OPTIONS
        # grow without bound. Node would dedupe the load; the variable would not.
        local opts="${NODE_OPTIONS:-}"
        case " $opts " in
            *" --require $shim "*) ;;
            *) opts="--require $shim${opts:+ $opts}" ;;
        esac
        NODE_OPTIONS="$opts" WOS_LAUNCHER="${WOS_LAUNCHER:-happy}" command "$bin" "$@"
    else
        command "$bin" "$@"
    fi
}

happy()   { _wos_herdr_launch happy   "$@"; }
happier() { _wos_herdr_launch happier "$@"; }
