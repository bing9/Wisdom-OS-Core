/**
 * wos-session-lease — ONE writer per Pi session id (request 2026-09-26).
 *
 * 🔴 INCIDENT 2026-09-26 (request 2026-09-26). fleet_test T18 started a herdr
 * server on a private socket but the LIVE herdr state, so it restored every live agent pane and ran
 * `pi --session <real file>` for 3–8 s under the real session ids (14 runs that day). Those clones
 * loaded every global extension and, as far as each extension could tell, WERE the Director: they
 * rewrote the wos-return consumer markers (all 10 Directors -> consumer_capable=False), overwrote
 * the load receipts, and ran subagent report delivery (5 reports landed on dead transcript branches).
 * Pi has no single-writer rule for a session id. This file is that rule.
 *
 * CONTRACT
 *   * At session start the first process to take an exclusive flock(2) on
 *     ~/.wos-runtime/fleet/state/session-leases/<sid>.lock is the LEASE HOLDER. It records its pid,
 *     /proc starttime and boot id in the file. The kernel drops the lock when the process dies, so a
 *     lease can never go stale; an in-process /reload keeps the fd (held on globalThis).
 *   * Any other process for the same sid is a SHADOW: it runs, but the session-scoped writers
 *     (wos-return consumer marker + return drain, load receipts, subagent report reconcile /
 *     recovery) check the lease and stay read-only. It logs `shadow session: <pid>` and warns in the UI.
 *     A shadow keeps retrying (every 3 s) and is promoted if the holder exits — so a restarted pane
 *     that raced its dying predecessor still becomes the owner.
 *   * A process launched by a FIXTURE herdr server (env WOS_FIXTURE_HERDR=1, which
 *     fleet_boot_restore.sh sets on any non-live server, or a HERDR_SOCKET_PATH inside a fleet_test
 *     tree) never takes the lease and never retries: it is a shadow for life. Verified 2026-09-26:
 *     herdr panes inherit the server's environment and get HERDR_SOCKET_PATH = the server's socket.
 *   * Session switch (/new, /resume inside one process): acquiring a new sid FORGETS every other sid --
 *     held fds and a shadow's retry timer alike (r2; r1 kept the timer and could be promoted on the old sid).
 *   * FAIL-OPEN when the mechanism itself is unavailable (no bun:ffi / flock): status "unavailable",
 *     held=true, logged, stderr, and ONE director-inbox row per boot (r2: loud, never silent). The primary fix is test isolation; this is defence in depth and must never
 *     turn every live session read-only because of a loader quirk.
 *
 * API (order-independent: every consumer calls acquire(), which is idempotent and synchronous):
 *   globalThis[Symbol.for("wisdom-os.session-lease")] = {
 *     acquire(sid) -> LeaseState, status(sid) -> LeaseState|undefined,
 *     onAcquire(sid, cb) -> unsubscribe, version }
 * A consumer that finds no API behaves as before (held). Kill switch: WOS_SESSION_LEASE=0.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

export type LeaseStatus = "held" | "shadow" | "fixture" | "unavailable" | "disabled";
export type LeaseState = {
  sid: string;
  held: boolean;
  status: LeaseStatus;
  pid: number;
  holder_pid: number | null;
  lock_path: string;
  reason?: string;
  since: string;
};

const API_KEY = Symbol.for("wisdom-os.session-lease");
const STORE_KEY = Symbol.for("wisdom-os.session-lease.store");
export const LEASE_VERSION = "t18-lease-r2.1";
const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
const RETRY_MS = Number(process.env.WOS_SESSION_LEASE_RETRY_MS ?? 3000);

function leaseDir(): string {
  return process.env.WOS_SESSION_LEASE_DIR ??
    path.join(os.homedir(), ".wos-runtime", "fleet", "state", "session-leases");
}
function leaseLog(): string {
  return process.env.WOS_SESSION_LEASE_LOG ??
    path.join(os.homedir(), ".wos-runtime", "logs", "wos-session-lease.jsonl");
}
function safe(sid: string): string { return sid.replace(/[^A-Za-z0-9._-]/g, "_"); }

type Store = {
  fds: Map<string, number>;               // sid -> fd holding the flock (survives /reload)
  states: Map<string, LeaseState>;
  listeners: Map<string, Set<() => void>>;
  timers: Map<string, ReturnType<typeof setInterval>>;
};
const g = globalThis as any;
const store: Store = g[STORE_KEY] ?? (g[STORE_KEY] = {
  fds: new Map(), states: new Map(), listeners: new Map(), timers: new Map(),
});

// ── flock(2). Pi runs on Bun (pi.real = Bun 1.3.x); bun:ffi reaches libc directly. ───────────────
type FlockFn = (fd: number, op: number) => number;
let flockFn: FlockFn | null | undefined = (process.env.WOS_SESSION_LEASE_FORCE_UNAVAILABLE === "1") ? null : undefined;
function loadFlock(): FlockFn | null {
  if (flockFn !== undefined) return flockFn;
  flockFn = null;
  const tries: Array<() => any> = [
    () => (typeof (g as any).require === "function" ? (g as any).require("bun:ffi") : null),
    () => createRequire(import.meta.url)("bun:ffi"),
  ];
  for (const t of tries) {
    try {
      const ffi = t();
      if (!ffi?.dlopen) continue;
      for (const libName of ["libc.so.6", "libc.so"]) {
        try {
          const lib = ffi.dlopen(libName, { flock: { args: ["i32", "i32"], returns: "i32" } });
          flockFn = (fd, op) => Number(lib.symbols.flock(fd, op));
          return flockFn;
        } catch { /* next lib */ }
      }
    } catch { /* next loader */ }
  }
  return flockFn;
}

function procStarttime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch { return null; }
}
function bootId(): string {
  try { return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return "unknown"; }
}

function logEvent(row: Record<string, unknown>): void {
  try {
    const p = leaseLog();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), version: LEASE_VERSION, ...row }) + "\n");
  } catch { /* logging never blocks a session */ }
}

/** A process started by a fixture/test herdr server. Never an owner. */
export function fixtureOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.WOS_FIXTURE_HERDR === "1") return "WOS_FIXTURE_HERDR=1 (pane of a fixture herdr server)";
  if (env.WOS_SESSION_SHADOW === "1") return "WOS_SESSION_SHADOW=1";
  const sock = env.HERDR_SOCKET_PATH ?? "";
  if (/\/fleet_test_[^/]*\//.test(sock)) return `HERDR_SOCKET_PATH inside a fleet_test tree (${sock})`;
  return null;
}

function readHolder(lockPath: string): number | null {
  try {
    const j = JSON.parse(fs.readFileSync(lockPath, "utf8") || "{}");
    return Number.isInteger(j.pid) ? j.pid : null;
  } catch { return null; }
}

function recordHolder(fd: number, sid: string, lockPath: string): void {
  const body = JSON.stringify({
    session_id: sid, pid: process.pid, ppid: process.ppid, starttime: procStarttime(process.pid),
    boot_id: bootId(), herdr_socket: process.env.HERDR_SOCKET_PATH ?? null,
    herdr_pane: process.env.HERDR_PANE_ID ?? null, version: LEASE_VERSION, ts: new Date().toISOString(),
  }) + "\n";
  try { fs.ftruncateSync(fd, 0); fs.writeSync(fd, body, 0); } catch { /* holder record is observability */ }
  void lockPath;
}

function tryLock(sid: string): { ok: boolean; unavailable?: string; lockPath: string } {
  const lockPath = path.join(leaseDir(), `${safe(sid)}.lock`);
  const flock = loadFlock();
  if (!flock) return { ok: false, unavailable: "flock unavailable (no bun:ffi in this runtime)", lockPath };
  let fd: number;
  try {
    fs.mkdirSync(leaseDir(), { recursive: true });
    fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
  } catch (e: any) {
    return { ok: false, unavailable: `cannot open lease file: ${e?.message ?? e}`, lockPath };
  }
  if (flock(fd, LOCK_EX | LOCK_NB) === 0) {
    store.fds.set(sid, fd);
    recordHolder(fd, sid, lockPath);
    return { ok: true, lockPath };
  }
  try { fs.closeSync(fd); } catch { /* ignore */ }
  return { ok: false, lockPath };
}

function setState(s: LeaseState): LeaseState { store.states.set(s.sid, s); return s; }

/** Session switch (/new, /resume, /fork inside one process): forget EVERY other session this
 *  process knew -- held fds AND a shadow's retry timer, state and listeners. r1 released only held
 *  fds, so a shadow that switched sessions kept retrying its OLD sid, got promoted there when the
 *  real holder died, and a later genuine `pi --session <old>` became ITS shadow (verifier REOPEN 1). */
function forgetOtherSessions(sid: string): void {
  const others = new Set<string>([...store.fds.keys(), ...store.states.keys(), ...store.timers.keys(), ...store.listeners.keys()]);
  for (const other of others) {
    if (other === sid) continue;
    const fd = store.fds.get(other);
    if (fd !== undefined) {
      try { loadFlock()?.(fd, LOCK_UN); fs.closeSync(fd); } catch { /* ignore */ }
      store.fds.delete(other);
      logEvent({ event: "released", session: other, pid: process.pid, why: `switched to ${sid}` });
    }
    const t = store.timers.get(other);
    if (t) { clearInterval(t); store.timers.delete(other); logEvent({ event: "shadow-abandoned", session: other, pid: process.pid, why: `switched to ${sid}` }); }
    store.states.delete(other);
    store.listeners.delete(other);
  }
}

/** Fail-open must still be LOUD: one director-inbox row per boot, async, never blocking a session.
 *  r2.1 (DIR-wos follow-up): the once-per-boot stamp is written ONLY after the canonical append exits 0,
 *  and it is written BY THE APPEND CHILD itself (sh `append && stamp`), so it holds even if this Pi exits
 *  first. r2 wrote the stamp before spawning: one failed append silenced the alarm for the whole boot.
 *  A short in-flight claim (O_EXCL, stale after CLAIM_TTL_MS) keeps a burst of sessions from all appending
 *  at once; a failed append removes the claim so the next session retries. */
const CLAIM_TTL_MS = Number(process.env.WOS_SESSION_LEASE_CLAIM_TTL_MS ?? 60_000);
function signalUnavailable(why: string): void {
  try {
    const dir = leaseDir();
    const stamp = path.join(dir, ".unavailable-signalled");
    const claim = path.join(dir, ".unavailable-signalling");
    const boot = bootId();
    try { if (fs.readFileSync(stamp, "utf8").trim() === boot) return; } catch { /* not yet signalled this boot */ }
    fs.mkdirSync(dir, { recursive: true });
    const takeClaim = (): boolean => {
      try { fs.closeSync(fs.openSync(claim, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)); return true; }
      catch (e: any) { if (e?.code !== "EEXIST") throw e; return false; }
    };
    if (!takeClaim()) {
      let age = Infinity;
      try { age = Date.now() - fs.statSync(claim).mtimeMs; } catch { /* vanished: retry below */ }
      if (age < CLAIM_TTL_MS) return;                 // another session's append is in flight
      try { fs.unlinkSync(claim); } catch { /* raced */ }
      if (!takeClaim()) return;
    }
    const inbox = process.env.WOS_SESSION_LEASE_INBOX ?? path.join(os.homedir(), ".wos-runtime", "director_inbox.jsonl");
    const kernel = process.env.WOS_SESSION_LEASE_INBOX_KERNEL ?? path.join(os.homedir(), ".wos-runtime", "kg", "inbox_schema.py");
    const summary = `wos-session-lease UNAVAILABLE (${why}) -- sessions run FAIL-OPEN: no single-writer protection until fixed`;
    // $@ = the append argv. Stamp only on rc 0; the claim is released either way.
    const script = '"$@" && { printf "%s\\n" "$WOS_LEASE_BOOT" > "$WOS_LEASE_STAMP.tmp.$$" && mv -f "$WOS_LEASE_STAMP.tmp.$$" "$WOS_LEASE_STAMP"; }; ' +
      'rc=$?; rm -f "$WOS_LEASE_CLAIM"; exit $rc';
    const child = spawn("/bin/sh", ["-c", script, "wos-lease-signal", "/usr/bin/python3", kernel, "append",
      "--summary", summary, "--session", "wos-session-lease", "--status", "finding", "--to", "DIR-wos", "--path", inbox,
      "--json", JSON.stringify({ kind: "session-lease-unavailable", needs_director: true, pid: process.pid, boot_id: boot })],
      { stdio: "ignore", detached: true,
        // an earlier request r2: local $HOME cwd (Bun chdir()s into the cwd inside vfork() while Pi is frozen).
        // Only when every path the script touches is absolute (the defaults are; a relative test-seam path keeps the
        // old cwd). inbox_schema.py append is cwd-independent (evidence r2/cwd_probe_results.txt).
        ...([stamp, claim, inbox, kernel].every((p) => path.isAbsolute(p)) ? { cwd: os.homedir() } : {}),
        env: { ...process.env, WOS_LEASE_BOOT: boot, WOS_LEASE_STAMP: stamp, WOS_LEASE_CLAIM: claim } });
    child.on("error", () => { try { fs.unlinkSync(claim); } catch { /* ignore */ } });
    child.on("exit", (code) => logEvent({ event: code === 0 ? "unavailable-signalled" : "unavailable-signal-failed", pid: process.pid, rc: code, inbox }));
    child.unref();
    logEvent({ event: "unavailable-signal-spawned", pid: process.pid, inbox });
  } catch { /* never blocks a session */ }
}

function startRetry(sid: string): void {
  if (store.timers.has(sid) || RETRY_MS <= 0) return;
  const t = setInterval(() => {
    const cur = store.states.get(sid);
    if (!cur || cur.status !== "shadow") { clearInterval(t); store.timers.delete(sid); return; }
    const r = tryLock(sid);
    if (!r.ok) return;
    clearInterval(t); store.timers.delete(sid);
    setState({ sid, held: true, status: "held", pid: process.pid, holder_pid: process.pid,
      lock_path: r.lockPath, reason: "promoted: previous holder exited", since: new Date().toISOString() });
    logEvent({ event: "promoted", session: sid, pid: process.pid, ppid: process.ppid });
    for (const cb of [...(store.listeners.get(sid) ?? [])]) { try { cb(); } catch { /* one listener never blocks others */ } }
  }, RETRY_MS);
  (t as any).unref?.();
  store.timers.set(sid, t);
}

export function acquire(sid: string): LeaseState {
  const now = new Date().toISOString();
  const lockPath = path.join(leaseDir(), `${safe(sid || "unknown")}.lock`);
  if (!sid) return { sid, held: true, status: "unavailable", pid: process.pid, holder_pid: null, lock_path: lockPath, reason: "no session id", since: now };
  forgetOtherSessions(sid);
  const cur = store.states.get(sid);
  if (cur && (cur.status !== "shadow" || store.timers.has(sid))) return cur;
  if (process.env.WOS_SESSION_LEASE === "0") {
    return setState({ sid, held: true, status: "disabled", pid: process.pid, holder_pid: null, lock_path: lockPath, reason: "WOS_SESSION_LEASE=0", since: now });
  }
  const fixture = fixtureOrigin();
  if (fixture) {
    logEvent({ event: "shadow", session: sid, pid: process.pid, ppid: process.ppid, why: "fixture", detail: fixture,
      herdr_socket: process.env.HERDR_SOCKET_PATH ?? null });
    try { process.stderr.write(`wos-session-lease: shadow session: ${process.pid} (${fixture})\n`); } catch { /* ignore */ }
    return setState({ sid, held: false, status: "fixture", pid: process.pid, holder_pid: readHolder(lockPath), lock_path: lockPath, reason: fixture, since: now });
  }
  if (store.fds.has(sid)) {
    return setState({ sid, held: true, status: "held", pid: process.pid, holder_pid: process.pid, lock_path: lockPath, reason: "already held by this process (reload)", since: cur?.since ?? now });
  }
  const r = tryLock(sid);
  if (r.unavailable) {
    logEvent({ event: "unavailable", session: sid, pid: process.pid, why: r.unavailable });
    try { process.stderr.write(`wos-session-lease: UNAVAILABLE (${r.unavailable}); running fail-open\n`); } catch { /* ignore */ }
    signalUnavailable(r.unavailable);
    return setState({ sid, held: true, status: "unavailable", pid: process.pid, holder_pid: null, lock_path: r.lockPath, reason: r.unavailable, since: now });
  }
  if (r.ok) {
    logEvent({ event: "acquired", session: sid, pid: process.pid, ppid: process.ppid, herdr_socket: process.env.HERDR_SOCKET_PATH ?? null });
    return setState({ sid, held: true, status: "held", pid: process.pid, holder_pid: process.pid, lock_path: r.lockPath, since: now });
  }
  const holder = readHolder(r.lockPath);
  logEvent({ event: "shadow", session: sid, pid: process.pid, ppid: process.ppid, holder_pid: holder, why: "lease held by another process",
    herdr_socket: process.env.HERDR_SOCKET_PATH ?? null });
  try { process.stderr.write(`wos-session-lease: shadow session: ${process.pid} (holder ${holder ?? "?"})\n`); } catch { /* ignore */ }
  const s = setState({ sid, held: false, status: "shadow", pid: process.pid, holder_pid: holder, lock_path: r.lockPath,
    reason: `lease held by pid ${holder ?? "?"}`, since: now });
  startRetry(sid);
  return s;
}

export function status(sid: string): LeaseState | undefined { return store.states.get(sid); }

export function onAcquire(sid: string, cb: () => void): () => void {
  const set = store.listeners.get(sid) ?? new Set();
  set.add(cb); store.listeners.set(sid, set);
  return () => { set.delete(cb); };
}

/** Consumer helper (copy this shape; do not import across packages). Absent API => behave as before. */
export function leaseFor(sid: string): LeaseState | { held: true; status: "absent" } {
  const api = (globalThis as any)[API_KEY];
  if (!api?.acquire) return { held: true, status: "absent" };
  try { return api.acquire(sid); } catch { return { held: true, status: "absent" }; }
}

g[API_KEY] = { acquire, status, onAcquire, version: LEASE_VERSION };

export default function (pi: any) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      const sid = String(ctx?.sessionManager?.getSessionId?.() ?? "");
      const s = acquire(sid);
      if (!s.held) {
        const msg = `wos-session-lease: shadow session: ${process.pid} — another process (pid ${s.holder_pid ?? "?"}) owns ` +
          `${sid.slice(0, 8)}; this one runs READ-ONLY (no return marker, receipts or report delivery). ${s.reason ?? ""}`;
        ctx?.ui?.notify?.(msg, "warning");
        ctx?.ui?.setStatus?.("wos-session-lease", `SHADOW ${process.pid}`);
      } else if (s.status === "held") {
        ctx?.ui?.setStatus?.("wos-session-lease", undefined);
      } else if (s.status === "unavailable") {
        ctx?.ui?.setStatus?.("wos-session-lease", "lease n/a");
      }
      if (s.status === "shadow") onAcquire(sid, () => {
        try {
          ctx?.ui?.setStatus?.("wos-session-lease", undefined);
          ctx?.ui?.notify?.(`wos-session-lease: promoted to owner of ${sid.slice(0, 8)} (previous holder exited)`, "info");
        } catch { /* stale ctx */ }
      });
    } catch { /* the lease never blocks a session */ }
  });
}
