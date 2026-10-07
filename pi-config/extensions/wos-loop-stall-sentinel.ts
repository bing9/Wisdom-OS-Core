// request 2026-09-27 F5 r2 (+ request 2026-09-27 r3 sampler). Event-loop stall sentinel for Directors.
//
// Every main-thread stall of at least STALL_MS (default 1000 ms) is recorded together with the last Pi events
// seen, so the next "Enter doesn't send" report can be attributed from a file instead of reproduced.
// Output: ~/.wos-runtime/state/pi-loop-stalls/<pid>.jsonl. Kill switch: WOS_STALL_SENTINEL=0.
//
// r2 addresses the verifier's finding: r1 called statSync/renameSync/appendFileSync inside the 100 ms timer,
// and a FIFO at the destination could block the event loop forever. Now:
//  - The timer callback does no I/O. It only pushes a row into a bounded in-memory queue
//    (QUEUE_CAP; when the queue is full the row is dropped and counted).
//  - One async drain at a time does all I/O through fs.promises.
//  - The destination is lstat-ed and must be absent or a regular file. Anything else (FIFO, socket,
//    symlink, device, directory) makes the writer refuse permanently and log nothing.
//  - The file is opened O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW|O_NONBLOCK and fstat-ed after open. This closes
//    the race where the path is swapped for a FIFO between lstat and open: on Linux, a FIFO with no reader
//    returns ENXIO instead of blocking, and a FIFO with a reader fails the fstat regular-file check.
//  - Rotation happens at ROTATE_BYTES, as an async rename.
//
// request 2026-09-27 (F5 r3): the next stall NAMES ITS FILE. An in-process worker thread watches a
// heartbeat the main thread writes into a SharedArrayBuffer. When the main loop is late by more than
// SAMPLE_AFTER_MS (3 s) the worker reads /proc/self/task/<main tid>/{syscall,wchan,stat}, resolves an fd
// argument through /proc/self/fd/<n> and a path-pointer argument through /proc/self/mem (the process's own
// address space: no ptrace, no second process), and publishes the sample in the SharedArrayBuffer. When the loop
// resumes, the main thread attaches the sample to that stall's row as `blocked`. A stall still running after
// SELF_WRITE_AFTER_MS (10 s) is also appended by the worker itself (async fs, same O_NOFOLLOW discipline) to
// <pid>.blocked.jsonl, so even a hang that never returns is named. Kill switch: WOS_STALL_SAMPLER=0.
//
// @pi-child-safe: diagnostics only — appends stall rows to ~/.wos-runtime/state/pi-loop-stalls/<pid>*.jsonl; every hook returns undefined and no tool/model input is changed, so restricted subagent children are measured too (request 2026-09-30 S)
//
// request 2026-09-30 (S, r4). Three defects from RCA request 2026-09-30 §5-§6, §11:
//  1. STOLEN SAMPLE: 55 stalls >= 11 s had no sample although one WAS taken — a second live sentinel instance in the
//     same pid logged a short sibling row <= 1 s earlier and consumed it (rows keyed the sample by "a seq I have not
//     seen"). Now (a) one GENERATION per process: every factory call bumps it and an older instance's timer retires
//     itself on its next tick (even if its handle was never cleared) and its handlers stop recording; (b) the sample
//     is attached by its EPISODE (the heartbeat at which the stall began) matching the row's own stall start, not by
//     consumption, so no other reader can take it and a short sibling can never claim a long stall's sample.
//  2. CHILD BLIND SPOT: the @pi-child-safe marker above lets pi-interactive-subagents load it in children; rows carry
//     `child` (PI_SUBAGENT_NAME) so the RCA can split roles.
//  3. ON-CPU (35% of seconds, cause unknown): when a stall stays in state R for >= ONCPU_AFTER_MS (5 s) the worker
//     runs `perf record -t <main tid> -g -- sleep 3` (async, cwd $HOME, minimal env), folds `perf script -F ip,sym,dso`
//     into top stacks, adds the thread's utime/stime delta, deletes perf.data, and appends ONE row to
//     <pid>.oncpu.jsonl (rotated at 1 MB). No perf → /proc/self/task/<tid>/{stack,wchan} + utime/stime. Bounded: one
//     capture per episode, >= ONCPU_MIN_GAP_MS apart, <= ONCPU_MAX_PER_PROC per process. No secrets: code symbols,
//     DSO names and addresses only (never argv/env/memory). Bun has no cross-thread JS sampler, but JSC's in-thread
//     sampling profiler (bun:jsc) is available OPT-IN (env WOS_STALL_JSPROF=1 or file <dir>/jsprof.on at load): the
//     main timer drains it every 2 s and, after an on-CPU stall >= 5 s, writes the top JS stacks (function@file:line).
//     Kill switch for the capture alone: WOS_STALL_ONCPU=0.
//
// request 2026-10-01 (r5). Evidence: request 2026-10-01 (REPORT + dup_pairs.py).
//  1. SPLIT ROWS: the r4 "second instance" premise is refuted (155/155 duplicate pairs share one gen, 0/198 pids show an
//     older gen after a newer one). One timer tick that ends a 1-2 s lead-in is frozen mid-callback; the NEXT tick then
//     reports the freeze. Short + long + 200 ms equals the wall time (53/53, |resid| <= 2 ms). r5 holds a stall row for one
//     tick. The next stall tick is merged into it as a further LEG only when that leg's time was spent INSIDE the previous
//     tick callback (time from that callback's return to this tick < STALL_MS), i.e. exactly the frozen-mid-callback
//     split. Two separate stalls one tick apart stay two rows. stallMs = sum(legsMs) + 100 ms per extra tick (= wall
//     time - 100 ms, as for an unsplit row); legsMs keeps the parts. Written on the next on-time tick, or at
//     shutdown/reload.
//  2. r4's per-row sample attachment (sampleForStall on each leg) assumed a sibling instance stealing the sample. With
//     one instance it put the sample on the SHORT leg (116/148 short-first pairs). r5 attaches once per merged episode
//     (sampleForEpisode: the sample's episode lies between the episode's first and last pre-stall beats). The
//     generation counter stays only as /reload hygiene (it writes `gen`); it is not a second-instance fix.
//  3. EXTERNAL HEARTBEAT: the in-process worker freezes with the process (43/46 samples taken at stall END), so a
//     watcher OUTSIDE Pi (~/.wos-runtime/harness/pi_freeze_watcher.py) needs the beat. Non-child Pis map a 64-byte file
//     /dev/shm/wos-pi-hb/<pid>.hb (tmpfs, Bun.mmap MAP_SHARED) and the timer stores Date.now() into it: one memory
//     store per tick, no syscall. The file is unlinked at exit. Kill switch: WOS_STALL_HB=0; WOS_STALL_HB=all also
//     covers subagent children.
//
// request 2026-10-07 (fix 3). 2026-10-07 DIR-wos sat 44.5 min in ONE on-CPU main-thread stall; the only
// alert came 26 min in, from the health audit, and it said "idle poller". A frozen main thread cannot report itself and
// its tool timeouts cannot fire, so the WORKER now escalates: when one stall has lasted >= ALERT_AFTER_MS (5 min) and
// the main thread spent >= ALERT_CPU_FRAC (80 %) of it on-CPU (utime+stime ticks since the stall's first sample), the
// worker sends ONE 'wos_send --from stall-sentinel --kind relay --purpose fyi' to DIR-example and ONE to DIR-wos (one if
// they are the same). The relay names the Director, pid, stall start, last tool call (name, id, first 120 chars of its
// command, read from the transcript tail), last Pi event, and capture paths. When the loop resumes, the worker queues
// ONE message to the stalled Director itself ("you were frozen <start> → <end>, <duration>"; wos_send delivers it after
// the current turn). Dedupe per stall: in memory per episode, and O_EXCL marker files <pid>.alert.<episode>.json /
// .end.json (the audit trail: what was sent, rc of each send). Only registered Directors/Butler (om_current.json) are
// alerted; subagent children never (their parent's overdue check covers them). Sends run as child processes of the
// worker with a cron-like env (no PI_SESSION_*, so wos_send labels the sender `stall-sentinel`), 60 s timeout each.
// Kill switch: WOS_STALL_ALERT=0. Seams: WOS_STALL_SEND, WOS_STALL_ALERT_MS, WOS_STALL_ALERT_CPU, WOS_STALL_REGISTRY,
// WOS_STALL_FREEZE_DIR.
import fs, { promises as fsp, constants as C } from "node:fs";
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "node:path";

export const QUEUE_CAP = 64;
export const ROTATE_BYTES = 2_000_000;

export type StallWriter = {
  enqueue: (row: unknown) => void; // synchronous, never does I/O
  idle: () => Promise<void>;       // resolves when the current drain (if any) finishes (tests)
  state: { written: number; dropped: number; refused: string | null; draining: boolean };
};

export function createStallWriter(file: string, dir = path.dirname(file)): StallWriter {
  const queue: string[] = [];
  const state = { written: 0, dropped: 0, refused: null as string | null, draining: false };
  let current: Promise<void> = Promise.resolve();

  async function writeBatch(lines: string[]): Promise<void> {
    await fsp.mkdir(dir, { recursive: true });
    try {
      const st = await fsp.lstat(file);
      if (!st.isFile()) { state.refused = `destination is not a regular file (${st.isFIFO() ? "fifo" : st.isSymbolicLink() ? "symlink" : "other"})`; return; }
      if (st.size > ROTATE_BYTES) await fsp.rename(file, file + ".1").catch(() => undefined);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
    const fh = await fsp.open(file, C.O_WRONLY | C.O_APPEND | C.O_CREAT | C.O_NOFOLLOW | C.O_NONBLOCK, 0o600);
    try {
      const st = await fh.stat();
      if (!st.isFile()) { state.refused = "destination became non-regular between lstat and open"; return; }
      await fh.write(lines.join(""));
      state.written += lines.length;
    } finally {
      await fh.close();
    }
  }

  function drain(): void {
    if (state.draining || state.refused || queue.length === 0) return;
    state.draining = true;
    const batch = queue.splice(0, queue.length);
    current = writeBatch(batch)
      .catch((e: any) => { if (e?.code === "ENXIO" || e?.code === "ELOOP") state.refused = `open refused (${e.code})`; })
      .finally(() => { state.draining = false; if (!state.refused && queue.length) drain(); });
  }

  return {
    enqueue(row: unknown) {
      if (state.refused) return;
      if (queue.length >= QUEUE_CAP) { state.dropped++; return; }
      queue.push(JSON.stringify(row) + "\n");
      queueMicrotask(drain); // hand off; the caller (timer) never waits on I/O
    },
    idle: () => current,
    state,
  };
}

export const SAMPLE_AFTER_MS = 3000;
export const SELF_WRITE_AFTER_MS = 10_000;
// x86_64 syscall numbers → which argument is a PATH pointer / an FD. (Linux x86_64 ABI.)
export const PATH_ARG: Record<number, number> = {
  2: 0, 4: 0, 6: 0, 21: 0, 82: 0, 83: 0, 84: 0, 87: 0, 89: 0, 90: 0, 92: 0, 94: 0, 137: 0, 161: 0, 188: 0, 191: 0,
  257: 1, 258: 1, 262: 1, 263: 1, 264: 1, 267: 1, 268: 1, 269: 1, 316: 1, 332: 1, 437: 1, 439: 1,
};
export const FD_ARG: Record<number, number> = {
  0: 0, 1: 0, 3: 0, 5: 0, 8: 0, 16: 0, 17: 0, 18: 0, 19: 0, 20: 0, 72: 0, 74: 0, 75: 0, 77: 0, 78: 0, 81: 0, 138: 0,
  190: 0, 193: 0, 196: 0, 217: 0, 285: 0, 295: 0, 296: 0,
};
export const SYSCALL_NAME: Record<number, string> = {
  0: "read", 1: "write", 2: "open", 3: "close", 4: "stat", 5: "fstat", 6: "lstat", 8: "lseek", 16: "ioctl", 17: "pread64",
  18: "pwrite64", 21: "access", 72: "fcntl", 74: "fsync", 75: "fdatasync", 77: "ftruncate", 78: "getdents", 82: "rename",
  83: "mkdir", 84: "rmdir", 87: "unlink", 89: "readlink", 90: "chmod", 217: "getdents64", 257: "openat", 258: "mkdirat",
  262: "newfstatat", 263: "unlinkat", 264: "renameat", 267: "readlinkat", 269: "faccessat", 316: "renameat2",
  332: "statx", 439: "faccessat2", 202: "futex", 232: "epoll_wait", 281: "epoll_pwait", 441: "epoll_pwait2",
};
// The worker body. It is self-contained (runs in a fresh isolate); the tables are injected as JSON.
const SAMPLER_SRC = `
const { workerData, parentPort } = require("node:worker_threads"); const fs = require("node:fs");
const { sab, tid, pid, dir, sampleAfter, selfWriteAfter, PATH_ARG, FD_ARG, NAMES, oncpu, alert } = workerData;
// fix 3: the main thread posts {ctx:{sessionId, sessionFile}} at session_start and {ev:"HH:MM:SS.mmm name"} per Pi event.
const ctx = { sessionId: "", sessionFile: "", lastEvent: "" };
if (parentPort) parentPort.on("message", (m) => { try { if (m && m.ctx) Object.assign(ctx, m.ctx); if (m && m.ev) ctx.lastEvent = String(m.ev).slice(0, 80); } catch {} });
if (parentPort && parentPort.unref) parentPort.unref();
const beat = new Float64Array(sab, 0, 1); const meta = new Int32Array(sab, 8, 2); const out = new Uint8Array(sab, 16);
const rd = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch (e) { return "ERR:" + (e && e.code); } };
const fdPath = (fd) => { try { return fs.readlinkSync("/proc/self/fd/" + fd); } catch (e) { return "ERR:" + (e && e.code); } };
function memString(addr) {
  let fd; try { fd = fs.openSync("/proc/self/mem", "r"); } catch (e) { return "ERR:" + (e && e.code); }
  try {
    const out = []; let at = addr;
    for (let i = 0; i < 4; i++) {                       // at most 4 KiB, never across an unmapped page
      const n = 4096 - (at % 4096); const b = Buffer.alloc(n);
      let got; try { got = fs.readSync(fd, b, 0, n, at); } catch (e) { return out.length ? Buffer.concat(out).toString("utf8") : "ERR:" + (e && e.code); }
      const z = b.subarray(0, got).indexOf(0);
      if (z >= 0) { out.push(b.subarray(0, z)); break; }
      out.push(b.subarray(0, got)); at += got; if (got < n) break;
    }
    return Buffer.concat(out).toString("utf8");
  } finally { try { fs.closeSync(fd); } catch {} }
}
function sample(lateMs) {
  const t = "/proc/self/task/" + tid;
  const sc = rd(t + "/syscall"); const wchan = rd(t + "/wchan"); const st = rd(t + "/stat");
  const state = (st.split(") ")[1] || "").split(" ")[0] || "?";
  const row = { at: new Date().toISOString(), lateMs: Math.round(lateMs), tid, state, wchan, syscallRaw: sc.slice(0, 200) };
  const f = sc.split(" ");
  const nr = Number(f[0]);
  if (Number.isFinite(nr) && nr >= 0 && f.length >= 7) {
    const a = f.slice(1, 7).map((x) => BigInt.asIntN(64, BigInt(x)));
    row.syscall = NAMES[nr] || String(nr);
    if (PATH_ARG[nr] !== undefined) {
      const ptr = a[PATH_ARG[nr]]; row.path = ptr > 0n ? memString(Number(ptr)) : "ERR:null";
      if (PATH_ARG[nr] === 1 && a[0] !== -100n && a[0] >= 0n) row.dirfd = fdPath(Number(a[0]));
      if (row.path && !row.path.startsWith("/") && !row.dirfd) { try { row.cwd = fs.readlinkSync("/proc/self/cwd"); } catch {} }
    }
    if (FD_ARG[nr] !== undefined && a[FD_ARG[nr]] >= 0n) { row.fd = Number(a[FD_ARG[nr]]); row.fdPath = fdPath(row.fd); }
  }
  return row;
}
function publish(row) {
  let b = Buffer.from(JSON.stringify(row)); if (b.length > out.length) b = b.subarray(0, out.length);
  out.set(b); Atomics.store(meta, 1, b.length); Atomics.add(meta, 0, 1);
}
let episode = 0, sampledFor = 0, wroteFor = 0;
// --- r4: on-CPU capture (worker side; the main thread is the one that is stuck) ---
let rSince = 0, capturedFor = 0, lastCaptureAt = 0, captures = 0, capturing = false;
const cpuOf = () => { const st = rd("/proc/self/task/" + tid + "/stat"); const f = (st.split(") ")[1] || "").split(" ");
  return { state: f[0] || "?", utime: Number(f[11]) || 0, stime: Number(f[12]) || 0 }; };
const frameOf = (line) => { const m = /^\\s*([0-9a-f]+)\\s+(.*?)\\s+\\((.*)\\)\\s*$/.exec(line); if (!m) return null;
  const dso = m[3].split("/").pop(); return m[2] && m[2] !== "[unknown]" ? m[2].replace(/\\s+/g, " ").slice(0, 120) + "@" + dso : dso + "+0x" + m[1]; };
function fold(text) {
  const stacks = new Map(), leaf = new Map(); let n = 0;
  for (const block of text.split(/\\n\\s*\\n/)) {
    const fr = block.split("\\n").map(frameOf).filter(Boolean); if (!fr.length) continue; n++;
    const key = fr.slice(0, 24).join(" <- "); stacks.set(key, (stacks.get(key) || 0) + 1); leaf.set(fr[0], (leaf.get(fr[0]) || 0) + 1);
  }
  const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([s, c]) => ({ n: c, s }));
  return { samples: n, topStacks: top(stacks, 15), topLeaf: top(leaf, 20) };
}
async function appendRot(file, row) {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    try { const s = await fs.promises.lstat(file); if (!s.isFile()) return; if (s.size > oncpu.rotateBytes) await fs.promises.rename(file, file + ".1"); } catch (e) { if (!e || e.code !== "ENOENT") return; }
    const C = fs.constants;
    const fh = await fs.promises.open(file, C.O_WRONLY | C.O_APPEND | C.O_CREAT | C.O_NOFOLLOW | C.O_NONBLOCK, 0o600);
    try { if ((await fh.stat()).isFile()) await fh.write(JSON.stringify(row) + "\\n"); } finally { await fh.close(); }
  } catch {}
}
function capture(late) {
  capturing = true; lastCaptureAt = Date.now(); captures++;
  const cp = require("node:child_process"); const t0 = cpuOf(); const at = new Date().toISOString();
  const row = { at, kind: "oncpu", pid, tid, episode, lateMs: Math.round(late), onCpuForMs: Date.now() - rSince, seconds: oncpu.seconds };
  const out = dir + "/" + pid + ".oncpu.jsonl";
  const env = { PATH: "/usr/bin:/bin:/usr/sbin", LANG: "C", HOME: oncpu.home };
  const done = (extra) => { const t1 = cpuOf(); row.cpu = { utimeTicks: t1.utime - t0.utime, stimeTicks: t1.stime - t0.stime, stateAfter: t1.state };
    Object.assign(row, extra); appendRot(out, row).finally(() => { capturing = false; }); };
  const fallback = (why) => setTimeout(() => done({ method: "proc", why, kstack: rd("/proc/self/task/" + tid + "/stack").slice(0, 2000),
    wchan: rd("/proc/self/task/" + tid + "/wchan") }), 1000);
  if (!oncpu.perf) return fallback("no perf binary");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const data = dir + "/.oncpu-" + pid + "-" + captures + ".perf.data";
  let rec; try { rec = cp.spawn(oncpu.perf, ["record", "-q", "-t", String(tid), "-g", "-F", "199", "-o", data, "--", "sleep", String(oncpu.seconds)],
    { cwd: oncpu.home, env, stdio: "ignore" }); } catch (e) { return fallback("perf spawn: " + (e && e.code)); }
  const kill = setTimeout(() => { try { rec.kill("SIGKILL"); } catch {} }, (oncpu.seconds + 10) * 1000);
  rec.on("error", (e) => { clearTimeout(kill); fs.promises.unlink(data).catch(() => {}); fallback("perf error: " + (e && e.code)); });
  rec.on("exit", (code) => {
    clearTimeout(kill);
    if (code !== 0) { fs.promises.unlink(data).catch(() => {}); return fallback("perf record rc " + code); }
    let txt = "", size = 0;
    let sc; try { sc = cp.spawn(oncpu.perf, ["script", "-i", data, "-F", "ip,sym,dso"], { cwd: oncpu.home, env, stdio: ["ignore", "pipe", "ignore"] }); }
    catch (e) { fs.promises.unlink(data).catch(() => {}); return fallback("perf script spawn"); }
    const k2 = setTimeout(() => { try { sc.kill("SIGKILL"); } catch {} }, 30000);
    sc.stdout.on("data", (d) => { size += d.length; if (size <= 8 * 1024 * 1024) txt += d; });
    sc.on("exit", () => { clearTimeout(k2); fs.promises.unlink(data).catch(() => {}); done({ method: "perf", perf: fold(txt), scriptBytes: size }); });
    sc.on("error", () => { clearTimeout(k2); fs.promises.unlink(data).catch(() => {}); fallback("perf script error"); });
  });
}
function onCpuTick(late) {
  if (!oncpu || !oncpu.enabled) return;
  const st = cpuOf().state;
  if (st === "R") { if (!rSince) rSince = Date.now(); } else rSince = 0;
  if (rSince && Date.now() - rSince >= oncpu.after && capturedFor !== episode && !capturing && captures < oncpu.maxPerProc
      && Date.now() - lastCaptureAt >= oncpu.minGap) { capturedFor = episode; capture(late); }
}
async function selfWrite(row) {
  try {
    const file = dir + "/" + pid + ".blocked.jsonl";
    await fs.promises.mkdir(dir, { recursive: true });
    try { const s = await fs.promises.lstat(file); if (!s.isFile()) return; } catch (e) { if (!e || e.code !== "ENOENT") return; }
    const C = fs.constants;
    const fh = await fs.promises.open(file, C.O_WRONLY | C.O_APPEND | C.O_CREAT | C.O_NOFOLLOW | C.O_NONBLOCK, 0o600);
    try { if ((await fh.stat()).isFile()) await fh.write(JSON.stringify(row) + "\\n"); } finally { await fh.close(); }
  } catch {}
}
// --- fix 3 (request 2026-10-07): real-time escalation of a long CPU-bound stall ---
let alertedFor = 0, endSentFor = 0, cpuEp = 0, cpu0 = 0, cpuT0 = 0;
const isoOf = (ms) => new Date(ms).toISOString();
const durOf = (ms) => ms >= 3600000 ? (ms / 3600000).toFixed(1) + " h" : (ms / 60000).toFixed(1) + " min";
async function readTail(file, n) {
  let fh; try { fh = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return ""; }
  try { const st = await fh.stat(); if (!st.isFile()) return ""; const off = Math.max(0, st.size - n); const b = Buffer.alloc(st.size - off);
    const { bytesRead } = await fh.read(b, 0, b.length, off); let s = b.subarray(0, bytesRead).toString("utf8");
    if (off > 0) s = s.slice(s.indexOf("\\n") + 1); return s; } catch { return ""; } finally { try { await fh.close(); } catch {} }
}
async function sessionOf() {
  let sid = ctx.sessionId;
  if (!sid) { try { const a = fs.readFileSync("/proc/self/cmdline", "utf8").split("\\0"); const i = a.indexOf("--session");
    const m = i >= 0 ? /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(a[i + 1] || "") : null; if (m) sid = m[0]; } catch {} }
  let label = "", file = ctx.sessionFile;
  try { const reg = JSON.parse((await readTail(alert.registry, 4 << 20)) || "{}");
    for (const [k, v] of Object.entries(reg)) if (sid && v && typeof v === "object" && v.session_uuid === sid && (v.state == null || v.state === "active")) { label = k; file = file || v.session_path || ""; }
  } catch {}
  return { sid, label, file };
}
async function lastToolCall(file, beforeMs) {
  if (!file) return null;
  const lines = (await readTail(file, 1 << 20)).split("\\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]; if (!l.includes('"toolCall"')) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    const at = Date.parse(e && e.timestamp); if (!Number.isFinite(at) || at > beforeMs + 5000) continue;
    const bl = ((e.message && e.message.content) || []).filter((b) => b && b.type === "toolCall"); if (!bl.length) continue;
    const b = bl[bl.length - 1]; const a = b.arguments || {};
    const head = String(a.command || a.path || a.task || a.message || "").replace(/\\s+/g, " ").slice(0, 120);
    return { name: String(b.name || "?"), id: String(b.id || "").slice(0, 40), at: isoOf(at), head };
  }
  return null;
}
function sendOne(to, text) {
  return new Promise((res) => {
    let p; const cp = require("node:child_process");
    const env = { HOME: oncpu.home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8", USER: process.env.USER || "" };
    try { p = cp.spawn(alert.send, ["--from", "stall-sentinel", "--to", to, "--kind", "relay", "--purpose", "fyi", "--text", text],
      { cwd: oncpu.home, env, stdio: ["ignore", "ignore", "pipe"] }); } catch (e) { return res({ to, rc: null, err: "spawn " + (e && e.code) }); }
    let err = ""; const k = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 60000);
    p.stderr.on("data", (d) => { if (err.length < 4000) err += d; });
    p.on("error", (e) => { clearTimeout(k); res({ to, rc: null, err: "error " + (e && e.code) }); });
    p.on("exit", (rc) => { clearTimeout(k); res(rc === 0 ? { to, rc } : { to, rc, err: err.trim().split("\\n").slice(-1)[0].slice(0, 200) }); });
  });
}
async function claim(file) {   // O_EXCL: exactly one writer per stall, across worker restarts
  try { await fs.promises.mkdir(dir, { recursive: true }); const C = fs.constants;
    return await fs.promises.open(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | C.O_NONBLOCK, 0o600); } catch { return null; }
}
async function captureList() {
  const out = [];
  for (const f of [dir + "/" + pid + ".oncpu.jsonl", dir + "/" + pid + ".blocked.jsonl"]) { try { if ((await fs.promises.lstat(f)).isFile()) out.push(f); } catch {} }
  out.push(alert.freezeDir + "/<stamp>-" + pid + ".json (external watcher)");
  return out;
}
async function fireStall(ep, late, frac) {
  const fh = await claim(dir + "/" + pid + ".alert." + ep + ".json"); if (!fh) return;
  const row = { at: isoOf(Date.now()), kind: "stall-alert", pid, episode: ep, start: isoOf(ep), lateMs: Math.round(late), cpuFrac: +frac.toFixed(3), lastEvent: ctx.lastEvent || null };
  try {
    const s = await sessionOf(); row.label = s.label || null; row.sessionId = s.sid || null;
    row.tool = await lastToolCall(s.file, ep); row.captures = await captureList();
    if (!s.label) { row.skipped = "session is not a registered Director/Butler (om_current.json)"; return; }
    const tool = row.tool ? row.tool.name + " " + row.tool.id + " at " + row.tool.at + ': "' + row.tool.head + '"' : "unknown (no toolCall in the transcript tail)";
    const text = "[pi-main-thread-stall] " + s.label + " (pid " + pid + ", session " + s.sid + "): the Pi main thread has been FROZEN since " +
      row.start + " (" + durOf(late) + " so far, " + Math.round(frac * 100) + "% of it on-CPU). Last tool call: " + tool + ". Last Pi event: " +
      (row.lastEvent || "?") + ". Capture: " + row.captures.join(", ") + ". While frozen its tool timeouts cannot fire and finished subagents wait " +
      "in the spool. Real-time relay from the stall sentinel's worker thread; nothing was touched; whether to kill or restart is the owner's call. " +
      "One message per stall; " + s.label + " gets one more when it unfreezes. (request 2026-10-07)";
    row.sends = [];
    for (const to of [...new Set(alert.to)]) row.sends.push(await sendOne(to, text));
  } finally { try { await fh.write(JSON.stringify(row) + "\\n"); } catch {} try { await fh.close(); } catch {} }
}
async function fireEnd(ep, endMs) {
  const fh = await claim(dir + "/" + pid + ".alert." + ep + ".end.json"); if (!fh) return;
  const row = { at: isoOf(Date.now()), kind: "stall-end", pid, episode: ep, start: isoOf(ep), end: isoOf(endMs), stallMs: endMs - ep };
  try {
    const s = await sessionOf(); row.label = s.label || null;
    if (!s.label) { row.skipped = "session is not a registered Director/Butler"; return; }
    const tool = await lastToolCall(s.file, ep);
    const text = "[stall-sentinel] " + s.label + ": you were frozen " + row.start + " → " + row.end + ", " + durOf(row.stallMs) +
      " (pid " + pid + ", main thread on-CPU; DIR-example and DIR-wos were told at the 5-min mark). Subagent children that finished meanwhile were " +
      "recovered from the spool, so a late-looking result is the freeze, not the child. Your last tool call before the freeze: " +
      (tool ? tool.name + " " + tool.id + ' "' + tool.head + '"' : "unknown") + ". Capture: " + dir + "/" + pid + ".oncpu.jsonl. " +
      "One message per stall. (request 2026-10-07)";
    row.sends = [await sendOne(s.label, text)];
  } finally { try { await fh.write(JSON.stringify(row) + "\\n"); } catch {} try { await fh.close(); } catch {} }
}
function alertTick(late) {
  if (!alert || !alert.enabled || alertedFor === episode) return;
  const c = cpuOf(); const ticks = c.utime + c.stime;
  if (cpuEp !== episode) { cpuEp = episode; cpu0 = ticks; cpuT0 = Date.now(); return; }
  const span = Date.now() - cpuT0;
  if (late < alert.afterMs || span < alert.minWindow) return;
  const frac = (ticks - cpu0) / alert.hz / (span / 1000);
  if (frac >= alert.cpuFrac) { alertedFor = episode; fireStall(episode, late, frac); }
}
setInterval(() => {
  const late = Date.now() - beat[0];
  if (late < sampleAfter) {
    if (alertedFor && alertedFor === episode && endSentFor !== episode) { endSentFor = episode; fireEnd(episode, beat[0]); }
    episode = beat[0]; if (late < 1000) { rSince = 0; return; } onCpuTick(late); return; }
  if (sampledFor !== episode) { sampledFor = episode; const r = sample(late); r.episode = episode; publish(r); }
  onCpuTick(late);
  alertTick(late);
  if (late >= selfWriteAfter && wroteFor !== episode) { wroteFor = episode; const r = sample(late); r.episode = episode; publish(r); selfWrite(r); }
}, 250);`;

export type Sampler = { beat: Float64Array; meta: Int32Array; out: Uint8Array; worker: any };
export const ONCPU_AFTER_MS = 5000;
export const ONCPU_SECONDS = 3;
export const ONCPU_MIN_GAP_MS = 5 * 60_000;
export const ONCPU_MAX_PER_PROC = 12;
export const ONCPU_ROTATE_BYTES = 1_000_000;
export type OnCpuOpts = { enabled?: boolean; after?: number; seconds?: number; minGap?: number; maxPerProc?: number; perf?: string | null; home?: string; rotateBytes?: number };
function findPerf(): string | null {
  for (const p of ["/usr/bin/perf", "/usr/local/bin/perf", "/bin/perf"]) { try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  return null;
}
/** Start the in-process sampler. The main thread only ever writes the heartbeat (no I/O). */
export const ALERT_AFTER_MS = 5 * 60_000;
export const ALERT_CPU_FRAC = 0.8;
export type AlertOpts = { enabled?: boolean; afterMs?: number; cpuFrac?: number; send?: string; registry?: string; freezeDir?: string; to?: string[] };
export function startSampler(dir: string, opts: { sampleAfter?: number; selfWriteAfter?: number; oncpu?: OnCpuOpts; alert?: AlertOpts } = {}): Sampler | null {
  try {
    const sab = new SharedArrayBuffer(16 + 8192);
    const beat = new Float64Array(sab, 0, 1); beat[0] = Date.now();
    const o = opts.oncpu ?? {};
    const oncpu = { enabled: o.enabled ?? process.env.WOS_STALL_ONCPU !== "0", after: o.after ?? ONCPU_AFTER_MS, seconds: o.seconds ?? ONCPU_SECONDS,
      minGap: o.minGap ?? ONCPU_MIN_GAP_MS, maxPerProc: o.maxPerProc ?? ONCPU_MAX_PER_PROC,
      perf: o.perf === undefined ? findPerf() : o.perf, home: o.home ?? os.homedir(), rotateBytes: o.rotateBytes ?? ONCPU_ROTATE_BYTES };
    const a = opts.alert ?? {}; const home = os.homedir();
    const afterMs = a.afterMs ?? (Number(process.env.WOS_STALL_ALERT_MS) || ALERT_AFTER_MS);
    const alert = { enabled: a.enabled ?? (process.env.WOS_STALL_ALERT !== "0" && !process.env.PI_SUBAGENT_NAME), afterMs,
      minWindow: Math.min(30_000, afterMs / 2), hz: 100, cpuFrac: a.cpuFrac ?? (Number(process.env.WOS_STALL_ALERT_CPU) || ALERT_CPU_FRAC),
      send: a.send ?? (process.env.WOS_STALL_SEND || path.join(home, ".wos-runtime", "wos_send")),
      registry: a.registry ?? (process.env.WOS_STALL_REGISTRY || path.join(home, ".wos-runtime", "director", "om_current.json")),
      freezeDir: a.freezeDir ?? (process.env.WOS_STALL_FREEZE_DIR || path.join(home, ".wos-runtime", "state", "pi-freeze-captures")),
      to: a.to ?? ["DIR-example", "DIR-wos"] };
    const worker = new Worker(SAMPLER_SRC, { eval: true, workerData: {
      sab, tid: process.pid, pid: process.pid, dir, sampleAfter: opts.sampleAfter ?? SAMPLE_AFTER_MS,
      selfWriteAfter: opts.selfWriteAfter ?? SELF_WRITE_AFTER_MS, PATH_ARG, FD_ARG, NAMES: SYSCALL_NAME, oncpu, alert } });
    worker.unref?.();
    worker.on?.("error", () => { /* the sampler is diagnostics only */ });
    return { beat, meta: new Int32Array(sab, 8, 2), out: new Uint8Array(sab, 16), worker };
  } catch { return null; }
}
/** The latest published sample (or null). Pure SharedArrayBuffer read: no I/O. */
export function latestSample(s: Sampler | null): { seq: number; row: any } | null {
  if (!s) return null;
  const seq = Atomics.load(s.meta, 0); if (!seq) return null;
  const len = Atomics.load(s.meta, 1);
  try { return { seq, row: JSON.parse(Buffer.from(s.out.slice(0, len)).toString("utf8")) }; } catch { return null; }
}
/** r4: the sample belongs to THIS stall iff its episode (the heartbeat the worker last saw on time) is the beat this
 *  timer wrote just before the stall, give or take one worker tick (250 ms). Consumption by another reader is irrelevant. */
export function sampleForStall(sample: any, prevBeatEpoch: number, slackMs = 400): any | undefined {
  return sampleForEpisode(sample, prevBeatEpoch, prevBeatEpoch, slackMs);
}
/** r5: the sample belongs to a (possibly multi-leg) stall episode iff its episode lies between the beat before the
 *  FIRST leg (minus one worker tick) and the beat before the LAST leg. */
export function sampleForEpisode(sample: any, firstBeatEpoch: number, lastBeatEpoch: number, slackMs = 400): any | undefined {
  const ep = Number(sample?.episode);
  if (!Number.isFinite(ep) || !ep) return undefined;
  return ep <= lastBeatEpoch + 1 && ep >= firstBeatEpoch - slackMs ? sample : undefined;
}

/** r5: merge a stall leg into the pending episode row (or start one). Pure; exported for tests.
 *  `prevTickWasStall` is true iff the immediately preceding tick also reported a stall (contiguous legs). */
export const TICK_MS = 100;
export function mergeLeg(pending: any | null, leg: { at: string; stallMs: number; beatBefore: number; base: any; sample?: any }): any {
  const ms = Math.round(leg.stallMs);
  if (!pending) {
    const row: any = { ...leg.base, at: leg.at, stallMs: ms, legsMs: [ms], _firstBeat: leg.beatBefore };
    const b = leg.sample ? sampleForEpisode(leg.sample, leg.beatBefore, leg.beatBefore) : undefined;
    if (b) row.blocked = b;
    return row;
  }
  const legsMs = [...pending.legsMs, ms];
  const row: any = { ...pending, ...leg.base, at: leg.at, legsMs, stallMs: legsMs.reduce((a: number, b: number) => a + b, 0) + TICK_MS * (legsMs.length - 1), merged: true };
  if (!pending.blocked) { const b = leg.sample ? sampleForEpisode(leg.sample, pending._firstBeat, leg.beatBefore) : undefined; if (b) row.blocked = b; else delete row.blocked; }
  else row.blocked = pending.blocked;
  return row;
}
export function finalRow(pending: any): any { const { _firstBeat, ...row } = pending; if (row.legsMs?.length === 1) delete row.legsMs; return row; }

/** r5: external heartbeat. 64 bytes: 0 "WHB1" | 4 int32 pid | 8 f64 beat epoch ms | 16 f64 gen | 24 int32 child | 32 f64 load epoch ms.
 *  Returns the beat view (Float64Array of length 1 over offset 8) or null. All I/O happens here, at load, never in the timer. */
export const HB_BYTES = 64;
export function startHeartbeat(dir: string, gen: number, child: boolean): { beat: Float64Array; file: string } | null {
  try {
    const B: any = (globalThis as any).Bun;
    if (!B || typeof B.mmap !== "function") return null;
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
    const ds = fs.lstatSync(dir);
    if (!ds.isDirectory() || ds.uid !== process.getuid!() || (ds.mode & 0o077)) return null;   // our private dir only
    const file = path.join(dir, `${process.pid}.hb`);
    const fd = fs.openSync(file, C.O_RDWR | C.O_CREAT | C.O_NOFOLLOW | C.O_NONBLOCK, 0o600);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid!()) return null;
      const hdr = Buffer.alloc(HB_BYTES);
      hdr.write("WHB1", 0, "latin1"); hdr.writeInt32LE(process.pid, 4); hdr.writeDoubleLE(Date.now(), 8);
      hdr.writeDoubleLE(gen, 16); hdr.writeInt32LE(child ? 1 : 0, 24); hdr.writeDoubleLE(Date.now(), 32);
      fs.ftruncateSync(fd, HB_BYTES); fs.writeSync(fd, hdr, 0, HB_BYTES, 0);
    } finally { fs.closeSync(fd); }
    const m: Uint8Array = B.mmap(file);
    if (!m || m.byteLength < HB_BYTES) return null;
    return { beat: new Float64Array(m.buffer, m.byteOffset + 8, 1), file };
  } catch { return null; }
}

/** Opt-in JS-level sampler (JSC sampling profiler, main thread). Drained every 2 s; summarised after a long stall. */
export function summariseJsTraces(dump: any, k = 15): { traces: number; topStacks: { n: number; s: string }[]; topLeaf: { n: number; s: string }[] } {
  const traces: any[] = Array.isArray(dump?.traces) ? dump.traces : [];
  const fr = (f: any) => `${String(f?.name || "(anon)").slice(0, 80)}@${String(f?.sourceURL || f?.category || "?").split("/").slice(-2).join("/")}${Number(f?.line) >= 0 && Number(f?.line) < 1e9 ? ":" + f.line : ""}`;
  const st = new Map<string, number>(), lf = new Map<string, number>();
  for (const t of traces) {
    const frames: any[] = Array.isArray(t?.frames) ? t.frames : []; if (!frames.length) continue;
    const key = frames.slice(0, 16).map(fr).join(" <- "); st.set(key, (st.get(key) || 0) + 1);
    const l = fr(frames[0]); lf.set(l, (lf.get(l) || 0) + 1);
  }
  const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([s, c]) => ({ n: c, s }));
  return { traces: traces.length, topStacks: top(st, k), topLeaf: top(lf, 20) };
}

export default function (pi: any) {
  if (process.env.WOS_STALL_SENTINEL === "0") return;
  const STALL_MS = Number(process.env.WOS_STALL_MS || 1000);
  const dir = process.env.WOS_STALL_DIR || path.join(os.homedir(), ".wos-runtime", "state", "pi-loop-stalls");
  const writer = createStallWriter(path.join(dir, `${process.pid}.jsonl`), dir);
  const g: any = globalThis as any;
  // r4 (1a): one live generation per process. The previous instance's timer is cleared here AND retires itself on its
  // next tick if it is still scheduled (a handle that was never cleared cannot keep a second writer alive).
  const gen = (g.__wosStallGen = (Number(g.__wosStallGen) || 0) + 1);
  if (g.__wosStallSentinel) clearInterval(g.__wosStallSentinel); // one per process across /reload
  const live = () => g.__wosStallGen === gen;
  const recent: string[] = [];
  let sessionId = "";
  const child = process.env.PI_SUBAGENT_NAME || undefined;
  let post: (m: any) => void = () => undefined;                          // fix 3: context for the worker's relay (no I/O)
  const note = (ev: string) => { if (!live()) return; const e = `${new Date().toISOString().slice(11, 23)} ${ev}`; recent.push(e); if (recent.length > 12) recent.shift(); post({ ev: e }); };
  for (const ev of ["input", "before_agent_start", "agent_start", "turn_start", "turn_end", "tool_call", "tool_result", "agent_end", "agent_settled", "session_compact"])
    pi.on(ev, () => { note(ev); return undefined; });
  let sessionFile = "";
  pi.on("session_start", (_e: any, ctx: any) => { try { sessionId = String(ctx.sessionManager.getSessionId() ?? ""); } catch { /* */ }
    try { sessionFile = String(ctx.sessionManager.getSessionFile?.() ?? ""); } catch { /* */ }
    post({ ctx: { sessionId, sessionFile } }); note("session_start"); });
  if (g.__wosStallSampler) { try { g.__wosStallSampler.worker.terminate(); } catch { /* */ } g.__wosStallSampler = null; }
  const sampler: Sampler | null = process.env.WOS_STALL_SAMPLER === "0" ? null : startSampler(dir);
  g.__wosStallSampler = sampler;
  if (sampler?.worker?.postMessage) post = (m: any) => { try { sampler.worker.postMessage(m); } catch { /* diagnostics only */ } };
  // opt-in JS sampler
  let js: { drain: () => any } | null = null;
  let jsOn = process.env.WOS_STALL_JSPROF === "1";
  if (!jsOn && process.env.WOS_STALL_JSPROF !== "0") { try { jsOn = fs.existsSync(path.join(dir, "jsprof.on")); } catch { /* */ } }
  if (jsOn) {
    import("bun:jsc" as any).then((m: any) => {
      if (!live() || typeof m?.startSamplingProfiler !== "function") return;
      if (!g.__wosStallJsStarted) { m.startSamplingProfiler(); g.__wosStallJsStarted = true; }
      js = { drain: () => m.samplingProfilerStackTraces() };
    }).catch(() => { /* not Bun */ });
  }
  const jsWriter = createStallWriter(path.join(dir, `${process.pid}.oncpu.jsonl`), dir);
  // r5 (3): external heartbeat for pi_freeze_watcher.py (one mapping per process, reused across /reload).
  const hbMode = process.env.WOS_STALL_HB || "1";
  if (hbMode !== "0" && (!child || hbMode === "all") && !g.__wosStallHb) {
    g.__wosStallHb = startHeartbeat(process.env.WOS_STALL_HB_DIR || "/dev/shm/wos-pi-hb", gen, !!child);
    const hbFile = g.__wosStallHb?.file;
    if (hbFile) process.once("exit", () => { try { fs.unlinkSync(hbFile); } catch { /* */ } });
  }
  const hb: { beat: Float64Array } | null = g.__wosStallHb || null;
  let lastJsDrain = Date.now();
  let last = performance.now();
  let prevBeat = Date.now();
  let pending: any = null;                                                 // r5 (1): the open stall episode
  const flush = () => { if (pending) { const p = pending; pending = null; writer.enqueue(finalRow(p)); } };
  g.__wosStallFlush?.(); g.__wosStallFlush = flush;                        // a /reload writes the old instance's open row
  pi.on("session_shutdown", () => { flush(); return undefined; });
  let prevEnd = performance.now();                                         // when the previous tick callback RETURNED
  const tick = () => {
    const nowEpoch = Date.now();
    if (sampler) sampler.beat[0] = nowEpoch;
    if (hb) hb.beat[0] = nowEpoch;
    const now = performance.now(); const stall = now - last - 100; last = now;
    const between = now - prevEnd;                                         // loop time spent OUTSIDE our previous callback
    const beatBefore = prevBeat; prevBeat = nowEpoch;
    if (js && (stall >= ONCPU_AFTER_MS || nowEpoch - lastJsDrain >= 2000)) {
      let dump: any = null; try { dump = js.drain(); } catch { /* */ }
      lastJsDrain = nowEpoch;
      if (stall >= ONCPU_AFTER_MS && dump) jsWriter.enqueue({ at: new Date().toISOString(), kind: "js", pid: process.pid, stallMs: Math.round(stall), sessionId, ...(child ? { child } : {}), js: summariseJsTraces(dump) });
    }
    if (stall < STALL_MS) { flush(); return; }                            // first on-time tick closes the episode
    // r5 (1): merge only the frozen-callback split: this leg's time was spent INSIDE our previous callback (the
    // process froze mid-tick), not elsewhere in the loop. Two genuinely separate stalls one tick apart stay two rows.
    if (pending && between >= STALL_MS) flush();
    const s = latestSample(sampler);
    pending = mergeLeg(pending, { at: new Date().toISOString(), stallMs: stall, beatBefore, sample: s?.row,
      base: { sessionId, gen, ...(child ? { child } : {}), heapMB: Math.round(process.memoryUsage().heapUsed / 1e6), recent: [...recent], dropped: writer.state.dropped } });
  };
  const handle = setInterval(() => {
    if (!live()) { flush(); clearInterval(handle); return; }              // r4 (1a): a stale instance retires itself
    try { tick(); } finally { prevEnd = performance.now(); }
  }, 100);
  g.__wosStallSentinel = handle;
  handle.unref?.();
}
