#!/usr/bin/env bash
# WOS chokepoint guard for the `herdr` CLI.
#
# 🔴 Incident 2026-09-02: a test harness's cleanup ran `herdr server stop` against
# whatever `HERDR_SOCKET_PATH` held. It held the LIVE socket. the owner's Herdr server
# stopped; the server restarted with all panes and durable labels intact, but four
# subagents' child processes were destroyed and their work was lost.
#
# 🔴 Incident 2026-09-03: an old, still-loaded Pi parent launched a worker after
# the binding repair had been installed. Its cached extension submitted
# `bash .../subagent-scripts/<worker>.sh`; Herdr classified the pane as a shell, so
# the live Pi worker had neither `agent` nor `agent_session`. Source/package tests
# were green, but the unreloaded parent bypassed them from memory.
#
# The package-internal fixes protect a loaded current package. THIS is the process-
# independent chokepoint: every old and new caller reaches Herdr through the `herdr`
# name on PATH. Refusing the shell-script worker shape here prevents a stale parent
# from recreating an unrestorable worker before that parent reloads.
#
# Rules:
#   1. Refuse a server-stopping command aimed at the LIVE API socket.
#   2. Refuse `pane run` commands that execute a generated `/subagent-scripts/`
#      launcher. A Pi child must be submitted directly so Herdr can bind it.
#   3. Pass every other command through unchanged, preserving argv/stdin/stdout/
#      stderr/exit code.
#
# Escape hatches, deliberate and loud:
#   WOS_HERDR_ALLOW_SERVER_STOP=1       allow this one destructive server call
#   WOS_HERDR_ALLOW_UNBOUND_SUBAGENT=1  allow one legacy shell-shaped worker call
#   WOS_HERDR_GUARD=0                   kill switch: disable the guard entirely
#
# Installed copies:
#   ~/.local/libexec/wos-herdr-guard.sh
#   ~/.local/bin/herdr
# Durable source:
#   ~/.wos-runtime/fleet/wos-herdr-guard.sh
# Revert snapshot:
#   ~/.wos-runtime/staging/example-project/pi-native-subagents-20260903/pre-r2-guard/revert.sh
set -uo pipefail

REAL_BIN="${WOS_HERDR_REAL_BIN:-$HOME/.local/libexec/herdr-real}"
LIVE_SOCKET="${WOS_HERDR_LIVE_SOCKET:-$HOME/.config/herdr/herdr.sock}"

if [ ! -x "$REAL_BIN" ]; then
  printf 'wos-herdr-guard: real herdr binary missing or not executable: %s\n' "$REAL_BIN" >&2
  exit 127
fi

# Kill switch first, so a broken guard can never wedge the fleet.
if [ "${WOS_HERDR_GUARD:-1}" = "0" ]; then
  exec "$REAL_BIN" "$@"
fi

# A stale parent can hold pre-fix TypeScript in memory for days after the package
# changes on disk. All affected builds create the pane, label it `wos-sub/...`,
# write the command under `/subagent-scripts/`, then submit only `bash <script>`.
# Herdr scans submitted command text, sees a shell, and never creates an
# `agent_session`. Refuse that shape before the real CLI receives any bytes.
# 🔴 Incident request 2026-09-19: this test used to read a
#    single positional, `submitted_command="$4"`. But `herdr pane run` is
#    `run <PANE_ID> <COMMAND>...`, so a caller that passes the command as separate argv
#    words puts `bash` in $4 and the script path in $5 -- and the guard waved it through.
#    Measured 2026-09-19T19:38Z:
#        herdr pane run P "bash …/subagent-scripts/x.sh"   -> exit 3  (refused)
#        herdr pane run P bash  …/subagent-scripts/x.sh    -> exit 0  (PASSED THROUGH)
#    The resume path emits exactly the second shape, which is why a resumed worker came
#    up with no `agent_session`, and why one unbound pane closed global fleet admission
#    for every other workstream. Scan EVERY argument, never one position.
if [ "${1:-}" = "pane" ] && [ "${2:-}" = "run" ] && [ "$#" -ge 4 ]; then
  submitted_command="$(printf '%s ' "${@:4}")"
  case "$submitted_command" in
    *'/subagent-scripts/'*)
      if [ "${WOS_HERDR_ALLOW_UNBOUND_SUBAGENT:-0}" = "1" ]; then
        printf 'wos-herdr-guard: ALLOWED legacy shell-shaped subagent launch by WOS_HERDR_ALLOW_UNBOUND_SUBAGENT=1\n' >&2
        exec "$REAL_BIN" "$@"
      fi
      cat >&2 <<'EOF'
wos-herdr-guard: REFUSED — stale parent attempted a shell-shaped Pi worker launch.

  command : herdr $*

A generated /subagent-scripts/ launcher hides `pi` behind bash. Herdr therefore
cannot bind the child to an agent_session, making the worker unrestorable and
closing global fleet admission. Reload or restart the spawning Pi parent so it
uses direct Pi submission, then retry.

One-call emergency override (unsafe; creates the incident class):
  WOS_HERDR_ALLOW_UNBOUND_SUBAGENT=1 herdr pane run ...

Kill switch for the whole guard: WOS_HERDR_GUARD=0
EOF
      exit 3
      ;;
  esac
fi

# Is this a server-stopping command? Only `herdr server stop [...]`. `herdr server
# reload-config`, `herdr status`, `herdr pane ...` and the rest are not destructive.
destructive=0
if [ "${1:-}" = "server" ] && [ "${2:-}" = "stop" ]; then
  destructive=1
fi

if [ "$destructive" = "0" ]; then
  exec "$REAL_BIN" "$@"
fi

# Which server would this actually hit? Unset means the default, which is live.
target="${HERDR_SOCKET_PATH:-$LIVE_SOCKET}"

resolve() {
  # Compare by resolved path so a symlink or `//` cannot smuggle the live socket past
  # a string compare. Fall back to the literal path when the socket does not exist.
  local p="$1"
  if [ -e "$p" ]; then
    readlink -f -- "$p" 2>/dev/null || printf '%s' "$p"
  else
    printf '%s' "$p"
  fi
}

target_resolved="$(resolve "$target")"
live_resolved="$(resolve "$LIVE_SOCKET")"

if [ "$target_resolved" != "$live_resolved" ]; then
  exec "$REAL_BIN" "$@"
fi

if [ "${WOS_HERDR_ALLOW_SERVER_STOP:-0}" = "1" ]; then
  printf 'wos-herdr-guard: ALLOWED explicit stop of the LIVE Herdr server (%s) by WOS_HERDR_ALLOW_SERVER_STOP=1\n' \
    "$live_resolved" >&2
  exec "$REAL_BIN" "$@"
fi

if [ -n "${HERDR_SOCKET_PATH:-}" ]; then
  origin="(from HERDR_SOCKET_PATH)"
else
  origin="(default; HERDR_SOCKET_PATH is unset)"
fi

cat >&2 <<EOF
wos-herdr-guard: REFUSED — this would stop the owner's LIVE Herdr server.

  command : herdr $*
  socket  : $target_resolved  $origin

Stopping the live server destroys every running agent's child process. Panes and
durable labels come back on restart; the work inside them does not. That is exactly
what happened on 2026-09-02, when four subagents' work was lost.

If you are a test harness: point HERDR_SOCKET_PATH at your own private socket and
prove it is private (own socket AND own state directory) before starting anything.

If you genuinely mean to stop the owner's server:
  WOS_HERDR_ALLOW_SERVER_STOP=1 herdr server stop

Kill switch for this guard: WOS_HERDR_GUARD=0
EOF
exit 3
