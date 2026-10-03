/**
 * wos-empty-reply-guard — one visible-answer nudge when a turn ends with thinking only
 * (request 2026-10-03).
 *
 * WHY. 2026-10-03 the owner's interactive session <session> (claude-opus-5-5, thinking xhigh) ended 4 turns
 * (18:41:39Z, 18:53:39Z, 19:31:15Z, 19:39:14Z) with stopReason=stop and ONLY a thinking block: the answer was
 * written inside thinking, so the owner saw "Thinking..." and no reply.
 *
 * HOW. Pi's `agent_before_settle` boundary (runs once Pi would otherwise go idle). If the final assistant message
 * of the run has stopReason "stop", ≥1 thinking block and no non-empty text block, return ONE `custom_message`
 * entry (display: true) + `continue: true`. The entry is appended at the transcript tail — exactly like a
 * user follow-up — so the system prompt, tools and every earlier message stay byte-identical (prompt cache safe).
 *
 * NEVER LOOP. At most one nudge per original turn: if the run being judged was itself started by our nudge
 * (the latest user-side context message is our custom message), nothing happens. Also skipped when another
 * extension already requested continuation or input is queued (a turn is coming anyway).
 *
 * SCOPE. Sessions with a human UI only (the owner's interactive session, Directors in Herdr panes). Skipped:
 * subagent children (PI_SUBAGENT_AGENT / PI_SUBAGENT_ID), OM worker subprocesses (OM_WORKER), and any ctx
 * without a TUI (print / json / rpc — rpc only under the test override WOS_EMPTY_REPLY_GUARD_ALLOW_RPC=1).
 * Ledger: ~/.wos-runtime/state/empty_reply_guard.jsonl (session, ts, model, thinking chars).
 * Kill switch: touch ~/.wos-runtime/state/empty-reply-guard.off
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = homedir();
const LEDGER = process.env.WOS_EMPTY_REPLY_GUARD_LEDGER || join(HOME, ".wos-runtime", "state", "empty_reply_guard.jsonl");
const KILL = process.env.WOS_EMPTY_REPLY_GUARD_OFF || join(HOME, ".wos-runtime", "state", "empty-reply-guard.off");
export const CUSTOM_TYPE = "wos-empty-reply-guard";
export const NUDGE = "Your last turn ended with thinking only; the owner saw no reply. Write the visible answer now, briefly.";

/** Thinking chars if `m` is a thinking-only clean stop, else -1. */
export function thinkingOnlyStop(m: any): number {
  if (!m || m.role !== "assistant" || m.stopReason !== "stop" || !Array.isArray(m.content)) return -1;
  let thinking = 0, chars = 0;
  for (const b of m.content) {
    if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) return -1;
    if (b?.type === "toolCall") return -1;
    if (b?.type === "thinking" || b?.type === "redacted_thinking") {
      thinking++;
      chars += typeof b.thinking === "string" ? b.thinking.length : 0;
    }
  }
  return thinking > 0 ? chars : -1;
}

/** True iff the run that produced the final assistant message was started by our own nudge. */
export function startedByNudge(messages: any[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const role = m?.role;
    if (role === "assistant" || role === "toolResult" || role === "system") continue;
    // first user-side message walking back = what started this run
    return (role === "custom" && m?.customType === CUSTOM_TYPE) ||
      (role === "user" && typeof m?.content === "string" && m.content === NUDGE);
  }
  return false;
}

export function inScope(ctx: any, env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.PI_SUBAGENT_AGENT ?? "").trim() || (env.PI_SUBAGENT_ID ?? "").trim()) return false;
  if ((env.OM_WORKER ?? "").trim()) return false;
  if (ctx?.hasUI !== true) return false;
  // headless rpc/SDK workers also carry a UI context; only the TUI has a human watching (rpc: test override only)
  const mode = ctx?.mode;
  return mode === undefined || mode === "tui" || (mode === "rpc" && env.WOS_EMPTY_REPLY_GUARD_ALLOW_RPC === "1");
}

function ledger(row: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(LEDGER), { recursive: true });
    appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
  } catch { /* the ledger never blocks the nudge */ }
}

export default function (pi: any) {
  pi.on("agent_before_settle", async (event: any, ctx: any) => {
    if (event?.outcome !== "completed" || event?.continue) return;
    if (!inScope(ctx) || existsSync(KILL)) return;
    const bctx = event?.context ?? {};
    if (Array.isArray(bctx.pendingMessages) && bctx.pendingMessages.length > 0) return;
    const msgs: any[] = Array.isArray(bctx.contextMessages) ? bctx.contextMessages : [];
    const last = msgs[msgs.length - 1];
    const chars = thinkingOnlyStop(last);
    if (chars < 0) return;
    const session = (() => { try { return ctx?.sessionManager?.getSessionId?.(); } catch { return undefined; } })();
    const model = last.provider && last.model ? `${last.provider}/${last.model}` : last.model;
    if (startedByNudge(msgs)) { ledger({ session, model, thinking_chars: chars, event: "skip-already-retried" }); return; }
    ledger({ session, model, thinking_chars: chars, event: "nudged" });
    const prior: any[] = Array.isArray(event.entries) ? event.entries : [];
    return {
      entries: [...prior, { type: "custom_message", customType: CUSTOM_TYPE, content: NUDGE, display: true,
        details: { version: 1, thinking_chars: chars } }],
      continue: true,
    };
  });
}
