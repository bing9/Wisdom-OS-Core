// Ported from the production `wos-butler.ts` extension.
// Preserved: first-turn continuity injection, stale-free read path, quiet status, explicit command.
// Replaced: private WOS paths/authority/cron with Wisdom OS Core's portable local store.
// @ts-nocheck

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { activeContext, buildHandoff, computeButlerBrief, moveItem, recordProcessSignal, retrievePrecedents } from "../src/domain.mjs";
import { ensureState, readState, updateState } from "../src/store.mjs";
import { compact, contextBlock, textOf, topEntity } from "../src/pi-context.mjs";

const READ_ONLY = /^(1|true|yes)$/i.test(process.env.WISDOM_OS_READ_ONLY ?? "");
const MAX_EVENTS = 500;
const MAX_RECEIPTS = 200;

export default function butler(pi: ExtensionAPI) {
  let statePath = "";
  let injectedRevision = -1;
  let turnArtifacts = new Set<string>();
  let lastReceiptLeaf = "";

  async function ready(ctx: any) {
    // Resolve every time so `/wos shared` takes effect in the current session too.
    statePath = await ensureState(ctx.cwd);
    return statePath;
  }

  async function status(ctx: any) {
    try {
      const state = await readState(await ready(ctx));
      const findings = computeButlerBrief(state);
      const active = activeContext(state);
      const label = findings.length ? `WOS ${findings.length}⚑` : `WOS ${active.tasks.length}/${active.decisions.length}`;
      ctx.ui?.setStatus?.("wisdom-os-core", ctx.ui.theme.fg(findings.length ? "warning" : "muted", label));
    } catch {
      ctx.ui?.setStatus?.("wisdom-os-core", ctx.ui.theme.fg("error", "WOS ?"));
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    injectedRevision = -1;
    if (ctx.mode === "tui" || ctx.mode === "rpc") await status(ctx);
  });

  // Raw capture happens at the keystroke boundary. It records words, never invented semantics.
  pi.on("input", async (event, ctx) => {
    if (READ_ONLY || event.source === "extension" || event.text.trim().startsWith("/")) return;
    await updateState(await ready(ctx), (state) => {
      state.events.push({ id: `e-${randomUUID()}`, type: "human-input", text: compact(event.text, 2000),
        sessionId: ctx.sessionManager.getSessionId?.(), createdAt: new Date().toISOString() });
      state.events = state.events.slice(-MAX_EVENTS);
      return state;
    });
  });

  // Same contract as private wos-butler: read precomputed durable state; never perform heavy work
  // in the user's turn. Unlike that private adapter, the portable state is cheap and direct.
  pi.on("before_agent_start", async (event, ctx) => {
    const state = await readState(await ready(ctx));
    if (state.revision === injectedRevision) return;
    const content = contextBlock(state, event.prompt);
    if (!content) return;
    injectedRevision = state.revision;
    return { message: { customType: "wisdom-os-context", content, display: false } };
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (READ_ONLY || event.toolName === "wisdom_os") return;
    const args = event.args ?? {};
    const artifact = ["write", "edit"].includes(event.toolName) ? String(args.path ?? "") : "";
    const failed = event.isError === true;
    if (!artifact && !failed) return;
    if (artifact) turnArtifacts.add(artifact);
    await updateState(await ready(ctx), (state) => {
      const entity = topEntity(state);
      state.runs.push({ id: `r-${randomUUID()}`, ...(entity ?? { entityType: "session", entityId: ctx.sessionManager.getSessionId?.() ?? "unknown" }),
        agent: "pi", command: event.toolName, result: failed ? "failed" : "completed", artifact,
        createdAt: new Date().toISOString() });
      return state;
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (READ_ONLY || ctx.isIdle?.() !== true) return;
    const leaf = String(ctx.sessionManager.getLeafId?.() ?? "");
    if (leaf && leaf === lastReceiptLeaf) return;
    lastReceiptLeaf = leaf;
    const entries = ctx.sessionManager.getBranch?.() ?? [];
    const assistant = [...entries].reverse().find((entry: any) => entry.type === "message" && entry.message?.role === "assistant");
    await updateState(await ready(ctx), (state) => {
      state.receipts.push({ id: `receipt-${randomUUID()}`, sessionId: ctx.sessionManager.getSessionId?.(),
        answer: compact(textOf(assistant?.message?.content), 1200), artifacts: [...turnArtifacts],
        createdAt: new Date().toISOString() });
      state.receipts = state.receipts.slice(-MAX_RECEIPTS);
      return state;
    });
    turnArtifacts = new Set();
    await status(ctx);
  });

  pi.registerTool({
    name: "wisdom_os",
    label: "Wisdom OS",
    description: "Read or update durable project decisions, tasks, feedback, corrections, evidence, handoffs, and precedents. Human gates cannot be bypassed.",
    promptSnippet: "Record material decisions, requirements, corrections, evidence, and retrieve precedents",
    promptGuidelines: [
      "Use wisdom_os when the user makes or changes a material decision, requirement, acceptance condition, or asks for durable project status.",
      "Use wisdom_os action record_correction when the user corrects the agent or a verifier rejects a claim; repeated classes become harness-improvement work.",
      "Never use wisdom_os to mark BANK, DONE, LEARN, or a semantic harness proposal approved; those are explicit human TUI actions.",
    ],
    parameters: Type.Object({
      action: StringEnum(["status", "create_decision", "create_task", "feedback", "record_run", "record_correction", "propose_move", "handoff", "precedents"] as const),
      entityType: Type.Optional(StringEnum(["decision", "task"] as const)), id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()), areaId: Type.Optional(Type.String()), decisionId: Type.Optional(Type.String()),
      priority: Type.Optional(StringEnum(["P0", "P1", "P2", "P3"] as const)), whyNow: Type.Optional(Type.String()),
      acceptance: Type.Optional(Type.String()), note: Type.Optional(Type.String()), requirementDelta: Type.Optional(Type.String()),
      source: Type.Optional(Type.String()), stage: Type.Optional(Type.String()), result: Type.Optional(Type.String()),
      artifact: Type.Optional(Type.String()), query: Type.Optional(Type.String()), klass: Type.Optional(Type.String()),
      semantic: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const path = await ready(ctx);
      if (params.action === "status") {
        const state = await readState(path);
        return { content: [{ type: "text", text: JSON.stringify({ statePath: path, revision: state.revision,
          active: activeContext(state), findings: computeButlerBrief(state) }, null, 2) }], details: { statePath: path } };
      }
      if (params.action === "handoff") {
        const output = buildHandoff(await readState(path), params.entityType, params.id);
        if (!output) throw new Error(`Unknown ${params.entityType}:${params.id}`);
        return { content: [{ type: "text", text: output }], details: { statePath: path } };
      }
      if (params.action === "precedents") {
        const hits = retrievePrecedents(await readState(path), params.query ?? params.title ?? "", 5);
        return { content: [{ type: "text", text: JSON.stringify(hits, null, 2) }], details: { count: hits.length } };
      }
      if (READ_ONLY) throw new Error("Wisdom OS is read-only in this session");

      let message = "";
      await updateState(path, (state) => {
        const now = new Date().toISOString();
        if (params.action === "create_decision") {
          if (!params.title) throw new Error("create_decision requires title");
          const id = params.id ?? `decision-${randomUUID()}`;
          state.decisions.push({ id, title: params.title, areaId: params.areaId ?? "", stage: "sense",
            priority: params.priority ?? "P1", whyNow: params.whyNow ?? "", options: [], humanCall: "", owner: "",
            dueDate: "", resolvedPremise: "", reviewDate: "", outcome: "", review: "", caseLawUpdate: "",
            createdAt: now, updatedAt: now });
          message = `created decision:${id}`;
        } else if (params.action === "create_task") {
          if (!params.title || !params.acceptance) throw new Error("create_task requires title and acceptance");
          const id = params.id ?? `task-${randomUUID()}`;
          state.tasks.push({ id, title: params.title, areaId: params.areaId ?? "", decisionId: params.decisionId ?? "",
            stage: "ready", priority: params.priority ?? "P1", acceptance: params.acceptance, maker: "", evidence: "",
            verifier: "", verification: "", acceptedByHuman: false, blockedReason: "", owner: "", dueDate: "",
            createdAt: now, updatedAt: now });
          message = `created task:${id}`;
        } else if (params.action === "feedback") {
          if (!params.entityType || !params.id || !params.note) throw new Error("feedback requires entityType, id, note");
          state.feedback.push({ id: `f-${randomUUID()}`, entityType: params.entityType, entityId: params.id,
            source: params.source ?? "human", note: params.note, requirementDelta: params.requirementDelta ?? "", createdAt: now });
          message = `feedback logged for ${params.entityType}:${params.id}`;
        } else if (params.action === "record_run") {
          if (!params.entityType || !params.id || !params.result) throw new Error("record_run requires entityType, id, result");
          state.runs.push({ id: `r-${randomUUID()}`, entityType: params.entityType, entityId: params.id, agent: "pi",
            command: params.note ?? "", result: params.result, artifact: params.artifact ?? "", createdAt: now });
          message = `run logged for ${params.entityType}:${params.id}`;
        } else if (params.action === "record_correction") {
          if (!params.klass || !params.note) throw new Error("record_correction requires klass and note");
          const before = state.improvements.length;
          state = recordProcessSignal(state, { id: `signal-${randomUUID()}`, type: "correction", klass: params.klass,
            detail: params.note, semantic: params.semantic !== false, source: params.source ?? "human", createdAt: now }, 2, now);
          const created = state.improvements.length > before ? state.improvements.at(-1)?.id : "";
          message = created ? `correction recorded; recurring class opened ${created}` : `correction recorded: ${params.klass}`;
        } else if (params.action === "propose_move") {
          if (!params.entityType || !params.id || !params.stage) throw new Error("propose_move requires entityType, id, stage");
          if (["bank", "done", "learn"].includes(params.stage)) throw new Error(`${params.stage} requires explicit human action in /wos`);
          const moved = moveItem(state, params.entityType, params.id, { stage: params.stage });
          if (!moved.ok) throw new Error(`Blocked by gate: ${moved.missing.join(", ")}`);
          message = `moved ${params.entityType}:${params.id} -> ${params.stage}`;
          return moved.state;
        }
        return state;
      });
      await status(ctx);
      return { content: [{ type: "text", text: `${message}\nstate: ${path}` }], details: { statePath: path } };
    },
  });

  pi.registerCommand("butler", {
    description: "Show Wisdom OS Core's top three findings and active work",
    handler: async (_args, ctx) => {
      const path = await ready(ctx);
      const state = await readState(path);
      const findings = computeButlerBrief(state);
      const active = activeContext(state);
      const lines = findings.length
        ? findings.map((item) => `${item.priority} ${item.type} · ${item.title}`).slice(0, 3)
        : ["SILENT — no P0 judgment needed."];
      lines.push(`active: ${active.tasks.length} task(s) · ${active.decisions.length} decision(s)`);
      pi.sendMessage({ customType: "wisdom-os-butler", content: lines.join("\n"), display: true }, { deliverAs: "nextTurn" });
      ctx.ui?.notify?.(`Wisdom OS: ${path}`, "info");
    },
  });
}
