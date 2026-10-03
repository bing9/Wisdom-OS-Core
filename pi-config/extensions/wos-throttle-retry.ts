/**
 * wos-throttle-retry — bounded, cancellable retry for provider THROUGHPUT throttles that Pi does not classify
 * as retryable (request 2026-10-02; upstream workaround `pi-ptu-throttle-not-retryable`).
 *
 * WHY. 2026-10-02T16:39:10Z the owner's Butler (openai/gpt-5.6-sol) died with stopReason=error:
 *   "Requests have exceeded the throughput limit on your Provisioned-Managed deployment. If you continue to
 *    exceed your limit, consider increasing the number of provisioned throughput units deployed."
 * Pi 0.99's agent retry classifier (packages/ai/src/utils/retry.ts RETRYABLE_PROVIDER_ERROR_PATTERN) has no
 * term in that text (no "429", no "rate limit"), so Pi retried 0 times and showed /bug. It is a per-minute
 * PTU limit: transient. The classifier is hard-coded — not reachable from settings or the extension API.
 *
 * HOW. Pi's own native hook: `agent_before_settle` runs only AFTER Pi's retry decision returned "no retry"
 * (AgentSession._runAgentPrompt: _handlePostAgentRun → _runBeforeSettleBoundary). For a matched throttle we
 * wait with backoff (20 s, 40 s, 60 s; max 3 per error streak), then return the SAME recovery Pi uses for its
 * own retries: a `context_edit` that omits the failed assistant attempt + `continue: true`. No user message is
 * injected; the prompt prefix is unchanged (Pi's retry path does exactly this edit).
 *
 * NEVER DOUBLE. (1) If Pi's own classifier would retry the text, this does nothing (Pi owns that error and its
 * cap). (2) If Pi already retried within this error streak (more error agent_ends than our own continues),
 * this does nothing. (3) If another extension already requested continuation, or input is queued, nothing.
 * NEVER MATCHED: quota / billing / balance / auth / permission / context-overflow texts (DENY below wins).
 *
 * CANCEL. Any submitted input (`input` event: typed prompt, steer, extension message) or any keystroke in the
 * interactive TUI (ctx.ui.onTerminalInput, focus reports ignored) or session shutdown cancels the pending wait;
 * the turn then ends exactly as it would have without this extension (queued input runs normally).
 * A programmatic abort (RPC/SDK `abort`, no keystroke) is NOT observable here: ctx.signal is undefined for the whole
 * before-settle wait, even after abort (measured, Pi 0.99.1). The wait then runs out, Pi drops the continuation
 * (_abortDuringBeforeSettle; 0 extra requests), and the ledger row `retried` means "continuation requested".
 * Status line during the wait: "provider throttled; retry 1/3 in 20 s (type to cancel)".
 * Ledger: ~/.wos-runtime/logs/throttle_retry.jsonl (one row per scheduled/retried/cancelled/skipped/cap event).
 * Kill switch: touch ~/.wos-runtime/butler/throttle-retry.off   ·   Pi `retry.enabled: false` also disables it.
 * Deliberately NOT @pi-child-safe: scope is interactive sessions (the owner's, Directors'). Children are out of scope.
 * SELF-RETIRING: when Pi's classifier matches the throughput text, rule (1) makes this a no-op; the upstream
 * probe then reports `fixed` and the registry entry tells DIR-wos to remove this file.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = homedir();
const LEDGER = process.env.WOS_THROTTLE_RETRY_LEDGER || join(HOME, ".wos-runtime", "logs", "throttle_retry.jsonl");
const KILL = process.env.WOS_THROTTLE_RETRY_OFF || join(HOME, ".wos-runtime", "butler", "throttle-retry.off");
const STATUS_KEY = "wos-throttle-retry";
export const DEFAULT_DELAYS_MS: readonly number[] = Object.freeze([20_000, 40_000, 60_000]);

/** Throughput / per-minute throttle phrasing Pi 0.99 does not retry. */
export const MATCH: readonly RegExp[] = Object.freeze([
  /exceeded the (?:\w+ )?throughput limit/i,
  /Provisioned[- ]Managed/i,
  /provisioned throughput/i,
  /\btoo_many_requests\b/i,
  /\bthrottl(?:ed|ing)\b/i,
]);

/** Never retried, even if a MATCH term is present: exhausted quota, billing, auth, context overflow. */
export const DENY: readonly RegExp[] = Object.freeze([
  /quota/i, /insufficient/i, /billing/i, /balance/i, /budget/i, /usage.?limit/i, /subscription/i,
  /unauthori[sz]ed/i, /forbidden/i, /invalid.{0,12}(?:api.?key|token|credential)/i, /authenticat/i,
  /permission/i, /access denied/i, /\b40[13]\b/,
  /context.?(?:length|window|size|limit)/i, /exceed(?:s|ed)? (?:the )?(?:model'?s? )?(?:maximum )?context/i,
  /prompt is too long/i, /input (?:is )?too long/i, /max(?:imum)?_?tokens/i, /reduce (?:the length|your prompt)/i,
  /\bcontext_length_exceeded\b/i, /string_above_max_length/i,
  /too (?:long|large)/i, /maximum (?:context|prompt)/i, /too many tokens/i, /token limit/i, /request_too_large/i,
]);

// Copy of Pi 0.99.x retry.ts (pinned with the package); used only to stay OUT of Pi's way.
const PI_NON_RETRYABLE = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded/i;
const PI_RETRYABLE = new RegExp([
  "overloaded", "currently experiencing high demand", "rate.?limit", "too many requests", "429", "500", "502",
  "503", "504", "520", "524", "service.?unavailable", "server.?error", "internal.?error", "provider.?returned.?error",
  "exceeded request buffer limit while retrying upstream", "network.?error", "connection.?error",
  "connection.?refused", "connection.?lost", "other side closed", "fetch failed", "getaddrinfo", "ENOTFOUND",
  "EAI_AGAIN", "upstream.?connect", "reset before headers", "socket hang up", "socket connection was closed",
  "timed? out", "timeout", "terminated", "websocket.?closed", "websocket.?error", "ended without",
  "stream ended before message_stop", "stream ended before a terminal response event",
  "http2 request did not get a response", "retry delay", "you can retry your request", "try your request again",
  "please retry your request", "ResourceExhausted", "subscription_sharing_usage_unavailable",
  "subscription_sharing_user_unavailable",
].join("|"), "i");

export function piWouldRetry(text: string): boolean {
  return !PI_NON_RETRYABLE.test(text) && PI_RETRYABLE.test(text);
}

export type Verdict = "throttle" | "pi-owns" | "denied" | "unmatched";
export function classify(errorMessage: unknown): Verdict {
  const t = typeof errorMessage === "string" ? errorMessage.trim() : "";
  if (!t) return "unmatched";
  if (DENY.some((r) => r.test(t))) return "denied";
  if (piWouldRetry(t)) return "pi-owns";
  return MATCH.some((r) => r.test(t)) ? "throttle" : "unmatched";
}

export function delays(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.WOS_THROTTLE_RETRY_DELAYS_MS;
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p) && p.length >= 1 && p.length <= 5 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 120_000)) return p;
    } catch { /* malformed override never changes behaviour */ }
  }
  return [...DEFAULT_DELAYS_MS];
}

function piRetryDisabled(): boolean {
  try {
    const dir = process.env.PI_CODING_AGENT_DIR || join(HOME, ".pi", "agent");
    const s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    return s?.retry?.enabled === false;
  } catch {
    return false;
  }
}

function ledger(row: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(LEDGER), { recursive: true });
    appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...row }) + "\n");
  } catch { /* the ledger never blocks a retry decision */ }
}

const FOCUS_REPORT = /^(?:\x1b\[[IO])+$/;

export default function (pi: any) {
  let errStreak = 0;     // consecutive error agent_ends (each provider attempt ends one agent loop)
  let ownRetries = 0;    // continues this extension returned in the current streak
  let waiting: { cancel: (why: string) => void } | null = null;

  const reset = () => { errStreak = 0; ownRetries = 0; };
  const cancel = (why: string) => { if (waiting) waiting.cancel(why); };

  pi.on("input", () => { cancel("input"); reset(); });
  pi.on("session_shutdown", () => cancel("shutdown"));

  pi.on("agent_end", (event: any) => {
    const msgs: any[] = Array.isArray(event?.messages) ? event.messages : [];
    let last: any;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "assistant") { last = msgs[i]; break; }
    if (last?.stopReason === "error") errStreak += 1;
    else if (last) reset();
  });

  pi.on("agent_before_settle", async (event: any, ctx: any) => {
    if (event?.outcome !== "error" || event?.continue) return;
    const bctx = event?.context ?? {};
    if (Array.isArray(bctx.pendingMessages) && bctx.pendingMessages.length > 0) return;
    const llm: any[] = Array.isArray(bctx.llmMessages) ? bctx.llmMessages : [];
    const last = llm[llm.length - 1];
    if (!last || last.role !== "assistant" || last.stopReason !== "error") return;
    const err = String(last.errorMessage ?? "").trim();
    const verdict = classify(err);
    if (verdict !== "throttle") return;
    const sessionId = (() => { try { return ctx?.sessionManager?.getSessionId?.(); } catch { return undefined; } })();
    const base = { session: sessionId, model: last.provider && last.model ? `${last.provider}/${last.model}` : undefined,
      error: err.slice(0, 200) };
    if (existsSync(KILL) || piRetryDisabled()) { ledger({ ...base, event: "disabled" }); return; }
    if (errStreak - 1 - ownRetries > 0) { ledger({ ...base, event: "skip-pi-retried", errStreak, ownRetries }); return; }
    const plan = delays();
    if (ownRetries >= plan.length) {
      ledger({ ...base, event: "cap", attempts: ownRetries });
      try { ctx?.ui?.notify?.(`provider still throttled after ${ownRetries} retries; stopped`, "warning"); } catch {}
      return;
    }
    // The failed attempt's session entry: the last message entry of the boundary projection (Pi 0.99 wraps each
    // projection row as {sourceEntry, messages}; a bare entry is accepted too). It must BE the failed attempt.
    const entries: any[] = Array.isArray(bctx.contextEntries) ? bctx.contextEntries : [];
    let target: any;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]?.sourceEntry ?? entries[i];
      if (e?.type === "message") {
        if (e.message?.role === "assistant" && e.message?.stopReason === "error" &&
            String(e.message?.errorMessage ?? "").trim() === err) target = e;
        break;
      }
    }
    if (!target?.id) { ledger({ ...base, event: "skip-no-entry" }); return; }

    const attempt = ownRetries + 1;
    const max = plan.length;
    const delayMs = plan[attempt - 1];
    ledger({ ...base, event: "scheduled", attempt, max, delayMs });
    const ui = ctx?.hasUI !== false ? ctx?.ui : undefined;
    const outcome: string = await new Promise<string>((resolve) => {
      const t0 = Date.now();
      let unsubKeys: (() => void) | undefined;
      const show = () => {
        const left = Math.max(0, Math.ceil((delayMs - (Date.now() - t0)) / 1000));
        try { ui?.setStatus?.(STATUS_KEY, `provider throttled; retry ${attempt}/${max} in ${left} s (type to cancel)`); } catch {}
      };
      const done = (why: string) => {
        if (!waiting) return;
        waiting = null;
        clearTimeout(timer); clearInterval(tick);
        try { unsubKeys?.(); } catch {}
        try { ui?.setStatus?.(STATUS_KEY, undefined); } catch {}
        resolve(why);
      };
      waiting = { cancel: done };
      const timer = setTimeout(() => done("elapsed"), delayMs);
      const tick = setInterval(show, 1000);
      show();
      try {
        unsubKeys = ui?.onTerminalInput?.((data: string) => {
          if (typeof data === "string" && data.length > 0 && !FOCUS_REPORT.test(data)) done("keystroke");
          return undefined;
        });
      } catch {}
      try {
        const sig: AbortSignal | undefined = ctx?.signal;
        if (sig?.aborted) done("abort"); else sig?.addEventListener?.("abort", () => done("abort"), { once: true });
      } catch {}
    });
    if (outcome !== "elapsed") { ledger({ ...base, event: "cancelled", attempt, reason: outcome }); return; }
    ownRetries = attempt;
    ledger({ ...base, event: "retried", attempt, max, delayMs, omitted: target.id });
    const prior: any[] = Array.isArray(event.entries) ? event.entries : [];
    return {
      entries: [
        ...prior,
        { type: "custom", customType: STATUS_KEY, data: { version: 1, attempt, max, delayMs, error: err.slice(0, 200), omitted: target.id } },
        { type: "context_edit", targetId: target.id, replacement: null },
      ],
      continue: true,
    };
  });
}
