/**
 * wos-spawn-cwd — no child process of this Pi starts in a wisdom-os (FUSE) cwd.   request 2026-09-30 (F1)
 * @pi-child-safe: spawn-cwd chokepoint — moves only the KERNEL cwd of this process to $HOME; every JS-visible cwd (ctx.cwd, process.cwd(), the bash tool's working directory) is unchanged, so a restricted child keeps its semantics and loses the vfork-on-FUSE stall
 *
 * WHY (RCA request 2026-09-30): 31% of Pi main-thread stalls >= 11 s (132/505, 6 066 s) were the main thread
 * parked in vfork (state D, syscall 58): Bun spawns a child with vfork and the child chdir()s into the parent's cwd
 * BEFORE exec. The Pi's cwd is the WOS root on the rclone wisdom-os mount, so while that mount is wedged, EVERY spawn
 * (herdr execFileSync, employer datapolicy_guardrails on every tool call, WOS guards, the bash tool) parks the whole UI.
 *
 * WHAT THIS DOES (only when the startup cwd is on a FUSE mount under $HOME; otherwise it is inert):
 *   1. Kernel cwd := $HOME (local btrfs). Every spawn that does not pass `cwd` now chdir()s into $HOME: fast.
 *   2. process.cwd() keeps answering the LOGICAL cwd (the startup cwd Pi captured). Every JS consumer that reads it —
 *      herdr pane `--cwd` for subagent children, resolveSubagentPaths, safe_bash, estate/data-policy `ctx?.cwd || process.cwd()`
 *      fallbacks, Pi's own resolvePath(x, process.cwd()) defaults — sees exactly what it saw before.
 *      process.chdir() is wrapped so a chdir back INTO a FUSE path (cross-spawn's restore, wos-cwd-heal) only moves the
 *      logical cwd; a chdir to a local path behaves natively. Measured (evidence/bun_cwd_probe.txt): Bun's spawn default
 *      cwd and path.resolve(<relative>) use the KERNEL cwd, not process.cwd(); no WOS/pi-subagents/OM source uses a
 *      relative literal path with fs (tests/static_audit.txt).
 *   3. The LLM `bash` tool is re-registered from Pi's own createBashToolDefinition (same name/description/schema/
 *      renderers/prompt snippet — byte-identical tool JSON, tests/prefix/*) with a spawnHook that spawns bash with
 *      cwd $HOME and runs `cd -- '<ctx.cwd>'` as the first line INSIDE the child. The FUSE path walk then happens in the
 *      async child after exec, never in the parent's vfork. The "Working directory does not exist" check is kept (async).
 *      `!` user-bash gets the same treatment via user_bash operations.
 * NOT CHANGED here (upstream code that passes an explicit FUSE cwd; see REPORT): employer llm-rules (ctx.cwd), provenance
 * (dirname of the file), internal-cli repo-info spawnSync, internal-rg grep/find (search dir), cross-spawn users with an explicit cwd.
 *
 * Kill switches (read at load; a restart applies them): env WOS_SPAWN_CWD=0, or file ~/.wos-runtime/butler/spawn-cwd.off
 * Upstream-workaround registry id: pi-spawn-inherits-fuse-cwd (~/.wos-runtime/harness/upstream_workarounds.yaml).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";

const HOME = os.homedir();
const OFF_FILE = path.join(HOME, ".wos-runtime", "butler", "spawn-cwd.off");
const KEY = Symbol.for("wos.spawn-cwd.v1");

/** '...' for POSIX sh. */
export function shq(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** /proc/mounts field decoding (\040 = space, \011 tab, \012 nl, \134 backslash). */
function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)));
}

/** FUSE mount points under $HOME (the slow roots), read once from local procfs. */
export function slowRootsFrom(mountsText: string, home = HOME): string[] {
  const out: string[] = [];
  for (const line of mountsText.split("\n")) {
    const f = line.split(" ");
    if (f.length < 3) continue;
    const mnt = unescapeMount(f[1]); const type = f[2];
    if (!type.startsWith("fuse") || type === "fusectl") continue;
    if (mnt === home || mnt.startsWith(home + "/")) out.push(mnt);
  }
  const extra = (process.env.WOS_SPAWN_CWD_SLOW_ROOTS || "").split(":").filter((p) => path.isAbsolute(p));
  return [...new Set([...out, ...extra])].sort((a, b) => b.length - a.length);
}

export function under(p: string, roots: string[]): boolean {
  return roots.some((r) => p === r || p.startsWith(r.endsWith("/") ? r : r + "/"));
}

/** The line the bash child runs first: enter the logical cwd, then leave OLDPWD exactly as a built-in child has it
 *  (bash keeps an inherited OLDPWD only when it names a directory, else unsets it; our `cd` would set it to $HOME). */
export function cdPrefix(cwd: string, env: Record<string, string | undefined> | undefined): string {
  const o = env && typeof env.OLDPWD === "string" ? env.OLDPWD : undefined;
  const old = o !== undefined ? `if [ -d ${shq(o)} ]; then OLDPWD=${shq(o)}; else unset OLDPWD; fi` : "unset OLDPWD";
  return `cd -- ${shq(cwd)} || exit 1; ${old}\n`;
}

type State = { active: boolean; logical: string; kernelHome: string; roots: string[]; realCwd: () => string;
  realChdir: (d: string) => void; virtual: string | null; reason: string };

/** Install (once per process) the kernel-cwd move + the process.cwd()/chdir() virtualisation. Idempotent across /reload. */
export function installCwdVirtualisation(opts: { mounts?: string; home?: string; force?: boolean } = {}): State {
  const g: any = process as any;
  if (g[KEY]) return g[KEY] as State;
  const home = opts.home ?? HOME;
  const realCwd = process.cwd.bind(process) as () => string;
  const realChdir = process.chdir.bind(process) as (d: string) => void;
  const st: State = { active: false, logical: "", kernelHome: home, roots: [], realCwd, realChdir, virtual: null, reason: "" };
  g[KEY] = st;
  if (process.env.WOS_SPAWN_CWD === "0") { st.reason = "env WOS_SPAWN_CWD=0"; return st; }
  try { if (fs.existsSync(OFF_FILE)) { st.reason = "kill file " + OFF_FILE; return st; } } catch { /* local path */ }
  let logical = "";
  try { logical = realCwd(); } catch { logical = process.env.PWD || ""; }
  if (!logical || !path.isAbsolute(logical)) { st.reason = "no absolute startup cwd"; return st; }
  let mounts = opts.mounts;
  if (mounts === undefined) { try { mounts = fs.readFileSync("/proc/self/mounts", "utf8"); } catch { mounts = ""; } }
  st.roots = slowRootsFrom(mounts, home);
  if (!opts.force && !under(logical, st.roots)) { st.reason = "startup cwd is not on a FUSE mount under $HOME"; return st; }
  try { realChdir(home); } catch (e: any) { st.reason = "chdir($HOME) failed: " + (e?.code || e); return st; }
  st.active = true; st.logical = logical; st.virtual = logical; st.reason = "active";
  process.cwd = function cwd(): string { return st.virtual ?? realCwd(); } as any;
  process.chdir = function chdir(d: string): void {
    const target = path.resolve(process.cwd(), String(d));
    if (under(target, st.roots)) {
      if (target !== st.virtual) {          // a NEW FUSE dir: keep chdir's errors (ENOENT/ENOTDIR) — rare, explicit
        const s = fs.statSync(target);
        if (!s.isDirectory()) { const e: any = new Error(`ENOTDIR: not a directory, chdir '${target}'`); e.code = "ENOTDIR"; throw e; }
      }
      if (realCwd() !== home) realChdir(home);
      st.virtual = target;
      return;
    }
    realChdir(target);
    st.virtual = null;
  } as any;
  return st;
}

/** The bash tool definition Pi would build, with the cd moved inside the child. */
export function createHomeSpawnBash(logicalFallback: string, home = HOME, extra: { commandPrefix?: string; shellPath?: string } = {}) {
  const def: any = createBashToolDefinition(logicalFallback, {
    ...extra,
    spawnHook: (c: { command: string; cwd: string; env: Record<string, string | undefined> }) =>
      ({ ...c, command: cdPrefix(c.cwd, c.env) + c.command, cwd: home }),
  });
  const inner = def.execute;
  return {
    ...def,
    async execute(id: string, params: any, signal: any, onUpdate: any, ctx: any) {
      const cwd = String(ctx?.cwd || logicalFallback);
      try { await fs.promises.access(cwd, fs.constants.F_OK); }    // the built-in's check, async (thread pool)
      catch { throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`); }
      return inner.call(def, id, params, signal, onUpdate, ctx);
    },
  };
}

/** `!` commands: same cd-inside-the-child operations. */
export function homeSpawnOperations(home = HOME, extra: { shellPath?: string } = {}) {
  const local: any = createLocalBashOperations({ shellPath: extra.shellPath });
  return {
    exec: async (command: string, cwd: string, o: any) => {
      try { await fs.promises.access(cwd, fs.constants.F_OK); }
      catch { throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`); }
      return local.exec(cdPrefix(cwd, o?.env ?? process.env) + command, home, o);
    },
  };
}

/** Pi's global shell settings (shellCommandPrefix / shellPath): the override builds the tool exactly as Pi does.
 *  A project .pi/settings.json is NOT read here (that would be a main-thread FUSE read); the WOS root has none
 *  (tests/static_audit.txt). Malformed values → no override (Pi's built-in stays). */
function shellSettings(): { commandPrefix?: string; shellPath?: string; ok: boolean } {
  let g: any = {};
  try { g = JSON.parse(fs.readFileSync(path.join(HOME, ".pi", "agent", "settings.json"), "utf8")) || {}; } catch { g = {}; }
  const okv = (v: any) => v === undefined || typeof v === "string";
  return { commandPrefix: g.shellCommandPrefix, shellPath: g.shellPath, ok: okv(g.shellCommandPrefix) && okv(g.shellPath) };
}

export default function (pi: any) {
  const st = installCwdVirtualisation();
  if (!st.active) return;
  const sh = shellSettings();
  if (sh.ok && process.env.WOS_SPAWN_CWD_BASH !== "0") {
    pi.registerTool(createHomeSpawnBash(st.logical, st.kernelHome, { commandPrefix: sh.commandPrefix, shellPath: sh.shellPath }));
    pi.on("user_bash", () => ({ operations: homeSpawnOperations(st.kernelHome, { shellPath: sh.shellPath }) }));
  }
}
