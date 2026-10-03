/**
 * wos-cwd-heal — re-resolve the Pi's working directory through the LIVE mount before a tool runs.
 *
 * 🔴 INCIDENT 2026-09-25 (request 2026-09-25). DIR-example (13:28Z) and example-project (17:51Z)
 * crashed with the same Bun panic while reading back a large PNG:
 *
 *     panic: An unhandled error occurred while starting a worker: Unexpected      (then SIGILL, signal 4)
 *
 * Root cause, reproduced data-free (staging evidence/): the Pi's cwd was an inode on a wisdom-os rclone FUSE connection
 * that had died and been replaced by a fresh mount on the SAME path. Every operation on the old inode returns ENOTCONN.
 * Pi's image resize starts a Bun Worker per image; Bun's worker start trips over the dead cwd, maps ENOTCONN to
 * error.Unexpected and panics — JS cannot catch it. A long-lived Pi is exposed only because it outlives a remount.
 *
 * Fix here: the heal TARGET is learned ONLY from Pi's explicit session cwd — `ctx.cwd` (== the session header cwd,
 * `ctx.sessionManager.getCwd()`) at session_start and at every tool_call; a session cwd change is followed. It is NEVER
 * learned from process.cwd() (🔴 verifier reopen 2: a tool that chdirs to /tmp and back let the timer record /tmp, and
 * the heal then moved Pi to /tmp for good). The load-time cwd is only a seed until the first session event. Before every
 * tool call (and at most once a minute from a timer, which only probes and heals — it never learns) stat "."
 * asynchronously; if it fails with a dead-mount errno, process.chdir(<session cwd>) — the path resolves afresh through
 * the current mount — and verify. Concurrent checks (parallel sibling tool calls, the timer) all await ONE in-flight heal, so no tool
 * runs on the dead cwd while another caller is healing. The timer lives from session_start to session_shutdown (Pi
 * lifecycle contract: no timers in the factory; idempotent cleanup). Measured in the reproduction: after the heal the worker start no longer
 * panics. Never blocks a tool: the stat is async with a 2 s cap, and any failure here is logged and ignored.
 *
 * Kill switch: touch ~/.wos-runtime/butler/cwd-heal.off     Journal: ~/.wos-runtime/logs/cwd_heal.jsonl
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME = os.homedir();
const OFF = path.join(HOME, ".wos-runtime", "butler", "cwd-heal.off");
const JOURNAL = process.env.WOS_CWD_HEAL_JOURNAL || path.join(HOME, ".wos-runtime", "logs", "cwd_heal.jsonl");
const DEAD = new Set(["ENOTCONN", "ESTALE", "ENOENT", "EIO"]);
const MIN_GAP_MS = Number(process.env.WOS_CWD_HEAL_GAP_MS || 60_000);
const STAT_CAP_MS = 2_000;

function journal(row: Record<string, unknown>): void {
  try {
    fs.appendFileSync(JOURNAL, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...row }) + "\n");
  } catch {
    /* never let the journal break a tool */
  }
}

function currentCwd(): string | null {
  try {
    const c = process.cwd();
    return c && path.isAbsolute(c) ? c : null;
  } catch {
    return null;
  }
}

function initialCwd(): string | null {
  const c = currentCwd();
  if (c) return c;
  const pwd = process.env.PWD;
  return pwd && path.isAbsolute(pwd) ? pwd : null;
}

async function statDot(): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("TIMEOUT"), STAT_CAP_MS);
  });
  const probe = fs.promises.stat(".").then(
    () => "ok",
    (e: any) => String(e?.code || "ERR"),
  );
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Exported for the regression harness (tests/cwd_heal_unit_test.ts); Pi uses the default export. */
/** The session cwd Pi states in an extension context: ctx.cwd, else ctx.sessionManager.getCwd(). Absolute or null. */
export function sessionCwd(ctx: any): string | null {
  let c: any = null;
  try {
    c = ctx?.cwd ?? ctx?.sessionManager?.getCwd?.();
  } catch {
    c = null;
  }
  return typeof c === "string" && path.isAbsolute(c) ? c : null;
}

export function createHealer() {
  // The heal target: Pi's SESSION cwd. Seeded from the load-time cwd; replaced by every explicit session cwd
  // (session_start / tool_call ctx). Never learned from process.cwd() — a tool may chdir temporarily.
  let target: string | null = initialCwd();
  let learnedFromSession = false;
  let lastCheck = 0;
  let inflight: Promise<void> | null = null;

  async function run(reason: string): Promise<void> {
    const st = await statDot();
    if (st === "ok" || st === "TIMEOUT" || !DEAD.has(st) || !target) return;
    const dest = target;
    try {
      process.chdir(dest);
      const after = await statDot();
      journal({ event: after === "ok" ? "healed" : "heal-failed", reason, cwd: dest, before: st, after,
                target_source: learnedFromSession ? "session" : "load-seed" });
    } catch (e: any) {
      journal({ event: "heal-failed", reason, cwd: dest, before: st, error: String(e?.code || e?.message || e),
                target_source: learnedFromSession ? "session" : "load-seed" });
    }
  }

  /** Every caller awaits the SAME in-flight check; a new one starts only when none is running. */
  /** Learn the target from an explicit session cwd source only (never from process.cwd()). */
  function learn(cwd: string | null): void {
    if (cwd) {
      target = cwd;
      learnedFromSession = true;
    }
  }

  function check(reason: string, ctx?: any): Promise<void> {
    if (reason !== "timer" && ctx !== undefined) learn(sessionCwd(ctx)); // the timer only probes and heals
    if (fs.existsSync(OFF)) return Promise.resolve();
    if (inflight) return inflight;
    const now = Date.now();
    if (reason === "timer" && now - lastCheck < MIN_GAP_MS) return Promise.resolve();
    lastCheck = now;
    inflight = run(reason)
      .catch(() => undefined)
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return { check, learn, target: () => target };
}

export default function (pi: any) {
  const healer = createHealer();
  let timer: ReturnType<typeof setInterval> | null = null;

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  pi.on("session_start", async (_event: any, _ctx: any) => {
    stopTimer(); // idempotent: a repeated session_start (reload / session replacement) never stacks timers
    timer = setInterval(() => void healer.check("timer"), MIN_GAP_MS);
    (timer as any).unref?.();
    void healer.check("session_start", _ctx);
  });

  pi.on("session_shutdown", async (_event: any, _ctx: any) => {
    stopTimer();
  });

  pi.on("tool_call", async (_event: any, _ctx: any) => {
    try {
      await healer.check("tool_call", _ctx);
    } catch {
      /* fail open: a heal problem must never block the tool (the tool_call fail-safe would) */
    }
  });
}
