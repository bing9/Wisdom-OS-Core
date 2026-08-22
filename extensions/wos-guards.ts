// Ported from the production `wos-guards.ts` extension.
// Preserved: result-time transient/no-match/partial-coverage gates; append-don't-replace evidence;
// explicit correction capture; gate manifest and gate telemetry carrying real-vs-synthetic
// provenance. Stripped: private incidents, paths, authority registry, personal mirror, and
// voice/length policy.
//
// TERMINAL-MESSAGE SAFETY (corrected 2026-08-22): this file previously claimed to preserve it and
// did not — it registers no `message_end` handler, so there was nothing to protect. The predicate
// itself is now shipped in `../src/safety.mjs` (`mayAppendTo` / `isTerminalMessage`) and
// `scripts/release-check.mjs` fails any extension that rewrites an assistant message without it.
// The private incident that paid for the predicate is recorded in that module's header.
// @ts-nocheck

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { ensureState, updateState } from "../src/store.mjs";
import { recordProcessSignal } from "../src/domain.mjs";
import { appendNote, failOpen, killSwitch } from "../src/safety.mjs";
import { gateEvent, logGate, writeManifest } from "../src/gatelog.mjs";
import { evaluateGates, GATE_IDS } from "../src/guard-predicates.mjs";

// One file disables every gate in this extension immediately.
const OFF_SENTINEL = process.env.WISDOM_OS_GUARDS_OFF ?? "";
const disabled = OFF_SENTINEL ? killSwitch(OFF_SENTINEL) : () => false;
const SYNTHETIC = /^(1|true|yes)$/i.test(process.env.WISDOM_OS_GUARD_TEST ?? "");

// Declared gates, keyed off the predicate module's own id list so a gate cannot be implemented
// without being declared, or declared without existing. `release-check` asserts the two agree.
export const GATES = GATE_IDS.map((id) => ({ id, hook: "tool_result", shipped: "2026-08-19" }));

// The predicates live in ../src/guard-predicates.mjs so the test suite can import the SHIPPED
// implementation. A regex re-declared here and again in a test proves only that the copy works.
const NOTES: Record<string, string> = {
  "transient-class-failure":
    "⚠ Transient-class failure. Retry with backoff before declaring anything broken, stale, or absent.",
  "absence-from-partial-search":
    "⚠ No match bounds only the roots just searched. Name those roots before asserting absence; widen first when the claim is global.",
  "partial-coverage":
    "⚠ Partial coverage: part of the requested range was unreadable. Any absence claim must exclude it explicitly.",
};

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
}
function commandOf(event: any): string {
  const input = event.input ?? {};
  return String(input.command ?? input.pattern ?? input.path ?? event.toolName ?? "");
}

export default function guards(pi: ExtensionAPI) {
  let gatePaths: { log: string; manifest: string } | null = null;

  // Resolved lazily and never in extension startup: long work at load time delays every session.
  const resolveGatePaths = failOpen(async (ctx: any) => {
    if (gatePaths) return gatePaths;
    const dir = dirname(await ensureState(ctx?.cwd));
    gatePaths = { log: join(dir, "gate-events.jsonl"), manifest: join(dir, "gate-manifest.json") };
    await writeManifest(gatePaths.manifest, GATES);
    return gatePaths;
  }, { fallback: null });

  // Telemetry is fail-open by construction: a gate that cannot record its own hit still fires.
  const record = failOpen(async (ctx: any, gateId: string, detail: string, command: string) => {
    const paths = await resolveGatePaths(ctx);
    if (!paths) return;
    await logGate(paths.log, gateEvent({ gateId, detail, command, synthetic: SYNTHETIC }));
  });

  pi.on("tool_result", async (event, ctx) => {
    if (disabled()) return;
    const body = textOf(event.content);
    const command = commandOf(event);
    const fired = evaluateGates({ body, command, toolName: String(event.toolName ?? ""), isError: event.isError === true });
    const notes = fired.map((gateId) => NOTES[gateId]).filter(Boolean);
    if (!notes.length) return;
    for (const gateId of fired) await record(ctx, gateId, body.slice(-160), command);
    // Append, never replace: the evidence a gate reads is the evidence the reader still needs.
    // Normalised to blocks first — a tool result is always returned to Pi in block form.
    const blocks = Array.isArray(event.content) ? event.content : [{ type: "text", text: body }];
    return { content: appendNote(blocks, `\n${notes.join("\n")}`) };
  });

  // The user or model may name a semantic class explicitly. Two instances open governed
  // improvement work through the same kernel; this command never edits policy or ships a control.
  pi.registerCommand("correction", {
    description: "Record a recurring process correction: /correction <class> <what was wrong>",
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim();
      const split = raw.indexOf(" ");
      if (split < 1) { ctx.ui.notify("usage: /correction <class> <what was wrong>", "info"); return; }
      const klass = raw.slice(0, split);
      const detail = raw.slice(split + 1).trim();
      const path = await ensureState(ctx.cwd);
      let created = "";
      await updateState(path, (state) => {
        const before = state.improvements.length;
        state = recordProcessSignal(state, { id: `signal-${randomUUID()}`, type: "correction", klass,
          detail, semantic: true, source: "human", createdAt: new Date().toISOString() });
        if (state.improvements.length > before) created = state.improvements.at(-1)?.id ?? "";
        return state;
      });
      ctx.ui.notify(created ? `correction recorded; opened ${created}` : `correction recorded: ${klass}`, "info");
    },
  });
}

// Re-exported so a replay test can reach the SHIPPED predicates through the extension it is
// testing. Until 2026-08-22 this block re-declared each regex inline: a test importing it would
// have exercised a second copy while the handler used the first. The predicates now have exactly
// one home, `../src/guard-predicates.mjs`, and both this file and the tests import it.
export { evaluateGates, noMatch, partialCoverage, transient } from "../src/guard-predicates.mjs";
