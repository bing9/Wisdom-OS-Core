// wos-exit-recorder — one row per Pi process death, so the next "why did the Director die?" has evidence.
// request 2026-09-28 r4 (P1 2026-09-28: DIR-wos died ~19:36:04Z, 11 s after a self-reload; no
// crash log, no OOM, scrollback overwritten -> UNRESOLVED).
//
// Appends ONE JSON line to ~/.wos-runtime/fleet/state/pi_exits.jsonl on: process 'exit' (code), 'beforeExit',
// SIGTERM / SIGHUP / SIGINT (signal), uncaught exceptions and unhandled rejections (message + first 20 stack lines).
// Row: {ts, kind, session_id, session_file, pid, code, signal, error, stack, last_event, last_tool, rss_mb, uptime_s,
// write_ms}. SIGKILL / OOM-kill cannot be caught: a DEAD Director with NO row for its session is itself evidence.
//
// 🔴 BEHAVIOUR-NEUTRAL (the whole point of a flight recorder):
//   * registers NO tool, command, prompt or message: the prompt prefix is untouched;
//   * uncaught errors are observed through 'uncaughtExceptionMonitor' (never changes whether the process dies);
//     unhandled rejections (Bun does not route them to the monitor): recorded; when ours is the ONLY listener it
//     reproduces Bun's default outcome (error on stderr, exit code 1) — tested identical exit status; EXCEPT a
//     stale-ctx rejection from a dead extension runtime, which is logged (survived:true) and NOT fatal;
//   * a signal listener that is the ONLY listener removes itself and re-raises the signal after recording, so the
//     default "die by that signal" is preserved; when Pi has its own listener, it just records;
//   * sync append, bounded (row <= 16 KiB, file rotated to .1 past 5 MiB), every path wrapped: never throws, and the
//     write is a single appendFileSync to a local file (write_ms recorded; target < 50 ms).
// Kill switch: WOS_EXIT_RECORDER=0 (env) or ~/.wos-runtime/fleet/state/pi_exits.off.
// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = process.env.WOS_PI_EXITS_FILE || path.join(os.homedir(), ".wos-runtime", "fleet", "state", "pi_exits.jsonl");
const OFF = path.join(os.homedir(), ".wos-runtime", "fleet", "state", "pi_exits.off");
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROW = 16 * 1024;
const SIGNALS = ["SIGTERM", "SIGHUP", "SIGINT"];

type State = { sessionId: string; sessionFile: string; lastEvent: string; lastTool: string; wrote: Set<string>;
  handlers: Array<[string, (...a: any[]) => void]> };

function now() { return new Date().toISOString(); }

export function record(st: State, kind: string, extra: Record<string, unknown> = {}): void {
  const t0 = Date.now();
  try {
    if (process.env.WOS_EXIT_RECORDER === "0") return;
    try { fs.accessSync(OFF); return; } catch { /* not switched off */ }
    let rss = 0;
    try { rss = Math.round(process.memoryUsage().rss / 1048576); } catch { /* */ }
    const row: Record<string, unknown> = {
      ts: now(), kind, session_id: st.sessionId || String(process.env.PI_SESSION_ID || ""),
      session_file: st.sessionFile || "", pid: process.pid, ppid: process.ppid, last_event: st.lastEvent,
      last_tool: st.lastTool, rss_mb: rss, uptime_s: Math.round(process.uptime()), ...extra,
    };
    try { const s = fs.statSync(FILE); if (s.size > MAX_BYTES) fs.renameSync(FILE, FILE + ".1"); } catch { /* absent */ }
    row.write_ms = Date.now() - t0;
    let line = JSON.stringify(row);
    if (line.length > MAX_ROW) { row.stack = []; row.error = String(row.error || "").slice(0, 2000); line = JSON.stringify(row); }
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch { /* */ }
    fs.appendFileSync(FILE, line + "\n", { mode: 0o600 });
  } catch { /* a flight recorder never throws */ }
}

function errFields(e: any) {
  try {
    const msg = e && typeof e === "object" ? String(e.message ?? e) : String(e);
    const stack = e && e.stack ? String(e.stack).split("\n").slice(0, 20).map((l) => l.slice(0, 400)) : [];
    return { error: msg.slice(0, 2000), error_name: e?.name ? String(e.name) : typeof e, stack };
  } catch { return { error: "unformattable", stack: [] }; }
}

/** An extension-runtime stale-ctx rejection (Pi's assertActive message) raised from extension code. */
export function isStaleCtxRejection(reason: any): boolean {
  try {
    if (process.env.WOS_STALE_CTX_SURVIVE === "0") return false;
    const msg = String(reason?.message ?? reason ?? "");
    if (!/^This extension ctx is stale after session replacement or reload\./.test(msg)) return false;
    const stack = String(reason?.stack ?? "");
    return /assertActive/.test(stack) && /(\/\.pi\/agent\/extensions\/|\/\.wos-runtime\/|\/pi-extension\/|\.ts:\d+)/.test(stack);
  } catch { return false; }
}

export function install(target: any = process): State {
  const g: any = globalThis as any;
  const prev: State | undefined = g.__wosExitRecorder;
  if (prev) { for (const [ev, fn] of prev.handlers) { try { target.removeListener(ev, fn); } catch { /* */ } } }
  const st: State = { sessionId: prev?.sessionId ?? "", sessionFile: prev?.sessionFile ?? "", lastEvent: prev?.lastEvent ?? "",
    lastTool: prev?.lastTool ?? "", wrote: new Set(), handlers: [] };
  g.__wosExitRecorder = st;
  const on = (ev: string, fn: (...a: any[]) => void) => { target.on(ev, fn); st.handlers.push([ev, fn]); };
  on("exit", (code: number) => record(st, "exit", { code }));
  on("beforeExit", (code: number) => { if (!st.wrote.has("beforeExit")) { st.wrote.add("beforeExit"); record(st, "beforeExit", { code }); } });
  on("uncaughtExceptionMonitor", (err: any, origin: string) => record(st, "uncaughtException", { origin, ...errFields(err) }));
  // Bun (1.3.14, measured) does NOT route unhandled rejections through 'uncaughtExceptionMonitor', and any listener
  // suppresses its default (print + exit 1). So: when another listener already owns it, just record; when ours is
  // the only one, record and then reproduce Bun's default exactly as far as the outcome goes (error to stderr, exit 1).
  on("unhandledRejection", (reason: any) => {
    // 🔴 request 2026-09-30 (upstream_workarounds.yaml id pi-stale-ctx-rejection-exits): Pi 0.87.1
    // invalidates an old extension runtime on reload/session replacement, and a detached promise of that DEAD
    // runtime that touches its captured ctx rejects with "extension ctx is stale". Pi installs no isolation for
    // extension rejections, so Bun's default killed the whole Director (DIR-example 2026-09-30T14:40:12Z).
    // Such a rejection can only come from code whose runtime is already gone: log it, do NOT exit. Every other
    // rejection keeps Bun's default outcome. Kill switch: WOS_STALE_CTX_SURVIVE=0.
    if (isStaleCtxRejection(reason)) {
      record(st, "unhandledRejection", { ...errFields(reason), survived: true, policy: "stale-ctx-log-not-exit" });
      return;
    }
    record(st, "unhandledRejection", errFields(reason));
    if (target.listenerCount("unhandledRejection") === 1) {
      try { process.stderr.write("error: " + String(reason?.stack ?? reason) + "\n"); } catch { /* */ }
      target.exit(1);
    }
  });
  for (const sig of SIGNALS) {
    const fn = () => {
      record(st, "signal", { signal: sig });
      if (target.listenerCount(sig) === 1) {       // we are the only listener: preserve the default death
        try { target.removeListener(sig, fn); } catch { /* */ }
        try { target.kill(target.pid, sig); } catch { /* */ }
      }
    };
    // FIRST in line: Pi's own TUI handlers call process.exit(), which would otherwise pre-empt the signal row
    if (typeof target.prependListener === "function") { target.prependListener(sig, fn); st.handlers.push([sig, fn]); }
    else on(sig, fn);
  }
  return st;
}

export default function (pi: any) {
  if (process.env.WOS_EXIT_RECORDER === "0") return;
  const st = install(process);
  const ev = (name: string) => () => { st.lastEvent = `${now().slice(11, 23)} ${name}`; return undefined; };
  for (const name of ["input", "agent_start", "turn_start", "turn_end", "tool_result", "agent_end", "agent_settled",
    "session_compact", "session_shutdown"]) {
    try { pi.on(name, ev(name)); } catch { /* older runtimes */ }
  }
  try {
    pi.on("tool_call", (e: any) => { st.lastEvent = `${now().slice(11, 23)} tool_call`; st.lastTool = String(e?.toolName ?? e?.name ?? ""); return undefined; });
    pi.on("session_start", (e: any, ctx: any) => {
      try { st.sessionId = String(ctx?.sessionManager?.getSessionId?.() ?? st.sessionId); } catch { /* */ }
      try { st.sessionFile = String(ctx?.sessionManager?.getSessionFile?.() ?? st.sessionFile); } catch { /* */ }
      st.lastEvent = `${now().slice(11, 23)} session_start:${e?.reason ?? ""}`;
      return undefined;
    });
  } catch { /* */ }
}
