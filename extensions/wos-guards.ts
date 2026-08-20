// Ported from the production `wos-guards.ts` extension.
// Preserved: result-time transient/no-match/partial-coverage gates; append-don't-replace evidence;
// terminal-message safety; explicit correction capture. Stripped: private incidents, paths,
// authority registry, personal mirror, and voice/length policy.
// @ts-nocheck

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { ensureState, updateState } from "../src/store.mjs";
import { recordProcessSignal } from "../src/domain.mjs";

const TRANSIENT = [
  /Input\/output error/i, /Resource temporarily unavailable/i, /Stale file handle/i,
  /Transport endpoint is not connected/i, /Connection reset|Connection refused|Broken pipe/i,
  /\brc=124\b|\bexit(?: code)? 124\b/i, /timed out|timeout after|Operation timed out/i,
  /Temporary failure in name resolution/i,
];
const SEARCHY = /\b(grep|rg|find|ls|fd|locate|glob|internal-rg)\b/;
const NO_MATCH = [/(?:^|\n)\s*(?:exit|rc)=1\s*\n?$/, /\bEXIT:? 1\b/, /No results found/i,
  /no matches found/i, /^\s*0\s*$/];
const PARTIAL = /Permission denied|cannot access|cannot open|Operation not permitted/i;

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
  pi.on("tool_result", async (event) => {
    const body = textOf(event.content);
    const command = commandOf(event);
    const notes: string[] = [];
    const failed = event.isError === true || /\bexit=[1-9]|\brc=[1-9]|\bEXIT:? *[1-9]/.test(body);

    if (failed && TRANSIENT.some((pattern) => pattern.test(body))) {
      notes.push("⚠ Transient-class failure. Retry with backoff before declaring anything broken, stale, or absent.");
    }
    const search = SEARCHY.test(command) || SEARCHY.test(String(event.toolName ?? ""));
    if (search && (body.trim() === "" || NO_MATCH.some((pattern) => pattern.test(body)))) {
      notes.push("⚠ No match bounds only the roots just searched. Name those roots before asserting absence; widen first when the claim is global.");
    }
    if (search && PARTIAL.test(body)) {
      notes.push("⚠ Partial coverage: part of the requested range was unreadable. Any absence claim must exclude it explicitly.");
    }
    if (!notes.length) return;
    const content = Array.isArray(event.content) ? [...event.content] : [{ type: "text", text: body }];
    content.push({ type: "text", text: `\n${notes.join("\n")}` });
    return { content };
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

// Export the exact predicates for replay tests. Tests must not copy a guard's regex.
export const __predicates = {
  transient: (body: string, isError: boolean) =>
    (isError || /\bexit=[1-9]|\brc=[1-9]|\bEXIT:? *[1-9]/.test(body)) && TRANSIENT.some((pattern) => pattern.test(body)),
  noMatch: (body: string, command: string, toolName: string) =>
    (SEARCHY.test(command) || SEARCHY.test(toolName)) && (body.trim() === "" || NO_MATCH.some((pattern) => pattern.test(body))),
  partialCoverage: (body: string, command: string, toolName: string) =>
    (SEARCHY.test(command) || SEARCHY.test(toolName)) && PARTIAL.test(body),
};
