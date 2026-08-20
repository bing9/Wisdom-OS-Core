// Ported from the production `wos-lane.ts` extension.
// Preserved: compact overlay, human-authored reasons, explicit irreversible gates, UI-as-view.
// Replaced: personal queues, names, Python commands, citations, and private paths with the portable
// Wisdom OS Core store and domain gates.
// @ts-nocheck

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { activeContext, buildHandoff, computeButlerBrief, moveItem } from "../src/domain.mjs";
import { ensureState, readState, updateState, writeState } from "../src/store.mjs";

const READ_ONLY = /^(1|true|yes)$/i.test(process.env.WISDOM_OS_READ_ONLY ?? "");

function listTheme(theme: any) {
  return {
    selectedPrefix: (s: string) => theme.fg("accent", s),
    selectedText: (s: string) => theme.fg("accent", s),
    description: (s: string) => theme.fg("muted", s),
    scrollInfo: (s: string) => theme.fg("dim", s),
    noMatch: (s: string) => theme.fg("warning", s),
  };
}

async function showOverview(ctx: any, statePath: string, state: any) {
  const findings = computeButlerBrief(state);
  const active = activeContext(state);
  const rows: SelectItem[] = [
    ...findings.map((x: any) => ({ value: `${x.entityType}:${x.entityId}`, label: `⚑ ${x.priority} ${x.title}`, description: x.message })),
    ...active.tasks.map((x: any) => ({ value: `task:${x.id}`, label: `□ [${x.stage}] ${x.title}`, description: x.acceptance || "acceptance UNSET" })),
    ...active.decisions.map((x: any) => ({ value: `decision:${x.id}`, label: `◇ [${x.stage}] ${x.title}`, description: x.whyNow || "why-now UNSET" })),
  ];
  if (!rows.length) rows.push({ value: "none", label: "SILENT — no active work or P0 judgment", description: statePath });
  await ctx.ui.custom((tui: any, theme: any, _kb: any, done: any) => {
    const box = new Container();
    box.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    box.addChild(new Text(theme.fg("accent", theme.bold(`Wisdom OS · revision ${state.revision}`)), 1, 0));
    box.addChild(new Text(theme.fg("muted", statePath), 1, 0));
    const list = new SelectList(rows, Math.min(rows.length, 12), listTheme(theme));
    list.onSelect = () => done(undefined); list.onCancel = () => done(undefined);
    box.addChild(list); box.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    return { render: (width: number) => box.render(width), invalidate: () => box.invalidate(),
      handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); } };
  }, { overlay: true, overlayOptions: { width: "90%", minWidth: 60, maxHeight: "80%" } });
}

export default function decisionUi(pi: ExtensionAPI) {
  async function statePath(ctx: any) { return ensureState(ctx.cwd); }
  function writable(ctx: any) {
    if (!READ_ONLY) return true;
    ctx.ui.notify("Wisdom OS is read-only in this session", "warning");
    return false;
  }

  pi.registerCommand("wos", {
    description: "Wisdom OS TUI: overview · decide · verify · learn · precedent · improve · handoff · shared · path",
    handler: async (args: string, ctx: any) => {
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const path = await statePath(ctx);
      if (parts[0] === "path") { ctx.ui.notify(path, "info"); return; }
      if (parts[0] === "shared") {
        if (!writable(ctx)) return;
        const shared = join(ctx.cwd, ".wisdom-os", "state.json");
        await mkdir(join(ctx.cwd, ".wisdom-os"), { recursive: true });
        try { await stat(shared); } catch { await writeState(shared, await readState(path)); }
        ctx.ui.notify(`project-shared state: ${shared}`, "info"); return;
      }
      if (parts[0] === "handoff" && parts[1] && parts[2]) {
        const out = buildHandoff(await readState(path), parts[1], parts[2]);
        if (!out) { ctx.ui.notify("handoff target not found", "error"); return; }
        ctx.ui.setEditorText(out); return;
      }
      if (!parts.length) { await showOverview(ctx, path, await readState(path)); return; }
      if (!ctx.hasUI) { ctx.ui.notify("This human gate requires Pi TUI mode", "error"); return; }
      if (!writable(ctx)) return;

      if (parts[0] === "decide" && parts[1]) {
        const decision = (await readState(path)).decisions.find((item: any) => item.id === parts[1]);
        if (!decision) { ctx.ui.notify(`decision not found: ${parts[1]}`, "error"); return; }
        const humanCall = await ctx.ui.input("Human call", "What was chosen?");
        if (!humanCall) return;
        const owner = await ctx.ui.input("Owner", decision.owner || "Who owns the outcome?");
        const dueDate = await ctx.ui.input("Review date", decision.dueDate || "YYYY-MM-DD");
        const resolvedPremise = await ctx.ui.input("Resolved premise", "What uncertainty did this settle?");
        if (!owner || !dueDate || !resolvedPremise) { ctx.ui.notify("BANK requires all four fields", "warning"); return; }
        await updateState(path, (state) => {
          const item = state.decisions.find((entry: any) => entry.id === decision.id);
          Object.assign(item, { humanCall, owner, dueDate, resolvedPremise });
          const moved = moveItem(state, "decision", decision.id, { stage: "bank" });
          if (!moved.ok) throw new Error(`BANK blocked: ${moved.missing.join(", ")}`);
          return moved.state;
        });
        ctx.ui.notify(`${decision.id} → BANK`, "info"); return;
      }

      if (parts[0] === "verify" && parts[1]) {
        const task = (await readState(path)).tasks.find((item: any) => item.id === parts[1]);
        if (!task) { ctx.ui.notify(`task not found: ${parts[1]}`, "error"); return; }
        const evidence = task.evidence || await ctx.ui.input("Evidence", "Artifact or reproducing result");
        const maker = task.maker || await ctx.ui.input("Maker", "Who produced it?");
        const verifier = await ctx.ui.input("Independent verifier", "Must differ from maker");
        const verification = await ctx.ui.input("Verification result", "What was independently checked?");
        if (!evidence || !maker || !verifier || !verification || verifier.trim() === maker.trim()) {
          ctx.ui.notify("DONE requires evidence and a verifier different from maker", "warning"); return;
        }
        if (!await ctx.ui.confirm("Human acceptance", `Accept ${task.title} as DONE?`)) return;
        await updateState(path, (state) => {
          const item = state.tasks.find((entry: any) => entry.id === task.id);
          Object.assign(item, { evidence, maker, verifier, verification, acceptedByHuman: true });
          const moved = moveItem(state, "task", task.id, { stage: "done" });
          if (!moved.ok) throw new Error(`DONE blocked: ${moved.missing.join(", ")}`);
          return moved.state;
        });
        ctx.ui.notify(`${task.id} → DONE`, "info"); return;
      }

      if (parts[0] === "learn" && parts[1]) {
        const decision = (await readState(path)).decisions.find((item: any) => item.id === parts[1]);
        if (!decision) { ctx.ui.notify(`decision not found: ${parts[1]}`, "error"); return; }
        const outcome = await ctx.ui.input("Observed outcome", "What happened?");
        const review = await ctx.ui.input("Review", "What did the evidence teach?");
        const disposition = await ctx.ui.select("Case-law disposition", ["strengthened", "amended", "refuted"]);
        const claim = await ctx.ui.input("Case claim", decision.resolvedPremise || decision.title);
        const falsifier = await ctx.ui.input("Falsifier", "What future evidence would make this wrong?");
        if (!outcome || !review || !disposition || !claim || !falsifier) return;
        await updateState(path, (state) => {
          const item = state.decisions.find((entry: any) => entry.id === decision.id);
          Object.assign(item, { outcome, review, caseLawUpdate: disposition });
          const moved = moveItem(state, "decision", decision.id, { stage: "learn" });
          if (!moved.ok) throw new Error(`LEARN blocked: ${moved.missing.join(", ")}`);
          const id = `case-${decision.id}`;
          const existing = moved.state.cases.find((entry: any) => entry.id === id);
          const next = { id, claim, scope: {}, sourceDecisionIds: [decision.id],
            expectedOutcome: decision.resolvedPremise || "", observedOutcome: outcome,
            reviewDate: decision.reviewDate || decision.dueDate || "",
            status: disposition === "refuted" ? "refuted" : disposition === "amended" ? "amended" : "active",
            confidence: "medium", falsifier, updatedAt: new Date().toISOString() };
          if (existing) Object.assign(existing, next); else moved.state.cases.push(next);
          return moved.state;
        });
        ctx.ui.notify(`${decision.id} → LEARN · case ${disposition}`, disposition === "refuted" ? "warning" : "info"); return;
      }

      if (parts[0] === "precedent" && parts[1] && parts[2]) {
        const effect = await ctx.ui.select("How did this precedent affect the decision?", ["changed", "challenged", "confirmed"]);
        if (!effect) return;
        await updateState(path, (state) => {
          if (!state.cases.some((item: any) => item.id === parts[1])) throw new Error(`case not found: ${parts[1]}`);
          if (!state.decisions.some((item: any) => item.id === parts[2])) throw new Error(`decision not found: ${parts[2]}`);
          state.precedentUses.push({ id: `precedent-${randomUUID()}`, caseId: parts[1], decisionId: parts[2], effect, at: new Date().toISOString() });
          return state;
        });
        ctx.ui.notify(`precedent recorded: ${effect}`, "info"); return;
      }

      if (parts[0] === "improve" && parts[1]) {
        const improvement = (await readState(path)).improvements.find((item: any) => item.id === parts[1]);
        if (!improvement) { ctx.ui.notify(`improvement not found: ${parts[1]}`, "error"); return; }
        const choice = await ctx.ui.select("Harness improvement", ["approve canary", "disable proposal"]);
        if (!choice) return;
        await updateState(path, (state) => {
          const item = state.improvements.find((entry: any) => entry.id === improvement.id);
          item.updatedAt = new Date().toISOString();
          if (choice === "disable proposal") { item.stage = "disabled"; item.disabledReason = "human rejected"; return state; }
          item.approvedByHuman = true;
          const taskId = `task-${improvement.id}`;
          if (!state.tasks.some((task: any) => task.id === taskId)) state.tasks.push({
            id: taskId, title: improvement.title, areaId: "", decisionId: "", improvementId: improvement.id,
            stage: "ready", priority: improvement.priority ?? "P1",
            acceptance: `Regression test, rollback, quality auto-disable, independent verifier, and measured reduction in ${improvement.klass} without a new human inbox.`,
            maker: "", evidence: "", verifier: "", verification: "", acceptedByHuman: false,
            blockedReason: "", owner: "", dueDate: "", createdAt: item.updatedAt, updatedAt: item.updatedAt,
          });
          return state;
        });
        ctx.ui.notify(`${improvement.id} → ${choice}`, "info"); return;
      }

      ctx.ui.notify("usage: /wos [decide|verify|learn|precedent|improve|handoff|shared|path]", "info");
    },
  });
}
