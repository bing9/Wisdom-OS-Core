/**
 * wos-soul-guard.ts — STEP 2: exact-path guard on native write/edit tools.
 *
 * ALL sessions (interactive too). No shell parsing: write/edit tools carry an explicit
 * path, which is normalised EXACTLY the way Pi's own write/edit tools normalise it
 * (normalizePath/resolveToCwd ported verbatim from pi.real: leading `@` stripped,
 * unicode spaces incl. no-break space folded, `file://` via fileURLToPath, `~`
 * expansion), resolved against the calling cwd, realpath'd through the nearest
 * existing ancestor so symlinks cannot escape the check, and refused when it lands
 * in 01_Soul.
 *
 * Second denied set (round 2 — closes direct trust-anchor tampering; round 3 keeps it even with no allowance,
 * because the server daemon reads these files):
 * write/edit to GUARD-CRITICAL paths is refused too: the approval HMAC key, the
 * directives file, the consumed-nonce ledger, the apply log, the in-server pipeline (soul_apply.py) and every
 * control_tower module it loads, the sandbox script, the two guard extensions,
 * everything under the switch dir, and user site-packages (`.pth`/module plants).
 * Round 4: the whole control_tower/ DIRECTORY is denied, not just named files — the
 * server imports a directory (script-DIR-example sys.path), so a NEW file there (e.g.
 * control_tower/html.py shadowing stdlib at start) was an open route via these tools.
 * Rationale: rewriting the pipeline (or minting a directive, or flipping a switch)
 * via the write/edit tools would hand a sandboxed session server-grade trust.
 * Tradeoff, stated: with step 2 ON, guard/
 * Control-Tower code changes go through the owner outside agent tools (Writer 3) or with
 * the switch OFF — same envelope as any L3 change. See LEGITIMATE_WRITERS.md.
 *
 * Switch: installed but OFF until DIR-wos enables. ON = the file
 *   ~/.wos-runtime/state/soul_guard/ENABLE_step2   exists
 *   (overrides for hermetic tests: WOS_SOUL_GUARD_STATE=<dir>, WOS_SOUL_GUARD_STEP2=1,
 *   WOS_SOUL_ROOT=<scratch stand-in for 01_Soul>, plus WOS_APPROVAL_KEY,
 *   WOS_DIRECTIVES_PATH, WOS_CONSUMED_PATH, WOS_APPLY_LOG, WOS_SOUL_APPLIER,
 *   WOS_SOUL_SANDBOX_SH, WOS_SOUL_EXT_DIR).
 * When OFF the handler is a pass-through (zero behaviour change).
 *
 * There is NO allowance in this path: write/edit into Soul always refuses when ON.
 * The governed route is the owner's panel: the Control Tower server signs the approval
 * and applies it in-process — see LEGITIMATE_WRITERS.md. Direct Soul edits by agents are proposals,
 * not writes: stage them in Automation/Soul_Proposed_Changes/.
 *
 * request 2026-09-23 steps 2+3, round 2.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STEP = "step2-soul-guard";

function stateDir(): string {
  return process.env.WOS_SOUL_GUARD_STATE ||
    path.join(os.homedir(), ".wos-runtime", "state", "soul_guard");
}

/** Exported for tests. ON iff the ENABLE file exists or the env override is set. */
export function step2Enabled(): boolean {
  if (process.env.WOS_SOUL_GUARD_STEP2 === "1") return true;
  if (process.env.WOS_SOUL_GUARD_STEP2 === "0") return false;
  try {
    return fs.existsSync(path.join(stateDir(), "ENABLE_step2"));
  } catch {
    return false;
  }
}

/** Exported for tests. */
export function soulRoot(): string {
  if (process.env.WOS_SOUL_ROOT) return path.resolve(process.env.WOS_SOUL_ROOT);
  const wosRoot =
    process.env.WISDOM_OS_ROOT || path.join(os.homedir(), "wisdom-os");
  return path.resolve(wosRoot, "Obsidian Vault", "Context", "01_Soul");
}

/** Exported for tests. True when candidate === root or lies under it. */
export function underSoul(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== "..");
}

// ── Pi-verbatim path normalisation (from pi.real resolveToCwd/normalizePath) ──
// round 2: the guard must resolve EXACTLY what pi's write/edit resolve, or `@`,
// `file://` and no-break-space forms sail past the check into Soul (verifier 3d).
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g; // pi.real verbatim

interface NormOpts {
  trim?: boolean;
  normalizeUnicodeSpaces?: boolean;
  stripAtPrefix?: boolean;
  expandTilde?: boolean;
  homeDir?: string;
}

function normalizePath(input: string, options: NormOpts = {}): string {
  let normalized = options.trim ? input.trim() : input;
  if (options.normalizeUnicodeSpaces) {
    normalized = normalized.replace(UNICODE_SPACES, " ");
  }
  if (options.stripAtPrefix && normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  if (options.expandTilde ?? true) {
    const home = options.homeDir ?? os.homedir();
    if (normalized === "~") return home;
    if (normalized.startsWith("~/")) {
      return path.join(home, normalized.slice(2));
    }
  }
  if (/^file:\/\//.test(normalized)) {
    try {
      return fileURLToPath(normalized);
    } catch {
      return normalized; // malformed URL: pi's tool errors out, so no write happens
    }
  }
  return normalized;
}

function resolvePath2(input: string, baseDir = process.cwd(), options: NormOpts = {}): string {
  const normalized = normalizePath(input, options);
  const normalizedBaseDir = normalizePath(baseDir);
  return path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(normalizedBaseDir, normalized);
}

/** What pi's write/edit tools resolve the path to. Exported for tests. */
export function resolveToCwd(filePath: string, cwd: string): string {
  return resolvePath2(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * Resolve an explicit tool path the way the filesystem will: Pi-identical
 * normalisation first, then realpath the nearest existing ancestor so symlinks
 * cannot escape the check. Nonexistent leaf names are fine — the check is on
 * where the write WOULD land. Exported for tests.
 */
export function resolveTarget(raw: unknown, cwd: string): string {
  const abs = resolveToCwd(String(raw ?? ""), cwd || process.cwd());
  // Walk up to the nearest existing ancestor, realpath it, re-attach the rest.
  const parts: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return parts.length ? path.join(real, ...parts.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs; // nothing exists — fall back to normalised abs
      parts.push(path.basename(cur));
      cur = parent;
    }
  }
}

// ── guard-critical paths (round 2): the applier's trust anchors ──
function ctDir(): string {
  return path.dirname(applierPath());
}

/** Exported for tests. Anchor for the in-server pipeline (derives ctDir()). */
export function applierPath(): string {
  return process.env.WOS_SOUL_APPLIER ||
    path.join(os.homedir(), ".wos-runtime", "control_tower", "soul_apply.py");
}

/** Exported for tests: every write/edit-denied trust anchor (files + dirs). */
export function protectedPaths(): string[] {
  const home = os.homedir();
  const ct = ctDir();
  const st = path.join(home, ".wos-runtime", "control_tower", "state");
  const files = [
    process.env.WOS_APPROVAL_KEY || path.join(st, ".approval_hmac_key"),
    process.env.WOS_DIRECTIVES_PATH || path.join(st, "proposals_directives.jsonl"),
    process.env.WOS_CONSUMED_PATH || path.join(st, "soul_approvals_consumed.jsonl"),
    process.env.WOS_APPLY_LOG || path.join(st, "soul_apply_log.jsonl"),
    path.join(ct, "soul_apply_step.py"), // deleted round 3 — anchor kept: no resurrection
    path.join(ct, "soul_apply.py"),
    path.join(ct, "approval_sig.py"),
    path.join(ct, "proposals_panel.py"),
    path.join(ct, "proposals_apply.py"),
    path.join(ct, "proposals_server.py"),
    path.join(ct, "server.py"),
    process.env.WOS_SOUL_SANDBOX_SH ||
      path.join(home, ".wos-runtime", "butler", "soul_sandbox.sh"),
  ];
  const extDir = process.env.WOS_SOUL_EXT_DIR || path.join(home, ".pi", "agent", "extensions");
  files.push(path.join(extDir, "wos-soul-guard.ts"));
  files.push(path.join(extDir, "wos-soul-sandbox.ts"));
  const dirs = [
    stateDir(),
    // Round 4 R4c/R4d: deny the whole control_tower/ tree. The server's real import
    // closure is a directory; named-file anchors left NEW files (stdlib shadows at
    // server start) and edited siblings (clause_edit, imported mid-apply) open.
    ct,
  ];
  // user site-packages that exist right now (`.pth`/module plants live here)
  try {
    const lib = path.join(home, ".local", "lib");
    for (const py of fs.readdirSync(lib)) {
      const sp = path.join(lib, py, "site-packages");
      try {
        if (fs.statSync(sp).isDirectory()) dirs.push(sp);
      } catch { /* absent — skip */ }
    }
  } catch { /* no ~/.local/lib — skip */ }
  return [...files.map((f) => path.resolve(f)), ...dirs.map((d) => path.resolve(d))];
}

/** Exported for tests. Returns the matched anchor, or null when unprotected. */
export function matchProtected(candidate: string): string | null {
  for (const anchor of protectedPaths()) {
    try {
      const rel = path.relative(anchor, candidate);
      if (rel === "" || (!rel.startsWith(".." + path.sep) && rel !== "..")) return anchor;
    } catch {
      continue;
    }
  }
  // site-packages that do not exist yet (fresh `pip install --user`: the guard
  // cannot realpath what is not there, so match textually under ~/.local/lib).
  const norm = path.resolve(candidate);
  const libFrag = path.join(os.homedir(), ".local", "lib") + path.sep;
  if (norm.startsWith(libFrag) && norm.split(path.sep).includes("site-packages")) return norm;
  return null;
}

/** Exported for tests. Returns the refusal reason, or null when allowed. */
export function checkWriteEdit(
  toolName: string,
  rawPath: unknown,
  cwd: string,
  soul: string,
): string | null {
  const target = resolveTarget(rawPath, cwd);
  if (underSoul(target, soul)) {
    return (
      `Soul is L3 — ${toolName} to ${target} refused. ` +
      `Soul changes are proposals until the owner ratifies them: stage the change as a proposal ` +
      `(Automation/Soul_Proposed_Changes/) for the proposals flow, or run the governed ` +
      `the owner's panel click makes the server sign and apply it in-process. Direct agent ` +
      `writes to 01_Soul are never applied.`
    );
  }
  const anchor = matchProtected(target);
  if (anchor) {
    return (
      `Guard-critical path — ${toolName} to ${target} refused (anchor: ${anchor}). ` +
      `That file is a trust anchor of the Soul guard (approval key, ratification record, ` +
      `applier code, sandbox, or switch); agent writes to it would hand a sandboxed agent ` +
      `unsandboxed execution. Changes go through the owner outside agent tools, or with the ` +
      `guard switch OFF. The governed Soul route is the applier after the owner's directive.`
    );
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!step2Enabled()) return; // switch OFF: pass-through
    const tool = event?.toolName;
    if (tool !== "write" && tool !== "edit") return;
    const cwd = String(ctx?.cwd || process.cwd());
    const reason = checkWriteEdit(tool, event?.input?.path, cwd, soulRoot());
    if (reason) return { block: true, reason, terminate: true };
  });
}
