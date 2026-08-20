// Wisdom OS Core — Pi-first adapter.
// Private local state by default. The TUI is a view; src/store.mjs remains the only writer.
// @ts-nocheck

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { activeContext, buildHandoff, computeButlerBrief, moveItem, recordProcessSignal, retrievePrecedents } from "../src/domain.mjs";
import { ensureState, readState, updateState, writeState } from "../src/store.mjs";

const READ_ONLY = /^(1|true|yes)$/i.test(process.env.WISDOM_OS_READ_ONLY ?? "");
const MAX_EVENTS = 500;
const MAX_RECEIPTS = 200;

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
}

function compact(value: unknown, limit = 1200): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function topEntity(state: any): { entityType: "decision" | "task"; entityId: string } | null {
  const active = activeContext(state);
  const task = active.tasks[0];
  if (task) return { entityType: "task", entityId: task.id };
  const decision = active.decisions[0];
  if (decision) return { entityType: "decision", entityId: decision.id };
  return null;
}

function contextBlock(state: any, prompt: string): string {
  const active = activeContext(state);
  const precedents = retrievePrecedents(state, prompt, 3);
  if (!active.decisions.length && !active.tasks.length && !precedents.length) return "";
  const lines = ["# Wisdom OS Core — durable project context"];
  for (const item of active.decisions) lines.push(`- DECISION [${item.stage}] ${item.id}: ${item.title}`);
  for (const item of active.tasks) lines.push(`- TASK [${item.stage}] ${item.id}: ${item.title} — acceptance: ${item.acceptance || "UNSET"}`);
  if (precedents.length) {
    lines.push("- PRECEDENTS (status is load-bearing; refuted evidence is retained):");
    for (const item of precedents) lines.push(`  - [${item.status}] ${item.id}: ${item.claim} · falsifier: ${item.falsifier || "UNSET"}`);
  }
  lines.push("Use `wisdom_os` to record a material decision, requirement delta, task, run, or handoff. Never mark BANK/DONE/LEARN on the human's behalf.");
  return lines.join("\n");
}

export default function wisdomOs(pi: ExtensionAPI) {
  let statePath = "";
  let injectedRevision = -1;
  let turnArtifacts = new Set<string>();
  let lastReceiptLeaf = "";

  async function ready(ctx: any) {
    if (!statePath) statePath = await ensureState(ctx.cwd);
    return statePath;
  }

  async function refreshStatus(ctx: any) {
    try {
      const path = await ready(ctx);
      const state = await readState(path);
      const findings = computeButlerBrief(state);
      const active = activeContext(state);
      const label = findings.length ? `WOS ${findings.length}⚑` : `WOS ${active.tasks.length}/${active.decisions.length}`;
      ctx.ui?.setStatus?.("wisdom-os-core", ctx.ui.theme.fg(findings.length ? "warning" : "muted", label));
    } catch {
      ctx.ui?.setStatus?.("wisdom-os-core", ctx.ui.theme.fg("error", "WOS ?"));
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode === "tui" || ctx.mode === "rpc") await refreshStatus(ctx);
  });

  // Capture what was typed, not an interpretation of it. Semantics remain explicit tool actions.
  pi.on("input", async (event, ctx) => {
    if (READ_ONLY || event.source === "extension" || event.text.trim().startsWith("/")) return;
    const path = await ready(ctx);
    await updateState(path, (state) => {
      state.events.push({ id: `e-${randomUUID()}`, type: "human-input", text: compact(event.text, 2000),
        sessionId: ctx.sessionManager.getSessionId?.(), createdAt: new Date().toISOString() });
      state.events = state.events.slice(-MAX_EVENTS);
      return state;
    });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const path = await ready(ctx);
    const state = await readState(path);
    if (state.revision === injectedRevision) return;
    const content = contextBlock(state, event.prompt);
    if (!content) return;
    injectedRevision = state.revision;
    return { message: { customType: "wisdom-os-context", content, display: false } };
  });

  // Evidence capture is deliberately narrow: artifact writes and failed commands only.
  pi.on("tool_execution_end", async (event, ctx) => {
    if (READ_ONLY || event.toolName === "wisdom_os") return;
    const args = event.args ?? {};
    const artifact = ["write", "edit"].includes(event.toolName) ? String(args.path ?? "") : "";
    const failed = event.isError === true;
    if (!artifact && !failed) return;
    if (artifact) turnArtifacts.add(artifact);
    const path = await ready(ctx);
    await updateState(path, (state) => {
      const entity = topEntity(state);
      state.runs.push({ id: `r-${randomUUID()}`, ...(entity ?? { entityType: "session", entityId: ctx.sessionManager.getSessionId?.() ?? "unknown" }),
        agent: "pi", command: event.toolName, result: failed ? "failed" : "completed",
        artifact, createdAt: new Date().toISOString() });
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
    const answer = compact(textOf(assistant?.message?.content), 1200);
    const path = await ready(ctx);
    await updateState(path, (state) => {
      state.receipts.push({ id: `receipt-${randomUUID()}`, sessionId: ctx.sessionManager.getSessionId?.(),
        answer, artifacts: [...turnArtifacts], createdAt: new Date().toISOString() });
      state.receipts = state.receipts.slice(-MAX_RECEIPTS);
      return state;
    });
    turnArtifacts = new Set();
    await refreshStatus(ctx);
  });

  pi.registerTool({
    name: "wisdom_os",
    label: "Wisdom OS",
    description: "Read or update durable decisions, tasks, feedback, evidence, handoffs, and precedents for this project. Consequential human gates cannot be bypassed.",
    promptSnippet: "Record material decisions, requirement deltas, tasks, evidence, and retrieve prior cases",
    promptGuidelines: [
      "Use wisdom_os when a user makes or changes a material decision, requirement, acceptance condition, or asks for durable project status.",
      "Use wisdom_os action record_correction when the user corrects the agent or a verifier rejects a claim; repeated classes automatically become harness improvement proposals.",
      "Do not use wisdom_os to mark a decision banked, a task done, case law changed, or a semantic harness proposal approved without explicit human action in the Wisdom OS TUI.",
    ],
    parameters: Type.Object({
      action: StringEnum(["status", "create_decision", "create_task", "feedback", "record_run", "record_correction", "propose_move", "handoff", "precedents"] as const),
      entityType: Type.Optional(StringEnum(["decision", "task"] as const)),
      id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      areaId: Type.Optional(Type.String()),
      decisionId: Type.Optional(Type.String()),
      priority: Type.Optional(StringEnum(["P0", "P1", "P2", "P3"] as const)),
      whyNow: Type.Optional(Type.String()),
      acceptance: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
      requirementDelta: Type.Optional(Type.String()),
      source: Type.Optional(Type.String()),
      stage: Type.Optional(Type.String()),
      result: Type.Optional(Type.String()),
      artifact: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      klass: Type.Optional(Type.String()),
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
        const state = await readState(path);
        const out = buildHandoff(state, params.entityType, params.id);
        if (!out) throw new Error(`Unknown ${params.entityType}:${params.id}`);
        return { content: [{ type: "text", text: out }], details: { statePath: path } };
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
            priority: params.priority ?? "P1", whyNow: params.whyNow ?? "", options: [], humanCall: "",
            owner: "", dueDate: "", resolvedPremise: "", reviewDate: "", outcome: "", review: "",
            caseLawUpdate: "", createdAt: now, updatedAt: now });
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
          const signal = { id: `signal-${randomUUID()}`, type: "correction", klass: params.klass,
            detail: params.note, semantic: params.semantic !== false, source: params.source ?? "human",
            createdAt: now };
          const before = state.improvements.length;
          state = recordProcessSignal(state, signal, 2, now);
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
      await refreshStatus(ctx);
      return { content: [{ type: "text", text: `${message}\nstate: ${path}` }], details: { statePath: path } };
    },
  });

  pi.registerCommand("wos", {
    description: "Wisdom OS TUI: /wos · decide <id> · verify <id> · learn <id> · precedent <case> <decision> · improve <id> · shared · path",
    handler: async (args, ctx) => {
      const path = await ready(ctx);
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "path") { ctx.ui.notify(path, "info"); return; }
      if (["decide", "verify", "learn", "precedent", "improve"].includes(parts[0]) && !ctx.hasUI) {
        ctx.ui.notify("This human gate requires Pi TUI mode", "error"); return;
      }
      if (parts[0] === "improve" && parts[1]) {
        const state = await readState(path);
        const improvement = state.improvements.find((item) => item.id === parts[1]);
        if (!improvement) { ctx.ui.notify(`improvement not found: ${parts[1]}`, "error"); return; }
        const choice = await ctx.ui.select("Harness improvement", ["approve canary", "disable proposal"]);
        if (!choice) return;
        await updateState(path, (next) => {
          const item = next.improvements.find((entry) => entry.id === improvement.id);
          item.updatedAt = new Date().toISOString();
          if (choice === "disable proposal") { item.stage = "disabled"; item.disabledReason = "human rejected"; return next; }
          item.approvedByHuman = true;
          const taskId = `task-${improvement.id}`;
          if (!next.tasks.some((task) => task.id === taskId)) {
            next.tasks.push({ id: taskId, title: improvement.title, areaId: "", decisionId: "",
              stage: "ready", priority: improvement.priority ?? "P1",
              acceptance: `Control has a regression test, rollback, quality auto-disable, independent verifier, and reduces ${improvement.klass} in canary without creating a new human inbox.`,
              maker: "", evidence: "", verifier: "", verification: "", acceptedByHuman: false,
              blockedReason: "", owner: "", dueDate: "", improvementId: improvement.id,
              createdAt: item.updatedAt, updatedAt: item.updatedAt });
          }
          return next;
        });
        ctx.ui.notify(`${improvement.id} → ${choice}`, "info"); await refreshStatus(ctx); return;
      }
      if (parts[0] === "decide" && parts[1]) {
        const state = await readState(path);
        const decision = state.decisions.find((item) => item.id === parts[1]);
        if (!decision) { ctx.ui.notify(`decision not found: ${parts[1]}`, "error"); return; }
        const humanCall = await ctx.ui.input("Human call", "What was chosen?");
        if (!humanCall) return;
        const owner = await ctx.ui.input("Owner", decision.owner || "Who owns the outcome?");
        const dueDate = await ctx.ui.input("Review date", decision.dueDate || "YYYY-MM-DD");
        const resolvedPremise = await ctx.ui.input("Resolved premise", "What uncertainty did this call settle?");
        if (!owner || !dueDate || !resolvedPremise) { ctx.ui.notify("BANK requires all four fields", "warning"); return; }
        await updateState(path, (next) => {
          const item = next.decisions.find((entry) => entry.id === decision.id);
          Object.assign(item, { humanCall, owner, dueDate, resolvedPremise });
          const moved = moveItem(next, "decision", decision.id, { stage: "bank" });
          if (!moved.ok) throw new Error(`BANK blocked: ${moved.missing.join(", ")}`);
          return moved.state;
        });
        ctx.ui.notify(`${decision.id} → BANK`, "info"); await refreshStatus(ctx); return;
      }
      if (parts[0] === "verify" && parts[1]) {
        const state = await readState(path);
        const task = state.tasks.find((item) => item.id === parts[1]);
        if (!task) { ctx.ui.notify(`task not found: ${parts[1]}`, "error"); return; }
        const evidence = task.evidence || await ctx.ui.input("Evidence", "Artifact or reproducing result");
        const maker = task.maker || await ctx.ui.input("Maker", "Who produced it?");
        const verifier = await ctx.ui.input("Independent verifier", "Must differ from maker");
        const verification = await ctx.ui.input("Verification result", "What was independently checked?");
        if (!evidence || !maker || !verifier || !verification || verifier.trim() === maker.trim()) {
          ctx.ui.notify("DONE requires evidence and a verifier different from maker", "warning"); return;
        }
        const accepted = await ctx.ui.confirm("Human acceptance", `Accept ${task.title} as DONE?`);
        if (!accepted) return;
        await updateState(path, (next) => {
          const item = next.tasks.find((entry) => entry.id === task.id);
          Object.assign(item, { evidence, maker, verifier, verification, acceptedByHuman: true });
          const moved = moveItem(next, "task", task.id, { stage: "done" });
          if (!moved.ok) throw new Error(`DONE blocked: ${moved.missing.join(", ")}`);
          return moved.state;
        });
        ctx.ui.notify(`${task.id} → DONE`, "info"); await refreshStatus(ctx); return;
      }
      if (parts[0] === "learn" && parts[1]) {
        const state = await readState(path);
        const decision = state.decisions.find((item) => item.id === parts[1]);
        if (!decision) { ctx.ui.notify(`decision not found: ${parts[1]}`, "error"); return; }
        const outcome = await ctx.ui.input("Observed outcome", "What happened?");
        const review = await ctx.ui.input("Review", "What did the evidence teach?");
        const disposition = await ctx.ui.select("Case-law disposition", ["strengthened", "amended", "refuted"]);
        const claim = await ctx.ui.input("Case claim", decision.resolvedPremise || decision.title);
        const falsifier = await ctx.ui.input("Falsifier", "What future evidence would make this wrong?");
        if (!outcome || !review || !disposition || !claim || !falsifier) return;
        await updateState(path, (next) => {
          const item = next.decisions.find((entry) => entry.id === decision.id);
          Object.assign(item, { outcome, review, caseLawUpdate: disposition });
          const moved = moveItem(next, "decision", decision.id, { stage: "learn" });
          if (!moved.ok) throw new Error(`LEARN blocked: ${moved.missing.join(", ")}`);
          const caseId = `case-${decision.id}`;
          const existing = moved.state.cases.find((entry) => entry.id === caseId);
          const caseItem = { id: caseId, claim, scope: {}, sourceDecisionIds: [decision.id],
            expectedOutcome: decision.resolvedPremise || "", observedOutcome: outcome,
            reviewDate: decision.reviewDate || decision.dueDate || "", status: disposition === "refuted" ? "refuted" : disposition === "amended" ? "amended" : "active",
            confidence: "medium", falsifier, updatedAt: new Date().toISOString() };
          if (existing) Object.assign(existing, caseItem); else moved.state.cases.push(caseItem);
          return moved.state;
        });
        ctx.ui.notify(`${decision.id} → LEARN · case ${disposition}`, disposition === "refuted" ? "warning" : "info");
        await refreshStatus(ctx); return;
      }
      if (parts[0] === "precedent" && parts[1] && parts[2]) {
        const effect = await ctx.ui.select("How did this precedent affect the decision?", ["changed", "challenged", "confirmed"]);
        if (!effect) return;
        await updateState(path, (state) => {
          if (!state.cases.some((item) => item.id === parts[1])) throw new Error(`case not found: ${parts[1]}`);
          if (!state.decisions.some((item) => item.id === parts[2])) throw new Error(`decision not found: ${parts[2]}`);
          state.precedentUses.push({ id: `precedent-${randomUUID()}`, caseId: parts[1], decisionId: parts[2], effect, at: new Date().toISOString() });
          return state;
        });
        ctx.ui.notify(`precedent recorded: ${effect}`, "info"); return;
      }
      if (parts[0] === "shared") {
        if (READ_ONLY) { ctx.ui.notify("read-only session", "warning"); return; }
        const shared = join(ctx.cwd, ".wisdom-os", "state.json");
        await mkdir(join(ctx.cwd, ".wisdom-os"), { recursive: true });
        try { await stat(shared); } catch { await writeState(shared, await readState(path)); }
        statePath = shared;
        ctx.ui.notify(`project-shared state: ${shared}`, "info");
        await refreshStatus(ctx);
        return;
      }
      if (parts[0] === "handoff" && parts[1] && parts[2]) {
        const out = buildHandoff(await readState(path), parts[1], parts[2]);
        if (!out) { ctx.ui.notify("handoff target not found", "error"); return; }
        ctx.ui.setEditorText(out);
        return;
      }

      const state = await readState(path);
      const findings = computeButlerBrief(state);
      const active = activeContext(state);
      const rows = [
        ...findings.map((x) => ({ value: `${x.entityType}:${x.entityId}`, label: `⚑ ${x.priority} ${x.title}`, description: x.message })),
        ...active.tasks.map((x) => ({ value: `task:${x.id}`, label: `□ [${x.stage}] ${x.title}`, description: x.acceptance || "acceptance UNSET" })),
        ...active.decisions.map((x) => ({ value: `decision:${x.id}`, label: `◇ [${x.stage}] ${x.title}`, description: x.whyNow || "why-now UNSET" })),
      ];
      if (!rows.length) rows.push({ value: "none", label: "SILENT — no active work or P0 judgment", description: path });
      await ctx.ui.custom((tui, theme, _kb, done) => {
        const box = new Container();
        box.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        box.addChild(new Text(theme.fg("accent", theme.bold(`Wisdom OS · revision ${state.revision}`)), 1, 0));
        box.addChild(new Text(theme.fg("muted", path), 1, 0));
        const list = new SelectList(rows, Math.min(rows.length, 12), {
          selectedPrefix: (s: string) => theme.fg("accent", s), selectedText: (s: string) => theme.fg("accent", s),
          description: (s: string) => theme.fg("muted", s), scrollInfo: (s: string) => theme.fg("dim", s),
          noMatch: (s: string) => theme.fg("warning", s),
        });
        list.onSelect = () => done(undefined); list.onCancel = () => done(undefined);
        box.addChild(list); box.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return { render: (width: number) => box.render(width), invalidate: () => box.invalidate(),
          handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); } };
      }, { overlay: true, overlayOptions: { width: "90%", minWidth: 60, maxHeight: "80%" } });
    },
  });
}
