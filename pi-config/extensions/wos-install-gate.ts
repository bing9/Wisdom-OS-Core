// wos-install-gate.ts — the live-install gate's tool_call hook, in Directors AND Pi children (request 2026-09-30 r2.4).
//
// @pi-child-safe: one bash tool_call gate (refuses an unverified live install); no prompt/context/tool changes; no I/O on unrelated commands.
//
// WHY A SEPARATE FILE. The gate shipped (r1–r2.3) as a hook inside wos-guards.ts, which carries no @pi-child-safe marker
// (it holds parent-only gates: authority continuations, turn anchors, settled sends …). Restricted Pi children launch
// with `--no-extensions` plus the marked files only, so the gate never loaded in a child, and an implementer child could
// run a live `install.py --apply` ungated (boundary-rebase finding, 2026-10-01). This file registers ONLY the hook.
//
// ONE IMPLEMENTATION. The parser, the classifier and the decider call stay in wos-guards.ts (`__predicates`), imported
// here as a module — evaluating it registers nothing (its hooks live in its default export, which is never called here).
// In a parent, wos-guards no longer registers the gate hook (r2.4), so every command is gated exactly once.
//
// Children: sandbox rehearsals (HOME=<tmp>, plan-only, tests) pass; a child's live --apply follows the same
// CONFIRMED / WOS_INSTALL_SELF_VERIFY rule as a Director, and the decision log records the child agent.
// A command already rewritten by wos-soul-sandbox.ts (`'…/soul_sandbox.sh' '<root>' <base64> [verifier]`) is decoded
// and its ORIGINAL command is gated (handler order between extensions is never relied on).
// Fail CLOSED: if the implementation cannot be loaded, an installer-shaped command is refused.
// Kill switches: touch ~/.wos-runtime/butler/install-gate.off (this gate) or ~/.wos-runtime/butler/guards.off (all guards).
//
// @ts-nocheck

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GUARDS_MODULE = () => process.env.WOS_INSTALL_GATE_GUARDS ?? path.join(os.homedir(), ".wos-runtime", "pi_extensions", "wos-guards.ts");
const OFF_FILES = () => [path.join(os.homedir(), ".wos-runtime", "butler", "install-gate.off"),
  path.join(os.homedir(), ".wos-runtime", "butler", "guards.off")];
// Cheap prefilter, a superset of wos-guards' INSTALL_PREFILTER plus the soul-sandbox wrapper; anything else: no work.
const PREFILTER = /(?:install|apply|txn|transaction|swap|upgrade|promote|cutover)[\w.-]*\.(?:py|sh)\b|--apply|\.(?:py|sh)\b[^\n]*[$`]|[$`][^\n]*\.(?:py|sh)\b|soul_sandbox\.sh/i;
const SOUL_WRAP = /^'((?:[^']|'\\'')*soul_sandbox\.sh)' '(?:[^']|'\\'')*' ([A-Za-z0-9+/=]+)(?: (?:verifier|soul))?\s*$/;

/** The command the shell will really run: a soul_sandbox.sh wrapper is decoded to its original command. */
export function innerCommand(cmd: string): string {
  const m = SOUL_WRAP.exec(String(cmd ?? ""));
  if (!m) return String(cmd ?? "");
  try { return Buffer.from(m[2], "base64").toString("utf8"); } catch { return String(cmd ?? ""); }
}

function gateOff(): boolean {
  try {
    return process.env.WOS_INSTALL_GATE === "off" || process.env.WOS_GUARDS === "off" || OFF_FILES().some((f) => fs.existsSync(f));
  } catch {
    return false;
  }
}

let impl: Promise<any> | null = null;
function loadImpl(): Promise<any> {
  impl ??= import(pathToFileURL(GUARDS_MODULE()).href).then((m: any) => {
    const P = m?.__predicates;
    if (typeof P?.liveInstallVerdict !== "function") throw new Error("wos-guards has no liveInstallVerdict");
    return P;
  });
  return impl;
}

function runtimeSessionId(ctx: any): string {
  try { return String(ctx?.sessionManager?.getSessionId?.() ?? ""); } catch { return ""; }
}

/** Exported for tests: the hook body. -> undefined (pass) or { block, reason }. */
export async function gateToolCall(event: any, ctx: any): Promise<any> {
  if (event?.toolName !== "bash" || gateOff()) return undefined;
  const raw = String(event?.input?.command ?? "");
  if (!PREFILTER.test(raw)) return undefined;                      // unrelated bash: one regex, no import, no spawn
  const cmd = innerCommand(raw);
  let P: any;
  try {
    P = await loadImpl();
  } catch (e: any) {
    impl = null;                                                    // retry the import on the next call
    if (!/(?:install|apply|txn|transaction|swap|upgrade|promote|cutover)[\w.-]*\.(?:py|sh)\b|--apply/i.test(cmd)) return undefined;
    return { block: true, reason: `REFUSED live install: the install gate could not load its implementation (${String(e?.message ?? e).slice(0, 120)}); refusing fail-closed. Kill switch: touch ~/.wos-runtime/butler/install-gate.off.` };
  }
  try {
    if (!P.INSTALL_PREFILTER.test(cmd)) return undefined;
    const sid = runtimeSessionId(ctx);
    const v = P.liveInstallVerdict(cmd, String(ctx?.cwd || process.cwd()), sid);
    const child = String(process.env.PI_SUBAGENT_AGENT ?? "").trim();
    // request 2026-10-02: this module instance of wos-guards never saw session_start, so every row
    // passes ctx's own session id ("" ⇒ wos-guards' env/null fallback). An older logGate ignores the 4th arg.
    if (!v.refuse) {
      if (v.reason === "admitted") P.logGate("live-install-gate", child ? `admitted (child ${child})` : "admitted", cmd, sid);
      return undefined;
    }
    P.logGate("live-install-gate", (child ? `[child ${child}] ` : "") + v.reason.slice(0, 180), v.parsed ?? cmd, sid);
    return { block: true, reason: v.reason };
  } catch (e: any) {
    const reason = `REFUSED live install: the install gate crashed (${String(e?.message ?? e).slice(0, 120)}); refusing fail-closed. Kill switch: touch ~/.wos-runtime/butler/install-gate.off.`;
    try { P.logGate("live-install-gate", reason, cmd, runtimeSessionId(ctx)); } catch { /* logging never blocks the refusal */ }
    return { block: true, reason };
  }
}

export default function (pi: any) {
  pi.on("tool_call", (event: any, ctx: any) => gateToolCall(event, ctx));
}
