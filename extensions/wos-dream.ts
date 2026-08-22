// A53-c9/c10 — the continuous-improvement ("dream") loop as a Pi extension.
//
// The kernel is `../src/dream.mjs`; this file is only the adapter that decides WHEN it runs and
// makes sure it never costs the user a turn.
//
// FOREGROUND RULES, in order of how expensive violating them has been:
//   · nothing heavy at extension startup — load time is paid by every session, forever;
//   · the loop runs on `agent_settled` and only when `ctx.isIdle()`, never mid-turn;
//   · it is detached from the settle handler, so a slow run cannot hold the turn open;
//   · it is wrapped fail-open — a background improvement loop must never surface its own crash;
//   · one file switches it off: WISDOM_OS_DREAM_OFF.
//
// It emits PROPOSALS into the collection the Butler already reads. It never applies one.
// @ts-nocheck

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureState, readState, updateState } from "../src/store.mjs";
import { failOpen, killSwitch } from "../src/safety.mjs";
import {
  applyQualityVerdict, canApply, coalesce, DREAM_DEFAULTS, emit, emptyDream,
  propose, qualityVerdict, selectEvents, shouldRun,
} from "../src/dream.mjs";

const READ_ONLY = /^(1|true|yes)$/i.test(process.env.WISDOM_OS_READ_ONLY ?? "");
const OFF_SENTINEL = process.env.WISDOM_OS_DREAM_OFF ?? "";
const disabled = OFF_SENTINEL ? killSwitch(OFF_SENTINEL) : () => false;

const numeric = (name: string, fallback: number) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

// Bounds are configuration, never policy baked into the mechanism.
const BOUNDS = {
  ...DREAM_DEFAULTS,
  turnsPerRun: numeric("WISDOM_OS_DREAM_TURNS", DREAM_DEFAULTS.turnsPerRun),
  minMinutesBetweenRuns: numeric("WISDOM_OS_DREAM_MINUTES", DREAM_DEFAULTS.minMinutesBetweenRuns),
  maxRunsPerSession: numeric("WISDOM_OS_DREAM_MAX_RUNS", DREAM_DEFAULTS.maxRunsPerSession),
};

export default function dream(pi: ExtensionAPI) {
  let lastRunSummary = "not run yet in this session";
  let running = false;

  const cycle = failOpen(async (ctx: any) => {
    if (running) return;                       // one run at a time; a queue here is a runaway
    running = true;
    try {
      const path = await ensureState(ctx?.cwd);
      const before = await readState(path);

      // The loop judges its own output before producing more of it. If humans keep disabling what
      // it proposes it is manufacturing work, and it turns itself off rather than being turned off.
      const verdict = qualityVerdict(before, BOUNDS);
      if (verdict.disable) {
        if (!verdict.already) {
          await updateState(path, (state) => applyQualityVerdict(state, verdict));
          lastRunSummary = `AUTO-DISABLED — ${verdict.reason}`;
        }
        return;
      }

      const now = new Date().toISOString();
      const pendingCorrections = (before.processSignals ?? [])
        .filter((row: any) => row?.type === "correction" && row?.producedBy !== "dream").length;
      const decision = shouldRun(before.dream, { now, pendingCorrections, bounds: BOUNDS });
      if (!decision.run) { lastRunSummary = `idle — ${decision.reason}`; return; }

      await updateState(path, (state) => {
        const input = selectEvents(state, BOUNDS);
        const candidates = propose({ signals: input.signals, cases: input.cases,
          precedentUses: input.precedentUses, now, bounds: BOUNDS });
        const { fresh, strengthened } = coalesce(candidates, input.existing);
        lastRunSummary = fresh.length || strengthened.length
          ? `${decision.trigger}: ${fresh.length} new, ${strengthened.length} strengthened`
          : `${decision.trigger}: nothing new — silence`;
        return emit(state, { trigger: decision.trigger, proposals: fresh, strengthened, now, bounds: BOUNDS });
      });
    } finally {
      running = false;
    }
  });

  pi.on("session_start", async (_event, _ctx) => {
    // Startup does no work at all. It resets a counter and returns.
    lastRunSummary = "not run yet in this session";
  });

  pi.on("agent_settled", failOpen(async (_event, ctx) => {
    if (READ_ONLY || disabled() || ctx.isIdle?.() !== true) return;
    await updateState(await ensureState(ctx?.cwd), (state) => {
      const current = { ...emptyDream(), ...(state.dream ?? {}) };
      return { ...state, dream: { ...current, cursor: { ...current.cursor, turns: (current.cursor?.turns ?? 0) + 1 } } };
    });
    // Detached on purpose: the settle handler returns immediately and the loop runs after it.
    setTimeout(() => { void cycle(ctx); }, 0);
  }));

  pi.registerCommand("dream", {
    description: "Show the continuous-improvement loop: last run, bounds, and open proposals",
    handler: async (_args, ctx) => {
      const path = await ensureState(ctx.cwd);
      const state = await readState(path);
      const mine = (state.improvements ?? []).filter((item: any) => item.producedBy === "dream");
      const open = mine.filter((item: any) => item.stage === "proposed");
      const lines = [
        `loop: ${state.dream?.disabled ? `DISABLED — ${state.dream.disabledReason}` : "live"}`,
        `last: ${lastRunSummary}`,
        `bounds: every ${BOUNDS.turnsPerRun} turns · ≥${BOUNDS.minMinutesBetweenRuns}m apart · ≤${BOUNDS.maxRunsPerSession}/session · ≤${BOUNDS.maxProposalsPerRun}/run`,
        `runs journalled: ${(state.dream?.runs ?? []).length} · proposals: ${open.length} open of ${mine.length}`,
      ];
      for (const item of open.slice(0, BOUNDS.maxProposalsPerRun)) {
        const gate = canApply(item);
        lines.push(`  [${item.verb}] ${item.subject}`);
        lines.push(`      landing: ${item.landing}`);
        lines.push(`      proof:   ${item.proof}`);
        lines.push(`      cost:    ${item.cost}`);
        lines.push(`      blocked on: ${gate.ok ? "nothing — awaiting /wos improve" : gate.missing.join(", ")}`);
      }
      if (!open.length) lines.push("  SILENT — no proposal needs a human call.");
      pi.sendMessage({ customType: "wisdom-os-dream", content: lines.join("\n"), display: true },
        { deliverAs: "nextTurn" });
    },
  });
}
