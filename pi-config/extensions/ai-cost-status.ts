// WOS footer: cwd, usage/model, and ONE calm status line (state + exceptions; request 2026-09-27).
// Daily cost: canonical collectors ~/.wos-runtime/ai_cost_lib.py, via ai_cost_today.py.
// Kill switches: touch ~/.wos-runtime/ai-cost-status.off (cost) · ~/.wos-runtime/statusline-sources.off (🙋/⏰/⚠ sources)
// @ts-nocheck

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const WDB = path.join(os.homedir(), ".wos-runtime");
// request 2026-09-28: Bun's spawn chdir()s into the child's cwd INSIDE the vfork child, while the
// Pi main thread is suspended in vfork() until exec. With the default cwd (the Pi's own cwd = the wisdom-os mount) a
// slow FUSE lookup froze the whole Pi for up to 57 s (45 stalls / 1753 s fleet-wide on 2026-09-28, the largest
// stall class; strace proof in the staging evidence). These timers spawn every 15 s / 60 s / 2 min even while the
// Director is idle. Both scripts take absolute paths and never read their cwd, so they run from local $HOME.
export const SPAWN_CWD = os.homedir();
const PRODUCER = path.join(WDB, "ai_cost_today.py");
const OFF = path.join(WDB, "ai-cost-status.off");
const REFRESH_MS = 2 * 60 * 1000;
const STATUS_ID = "daily-ai-cost";

function disabled(): boolean {
  try {
    return fs.existsSync(OFF) || /^(1|true|on|off)$/i.test(process.env.PI_AI_COST_STATUS_DISABLED ?? "");
  } catch {
    return false;
  }
}

// Shared cache (2026-09-25): the producer scans every transcript of the UTC day and grew past the
// old 20 s timeout, so every session showed "$— (today)" while each one re-ran a ~23 s scan every
// 2 min. Now ONE producer run at a time (lock) writes a shared cache atomically; every session reads it.
const STATE = path.join(WDB, "state");
const CACHE = path.join(STATE, "ai_cost_today.json");
const LOCK = path.join(STATE, "ai_cost_today.lock");
const PRODUCER_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 150_000;
const STALE_SHOW_MS = 10 * 60 * 1000;

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function readCache(): { snap: any; at: number } | null {
  try {
    const st = fs.statSync(CACHE);
    const snap = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    if (!snap || snap.date !== utcToday()) return null; // yesterday's numbers are not "today"
    return { snap, at: st.mtimeMs };
  } catch {
    return null;
  }
}

function tryLock(retry = true): boolean {
  try {
    fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(LOCK, "wx", 0o600);
    fs.writeSync(fd, `${process.pid} ${Date.now()}\n`);
    fs.closeSync(fd);
    return true;
  } catch {
    try {
      if (retry && Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) {
        fs.unlinkSync(LOCK); // abandoned by a crashed holder
        return tryLock(false);
      }
    } catch {
      // lock vanished between calls; next refresh tries again
    }
    return false;
  }
}

function releaseLock(): void {
  try {
    if (fs.readFileSync(LOCK, "utf8").startsWith(`${process.pid} `)) fs.unlinkSync(LOCK);
  } catch {
    // not ours or already gone
  }
}

function runProducer(): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/python3", [PRODUCER, "--no-cache"], { cwd: SPAWN_CWD, timeout: PRODUCER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const snap = JSON.parse(stdout);
        const tmp = `${CACHE}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
        fs.renameSync(tmp, CACHE);
        resolve(snap);
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

// ── status line composer v2 (request 2026-09-27; v1 = request 2026-09-26) ─────────────
// Calm: STATE + EXCEPTIONS, never green lights (the owner 2026-09-27, "design a statusline suitable for us").
//   normal     DIR-wos │ $936 today │ ctx 270k ▕███░▏ │ ⚙3
//   exceptions appended only while true, coloured, never dropped (collapse to a short form when even they do not fit):
//              🙋N need you · ⏰N · ⚠ cache NN% · ❄ froze Ns·Mm ago · cur ✗/? (named) · guard ✗ · lease …
// Dropped for good: `$ sess`, `pi/cl/cx` share, `om $` (the owner is Pi-only), `guard ✓`, `cur ✓/–`. mem O/C bars only near a
// fold (≥80%). Context and the compaction target are ONE bar. Narrow width: lowest priority dropped first.
// 🔴 The render path does NO file or process I/O: every source below is refreshed async on a ≥15 s timer into memory,
// render() only reads memory (plus O(1) process-global reads). Pure + exported so it is snapshot-tested.
export const KEY_OM = "om";
export const KEY_OM_COST = "om-cost";
export const KEY_OM_CURATOR = "om-curator";
export const KEY_COMPACTION = "compaction";
export const KEY_GATE = "wos-data-policy-guard";
export const KEY_LEASE = "wos-session-lease";
const KNOWN_KEYS = new Set([KEY_OM, KEY_OM_COST, KEY_OM_CURATOR, KEY_COMPACTION, KEY_GATE, KEY_LEASE, STATUS_ID]);
export const PRIO = { alert: 100, identity: 80, ctx: 70, mem: 65, todayCost: 60, children: 50, other: 40 } as const;
const GATE_RE = /^data-policy-gate (\S+) ([0-9a-f]{8})\b/;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const GATE_MISSING_GRACE_MS = 15_000;
export const MEM_NEAR_FOLD = 0.8;
export const STALL_SHOW_MIN_MS = 5_000;
export const STALL_SHOW_FOR_MS = 10 * 60_000;
export const CTX_WARN_FRAC = 0.9;
const CTX_CELLS = 4;
export const OM_GAUGES_GLOBAL = Symbol.for("pi-om/footer-gauges");
export const RUNNING_CHILDREN_GLOBAL = Symbol.for("pi-subagents/running-children-count");

export function usd(value: number): string {
  const v = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (v < 10) return `$${v.toFixed(2)}`;
  if (v < 1000) return `$${Math.round(v)}`;
  return `$${(v / 1000).toFixed(v < 9950 ? 1 : 0)}k`;
}

/**
 * Curator status needs attention: a failure (✗), a question (?) or a stalled curator (`lag`). Since OM
 * request 2026-09-27 the NAMED form appears only for ✗/?; an older OM still names mere divergences, so the
 * names alone are no longer an alert.
 */
export function curatorIsAlert(text: string): boolean {
  return /✗|\?|\blag\b/.test(text);
}

export function plain(text: string): string {
  return String(text ?? "").replace(ANSI_RE, "");
}

/**
 * The data-policy guard reports the sha of the bytes THIS process loaded (`data-policy-gate <round> <sha8>`). It only matters when
 * those bytes differ from the file on disk (a governed install landed and this session has not /reload-ed).
 * `diskSha8`: string = probed, null = unreadable, undefined = not probed yet (quiet — never alarm on "unknown").
 * OK → `{ alert:false }` (the composer hides it); anything else → `guard ✗ …`, an alert.
 */
export function gateSegment(
  raw: string | undefined, diskSha8: string | null | undefined, missingIsAbnormal: boolean,
): { text: string; alert: boolean } | null {
  if (raw === undefined) return missingIsAbnormal ? { text: "guard ✗ not loaded", alert: true } : null;
  const text = plain(raw).trim();
  if (/^guard ✓/.test(text)) return { text: "guard ✓", alert: false }; // forward-compatible with a self-checking guard
  const m = GATE_RE.exec(text);
  if (!m) return { text: `guard ✗ ${text || "?"}`, alert: true };
  const [, round, sha8] = m;
  if (diskSha8 === undefined || diskSha8 === sha8) return { text: "guard ✓", alert: false };
  if (diskSha8 === null) return { text: `guard ✗ ${round} disk?`, alert: true };
  return { text: `guard ✗ ${round} stale /reload`, alert: true };
}

/** `48s` below 90 s, else `3m`. */
export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

export function tokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

/** Compaction target from the `compaction` status (`cmp:short 270k`); null = Pi native (long/off) → model window. */
export function compactionTarget(raw: string | undefined): number | null {
  const m = /cmp:short (\d+(?:\.\d+)?)([kM])/.exec(plain(raw ?? ""));
  if (!m) return null;
  return Number(m[1]) * (m[2] === "M" ? 1_000_000 : 1_000);
}

export interface Sources {
  /** Director label bound to this session (null = ordinary session). */
  me?: string | null;
  /** This Director's director_brief "need the owner" count. */
  owner?: number | null;
  /** Overdue children (record-level overdue-sweep rule). */
  overdue?: number | null;
  /** Set only while this session is below the health-audit cache floor. */
  cache?: { hit: number | null; n?: number | null } | null;
}

export interface ComposeInput {
  width: number;
  theme: { fg(color: string, text: string): string };
  tw: { truncateToWidth(text: string, width: number, ellipsis?: string): string; visibleWidth(text: string): number };
  /** `null` = producer has no value yet. */
  today: { totalUsd: number; ageMin?: number } | null;
  statuses: Array<[string, string]>;
  gateDiskSha8: string | null | undefined;
  gateMissingIsAbnormal: boolean;
  /** Shown first; null/empty = no identity segment. */
  identity?: string | null;
  /** Context tokens in use (null = unknown, e.g. right after compaction) and the model window. */
  context?: { tokens: number | null; window: number } | null;
  /** Running children of this session (pi-interactive-subagents' own in-memory count). */
  children?: number | null;
  sources?: Sources | null;
  /** Latest main-thread stall of THIS process: its length and how long ago it ended. */
  stall?: { ms: number; agoMs: number } | null;
  /** OM's live gauges (process-global published by OM's StatusController). */
  omGauges?: { nextValue: number; nextMax: number; poolValue: number; poolMax: number } | null;
}

/** `short`: the compact indicator an alert collapses to when even alerts-only does not fit (never dropped). */
interface Seg { text: string; prio: number; short?: string }

function bar(frac: number, cells: number): string {
  const f = Math.min(cells, Math.max(0, Math.round(Math.min(1, frac) * cells)));
  return `▕${"█".repeat(f)}${"░".repeat(cells - f)}▏`;
}

function memNearFold(input: ComposeInput, omText: string): boolean {
  const g = input.omGauges;
  if (g) {
    const fr = (v: number, m: number) => (m > 0 ? v / m : 0);
    return Math.max(fr(g.nextValue, g.nextMax), fr(g.poolValue, g.poolMax)) >= MEM_NEAR_FOLD;
  }
  // Older OM without the global: 4 of 5 cells filled (≈ ≥70%) is the best the bar text can resolve.
  return plain(omText).split("▕").slice(1).some((cell) => (cell.match(/█/g) ?? []).length >= 4);
}

export function composeStatusLine(input: ComposeInput): string {
  const { theme, tw, width } = input;
  const dim = (t: string) => theme.fg("dim", t);
  const warn = (t: string) => theme.fg("warning", t);
  const err = (t: string) => theme.fg("error", t);
  const status = new Map(input.statuses);
  const src = input.sources ?? {};

  // ── state ──
  const identity: Seg[] = input.identity ? [{ text: theme.fg("accent", input.identity), prio: PRIO.identity }] : [];
  const cost: Seg[] = [];
  if (input.today) {
    const stale = input.today.ageMin !== undefined ? warn(` ${input.today.ageMin}m old`) : "";
    cost.push({ text: dim(`${usd(input.today.totalUsd)} today`) + stale, prio: PRIO.todayCost });
  } else {
    cost.push({ text: dim("$— today"), prio: PRIO.todayCost });
  }
  const ctxSeg: Seg[] = [];
  const window = Number(input.context?.window ?? 0);
  const target = compactionTarget(status.get(KEY_COMPACTION)) ?? (window > 0 ? window : null);
  if (target) {
    const tokens = input.context?.tokens;
    const frac = tokens != null && Number.isFinite(tokens) ? tokens / target : 0;
    const paint = frac >= CTX_WARN_FRAC ? warn : dim;
    ctxSeg.push({ text: dim(`ctx ${tokenCount(target)} `) + paint(bar(frac, CTX_CELLS)), prio: PRIO.ctx });
  }
  const mem: Seg[] = [];
  const om = status.get(KEY_OM);
  if (om && memNearFold(input, om)) mem.push({ text: om, prio: PRIO.mem });
  const kids: Seg[] = (input.children ?? 0) > 0 ? [{ text: dim(`⚙${input.children}`), prio: PRIO.children }] : [];
  const others: Seg[] = [];
  for (const [key, value] of input.statuses) {
    if (KNOWN_KEYS.has(key) || !plain(value).trim()) continue;
    others.push({ text: value, prio: PRIO.other });
  }

  // ── exceptions (appended, in the owner's order) ──
  const alerts: Seg[] = [];
  const A = (text: string, short: string) => alerts.push({ text, prio: PRIO.alert, short });
  if ((src.owner ?? 0) > 0) A(warn(`🙋${src.owner} need you`), warn(`🙋${src.owner}`));
  if ((src.overdue ?? 0) > 0) A(warn(`⏰${src.overdue}`), warn(`⏰${src.overdue}`));
  if (src.cache) {
    const pct = src.cache.hit != null ? `${Math.round(src.cache.hit * 100)}%` : "low";
    A(warn(`⚠ cache ${pct}`), warn("⚠c"));
  }
  const st = input.stall;
  if (st && st.ms >= STALL_SHOW_MIN_MS && st.agoMs >= 0 && st.agoMs <= STALL_SHOW_FOR_MS) {
    const ago = st.agoMs < 60_000 ? "<1m" : `${Math.floor(st.agoMs / 60_000)}m`;
    A(warn(`❄ froze ${dur(st.ms)}·${ago} ago`), warn(`❄${dur(st.ms)}`));
  }
  const cur = status.get(KEY_OM_CURATOR);
  const curPlain = cur ? plain(cur).trim() : "";
  if (curPlain && curatorIsAlert(curPlain)) {
    const failed = /✗/.test(curPlain);
    const paint = failed ? err : warn;
    A(paint(curPlain), paint(failed ? "cur✗" : /\?/.test(curPlain) ? "cur?" : "cur lag"));
  }
  const gate = gateSegment(status.get(KEY_GATE), input.gateDiskSha8, input.gateMissingIsAbnormal);
  if (gate?.alert) A(err(gate.text), err("guard✗"));
  const lease = status.get(KEY_LEASE);
  if (lease !== undefined && plain(lease).trim()) {
    const t = plain(lease).trim();
    A(warn(/^lease\b/.test(t) ? t : `lease ${t}`), warn("lease⚠"));
  }

  // [segments, joiner-inside-group]
  const groups: Array<[Seg[], string]> = [
    [identity, ""], [cost, ""], [ctxSeg, ""], [mem, ""], [kids, ""], [others, " "], [alerts, dim(" · ")],
  ];
  const render = (): string =>
    groups
      .map(([segs, join]) => segs.map((s) => s.text).join(join))
      .filter((g) => g.length > 0)
      .join(dim(" │ "));
  let line = render();
  const dropped: Array<{ g: Seg[]; seg: Seg; order: number }> = [];
  const orderOf = new Map<Seg, number>();
  let n = 0;
  for (const [segs] of groups) for (const seg of segs) orderOf.set(seg, n++);
  let compacted = false;
  while (tw.visibleWidth(line) > width) {
    let victim: { g: Seg[]; i: number; prio: number } | null = null;
    for (const [segs] of groups) {
      segs.forEach((s, i) => {
        if (s.prio >= PRIO.alert) return;
        if (!victim || s.prio <= victim.prio) victim = { g: segs, i, prio: s.prio };
      });
    }
    if (!victim) {
      // Only alerts are left and they still do not fit: collapse them to their short indicators, rightmost first,
      // one at a time, so every active alert keeps at least an indicator.
      const full = [...alerts].reverse().find((a) => a.short && a.text !== a.short);
      if (!full) break;
      full.text = full.short!;
      compacted = true;
      line = render();
      continue;
    }
    const v = victim as { g: Seg[]; i: number };
    dropped.push({ g: v.g, seg: v.g[v.i], order: orderOf.get(v.g[v.i])! });
    v.g.splice(v.i, 1);
    line = render();
  }
  // Collapsing alerts can free room: put back dropped segments, highest priority first, wherever they still fit.
  if (compacted) {
    for (const d of [...dropped].sort((a, b) => b.seg.prio - a.seg.prio || a.order - b.order)) {
      const at = d.g.findIndex((s) => (orderOf.get(s) ?? 0) > d.order);
      d.g.splice(at < 0 ? d.g.length : at, 0, d.seg);
      const next = render();
      if (tw.visibleWidth(next) <= width) line = next;
      else d.g.splice(d.g.indexOf(d.seg), 1);
    }
    line = render();
  }
  return tw.truncateToWidth(line, width, "");
}

// ── async sources (NEVER called from render) ──────────────────────────────────────────────────────────────────────
// data-policy guard file as Pi loads it (symlink followed by stat/read): re-hashed only when (ino, size, mtime) changed.
const GATE_FILE = path.join(os.homedir(), ".pi", "agent", "extensions", "wos-data-policy-guard.ts");
let gateProbe: { key: string; sha8: string | null | undefined } = { key: "", sha8: undefined };
export async function probeGateDiskSha8(file = GATE_FILE): Promise<string | null> {
  try {
    const st = await fs.promises.stat(file);
    const key = `${file}:${st.ino}:${st.size}:${st.mtimeMs}`;
    if (key !== gateProbe.key) {
      const sha8 = createHash("sha256").update(await fs.promises.readFile(file)).digest("hex").slice(0, 8);
      gateProbe = { key, sha8 };
    }
  } catch {
    gateProbe = { key: "", sha8: null };
  }
  return gateProbe.sha8 as string | null;
}
/** Memory read for render: undefined until the first async probe lands. */
export function gateDiskSha8(): string | null | undefined {
  return gateProbe.sha8;
}
export function _resetGateProbe(): void {
  gateProbe = { key: "", sha8: undefined };
}

// Main-thread stalls of THIS process, recorded by wos-loop-stall-sentinel.ts. Only the file's tail is read.
const STALL_DIR = path.join(WDB, "state", "pi-loop-stalls");
export async function readLastStall(file = path.join(STALL_DIR, `${process.pid}.jsonl`)): Promise<{ ms: number; endedAt: number } | null> {
  let fh: any;
  try {
    fh = await fs.promises.open(file, "r");
    const { size } = await fh.stat();
    const len = Math.min(size, 16_384);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i]);
        const at = Date.parse(row.at);
        const ms = Number(row.stallMs);
        if (Number.isFinite(at) && Number.isFinite(ms)) return { ms, endedAt: at };
      } catch {
        // first line of the tail window may be partial
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close?.().catch?.(() => {});
  }
}

// Director label / need-the owner / overdue / cache floor: one short python run, off the render path.
const SOURCES_SCRIPT = path.join(WDB, "harness", "statusline_sources.py");
const SOURCES_OFF = path.join(WDB, "statusline-sources.off");
export const SOURCES_REFRESH_MS = 60_000;
export const FAST_REFRESH_MS = 15_000;
export function runSources(sessionId: string, artifactDir: string, script = SOURCES_SCRIPT): Promise<Sources | null> {
  return new Promise((resolve) => {
    fs.promises.access(SOURCES_OFF).then(() => resolve(null), () => {
      execFile("/usr/bin/python3", [script, "--session", sessionId, "--artifact-dir", artifactDir],
        { cwd: SPAWN_CWD, timeout: 30_000, maxBuffer: 256 * 1024 }, (e, stdout) => {
          if (e) return resolve(null);
          try { resolve(JSON.parse(String(stdout).trim().split("\n").pop() || "null")); } catch { resolve(null); }
        });
    });
  });
}

// request 2026-09-27 F1: the footer renders on EVERY TUI frame (spinner ~12 fps while a tool
// runs, every keystroke, every streamed token). The old sessionStats() walked the whole branch per frame and
// ctx.getContextUsage() rebuilt the full session projection per frame: ~35 ms/frame at a 30k-entry (200 MB)
// transcript, i.e. ~45% of the main thread during an active turn. Both are now incremental / memoized on the
// session leaf, which is O(1) to read: a frame on an unchanged leaf costs nothing; a new leaf costs O(new entries).
type Totals = { cost: number; input: number; output: number; cacheRead: number; cacheHit: number };
type StatsMemo = { sm: any; leaf: string | null; totals: Totals; latest: any; latestId: string | null };
let statsMemo: StatsMemo | null = null;
export let statsFullScans = 0; // test/diagnostic counter
function addUsage(t: Totals, usage: any): void {
  t.cost += Number(usage.cost?.total ?? 0);
  t.input += Number(usage.input ?? 0);
  t.output += Number(usage.output ?? 0);
  t.cacheRead += Number(usage.cacheRead ?? 0);
}
function withHit(t: Totals, latest: any): Totals {
  const out = { ...t, cacheHit: 0 };
  if (latest) {
    const cache = Number(latest.cacheRead ?? 0);
    const prompt = cache + Number(latest.input ?? 0) + Number(latest.cacheWrite ?? 0);
    out.cacheHit = prompt > 0 ? (cache / prompt) * 100 : 0;
  }
  return out;
}
const isAssistant = (e: any) => e?.type === "message" && e.message?.role === "assistant";
function fullStats(sm: any): StatsMemo {
  statsFullScans++;
  const totals: Totals = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheHit: 0 };
  let latest: any = null; let latestId: string | null = null;
  for (const entry of sm.getBranch()) {
    if (isAssistant(entry)) { addUsage(totals, entry.message.usage ?? {}); latest = entry.message.usage ?? {}; latestId = entry.id; }
  }
  return { sm, leaf: sm.getLeafId?.() ?? null, totals, latest, latestId };
}
export function sessionStats(ctx: any): Totals {
  const sm = ctx.sessionManager;
  const leaf: string | null = sm.getLeafId?.() ?? null;
  if (!statsMemo || statsMemo.sm !== sm || typeof sm.getEntry !== "function") statsMemo = fullStats(sm);
  else if (statsMemo.leaf !== leaf) {
    // Walk back from the new leaf to the memoized leaf: O(new entries). A leaf that is not a descendant of the
    // memoized one (tree navigation, fork, rewind) falls back to one full scan.
    const fresh: any[] = [];
    let cur = leaf ? sm.getEntry(leaf) : undefined;
    let found = statsMemo.leaf === null;
    while (cur) {
      if (cur.id === statsMemo.leaf) { found = true; break; }
      fresh.push(cur);
      if (fresh.length > 5000) break;
      cur = cur.parentId ? sm.getEntry(cur.parentId) : undefined;
    }
    if (!found) statsMemo = fullStats(sm);
    else {
      const t = { ...statsMemo.totals };
      let latest = statsMemo.latest; let latestId = statsMemo.latestId;
      for (let i = fresh.length - 1; i >= 0; i--) {
        const e = fresh[i];
        if (isAssistant(e)) { addUsage(t, e.message.usage ?? {}); latest = e.message.usage ?? {}; latestId = e.id; }
      }
      statsMemo = { sm, leaf, totals: t, latest, latestId };
    }
  }
  return withHit(statsMemo.totals, statsMemo.latest);
}
export function _resetStatsMemo(): void { statsMemo = null; statsFullScans = 0; }

// ctx.getContextUsage() is O(session) in Pi core (buildSessionProjection + getBranch per call). Its value is a
// pure function of the session tree at the current leaf and the model's window, so memoize on those.
let usageMemo: { sm: any; leaf: string | null; window: number; model: string; value: any } | null = null;
export function contextUsage(ctx: any): any {
  const sm = ctx.sessionManager;
  const leaf: string | null = sm?.getLeafId?.() ?? null;
  const window = Number(ctx.model?.contextWindow ?? 0);
  const model = `${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`;
  if (usageMemo && usageMemo.sm === sm && usageMemo.leaf === leaf && usageMemo.window === window && usageMemo.model === model) return usageMemo.value;
  const value = ctx.getContextUsage?.();
  usageMemo = { sm, leaf, window, model, value };
  return value;
}
export function _resetUsageMemo(): void { usageMemo = null; }

export default function (pi: any) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let fastTimer: ReturnType<typeof setInterval> | undefined;
  let sourcesTimer: ReturnType<typeof setInterval> | undefined;
  let sources: Sources | null = null;
  let stall: { ms: number; endedAt: number } | null = null;
  let identityFallback: string | null = null;
  let refreshing = false;
  let lastRefresh = 0;
  let snapshot: any = null;
  let snapshotAt = 0;
  let requestRender: (() => void) | undefined;

  async function refresh(ctx: any, force = false): Promise<void> {
    if (disabled()) {
      snapshot = null;
      requestRender?.();
      return;
    }
    const cached = readCache();
    if (cached) {
      snapshot = cached.snap;
      snapshotAt = cached.at;
      requestRender?.();
    }
    if (refreshing || (!force && Date.now() - lastRefresh < REFRESH_MS)) return;
    if (cached && !force && Date.now() - cached.at < REFRESH_MS) return; // fresh enough: just read
    if (!tryLock()) return; // another session is producing; its result lands in the cache
    refreshing = true;
    try {
      snapshot = await runProducer();
      snapshotAt = Date.now();
      lastRefresh = Date.now();
      requestRender?.();
    } catch {
      // Keep the last good value. Cost visibility must not break the TUI.
    } finally {
      releaseLock();
      refreshing = false;
    }
  }

  // All footer sources live in memory; these timers are the only place they are (re)read. Each tick is async and
  // failure-tolerant: a broken source renders as nothing, never as an error or a stale alarm.
  async function refreshFast(): Promise<void> {
    const before = `${gateDiskSha8()}|${stall?.endedAt}`;
    await probeGateDiskSha8();
    stall = await readLastStall();
    if (`${gateDiskSha8()}|${stall?.endedAt}` !== before) requestRender?.();
  }
  let sourcesBusy = false;
  async function refreshSources(ctx: any): Promise<void> {
    if (sourcesBusy) return;
    sourcesBusy = true;
    try {
      const sm = ctx.sessionManager;
      const sid = String(sm?.getSessionId?.() ?? "");
      const dir = sm?.getSessionDir?.();
      if (!sid) return;
      const next = await runSources(sid, dir ? path.join(dir, "artifacts", sid) : "");
      if (JSON.stringify(next) !== JSON.stringify(sources)) { sources = next; requestRender?.(); }
    } finally {
      sourcesBusy = false;
    }
  }

  pi.on("session_start", (_event: any, ctx: any) => {
    if (ctx.mode !== "tui") return;
    // A launched subagent is named by its launcher; honour the name only for the exact session it was launched for
    // (a Pi started from another agent's bash tool inherits that agent's env).
    try {
      const f = String(ctx.sessionManager?.getSessionFile?.() ?? "");
      identityFallback = f && process.env.PI_SUBAGENT_SESSION === f ? (process.env.PI_SUBAGENT_NAME || null) : null;
    } catch {
      identityFallback = null;
    }
    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      const bornAt = Date.now();
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(requestRender);
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          const ageMs = snapshot ? Date.now() - snapshotAt : 0;
          const stats = sessionStats(ctx);
          const context = contextUsage(ctx);
          const contextMax = Number(ctx.model?.contextWindow ?? 0);
          const contextPct = context && contextMax > 0
            ? `${((context.tokens / contextMax) * 100).toFixed(1)}%/${tokenCount(contextMax)} (auto)`
            : "";
          const align = (left: string, right: string): string => {
            const keptRight = truncateToWidth(right, width, "");
            const leftWidth = Math.max(0, width - visibleWidth(keptRight) - 1);
            const keptLeft = truncateToWidth(left, leftWidth, "");
            const pad = " ".repeat(Math.max(1, width - visibleWidth(keptLeft) - visibleWidth(keptRight)));
            return truncateToWidth(keptLeft + pad + keptRight, width, "");
          };
          const usage = theme.fg(
            "dim",
            `↑${tokenCount(stats.input)} ↓${tokenCount(stats.output)} R${tokenCount(stats.cacheRead)} ` +
            `CH${stats.cacheHit.toFixed(1)}%`,
          );
          const model = theme.fg(
            "dim",
            `${contextPct}${contextPct ? "  " : ""}(${ctx.model?.provider ?? "no-provider"}) ` +
            `${ctx.model?.id ?? "no-model"} • ${ctx.thinkingLevel}`,
          );
          const now = Date.now();
          let children: number | null = null;
          try {
            const count = (globalThis as any)[RUNNING_CHILDREN_GLOBAL];
            children = typeof count === "function" ? Number(count()) || 0 : null;
          } catch {
            children = null;
          }
          const statusLine = composeStatusLine({
            width,
            theme,
            tw: { truncateToWidth, visibleWidth },
            today: snapshot
              ? { totalUsd: Number(snapshot.total_usd), ageMin: ageMs > STALE_SHOW_MS ? Math.round(ageMs / 60000) : undefined }
              : null,
            statuses: [...footerData.getExtensionStatuses().entries()],
            gateDiskSha8: gateDiskSha8(),
            gateMissingIsAbnormal: now - bornAt > GATE_MISSING_GRACE_MS,
            identity: sources?.me || identityFallback,
            context: contextMax > 0 ? { tokens: context?.tokens ?? null, window: contextMax } : null,
            children,
            sources,
            stall: stall ? { ms: stall.ms, agoMs: now - stall.endedAt } : null,
            omGauges: (globalThis as any)[OM_GAUGES_GLOBAL] ?? null,
          });
          return [truncateToWidth(theme.fg("dim", ctx.cwd), width, ""), align(usage, model), statusLine];
        },
      };
    });
    for (const t of [timer, fastTimer, sourcesTimer]) if (t) clearInterval(t); // a second session_start must not stack timers
    sources = null;
    void refresh(ctx, true);
    timer = setInterval(() => void refresh(ctx, true), REFRESH_MS);
    timer.unref?.();
    void refreshFast();
    fastTimer = setInterval(() => void refreshFast(), FAST_REFRESH_MS);
    fastTimer.unref?.();
    void refreshSources(ctx);
    sourcesTimer = setInterval(() => void refreshSources(ctx), SOURCES_REFRESH_MS);
    sourcesTimer.unref?.();
  });

  pi.on("turn_end", (_event: any, ctx: any) => void refresh(ctx));

  pi.on("session_shutdown", (_event: any, ctx: any) => {
    if (timer) clearInterval(timer);
    if (fastTimer) clearInterval(fastTimer);
    if (sourcesTimer) clearInterval(sourcesTimer);
    timer = fastTimer = sourcesTimer = undefined;
    requestRender = undefined;
    ctx.ui?.setFooter?.(undefined);
  });

  pi.registerCommand("ai-cost", {
    description: "Refresh today's local Pi/Claude/Codex cost in the footer",
    handler: async (_args: string, ctx: any) => {
      await refresh(ctx, true);
      ctx.ui?.notify?.("AI cost refreshed", "info");
    },
  });
}
