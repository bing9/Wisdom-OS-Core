// wos-mcp-gate.ts — allowlist chokepoint for Pi MCP / codemode / tool_search (r2: request 2026-10-03,
// simplifies request 2026-10-02).
//
// @pi-child-safe: one tool_call gate; no tool, prompt or context changes.
// I/O: stat/read of the allowlist (mtime-cached); for a tool outside the reviewed set, trust.json and the kill switch;
// realpath of a write/edit target; appending log lines.
//
// WHY. Every WOS guard (data-policy, soul-guard, protected-writes, install-gate, project-estate, soul-sandbox, subagents
// command-guard/child-write-boundary) is keyed on a TOOL NAME (bash/write/edit/read…). Pi MCP adds tools with other
// names (`mcp__<server>__<tool>`, the resource tools, `codemode`, `tool_search`). Hermetic tests showed MCP writes
// landing in ~/.wos-runtime/datapolicy_guard/, AGENTS.md and 01_Soul/. So a tool those guards cannot see runs only if DIR-wos
// listed it. Single-user rule (the owner 2026-10-03): this guards against our own agents' accidents, not attackers.
//
// DECISION (per tool_call, in this order):
//   1. gate controls  — write/edit whose target (realpath through the nearest existing ancestor) is the allowlist, the
//      kill switch or the live gate file → REFUSED (installer-only). mcp.json / settings.json are NOT protected here:
//      a server an agent adds still has every tool refused by tier 2 until DIR-wos lists it.
//   2. MCP family     — ^mcp__, list_mcp_resources, list_mcp_resource_templates, read_mcp_resource, codemode,
//      tool_search → allowed only if listed in ~/.wos-runtime/harness/mcp_allowlist.yaml:
//        tools:        read-only tools. An `mcp__*` entry here is admitted only while its server still declares
//                      readOnlyHint: true (pi.getAllTools() annotations) — a server update that turns a tool
//                      write-capable is refused until DIR-wos re-reviews it.
//        write_tools:  write-capable MCP tools DIR-wos admitted because their target can never be Soul / AGENTS.md /
//                      home (remote-only effect). Empty by default.
//      Absent/empty/unreadable allowlist = deny all. Entries: exact names or `prefix*`.
//   3. REVIEWED       — the static set below → allowed, no I/O.
//   4. REGISTERED WOS — pi.getAllTools() sourceInfo.path is a file (not `builtin:*`) under a reviewed extension root
//      (agent extensions dir, ~/.wos-runtime/pi_extensions, ~/.wos-runtime/pi_packages, the subagents package,
//      /opt/pi-dist/extensions, or <trusted project>/.pi/extensions from trust.json) → allowed, logged once.
//   5. otherwise      → REFUSED (unknown built-ins such as `powershell`, unknown sources).
// Kill switch: ~/.wos-runtime/butler/mcp-gate.off turns OFF tiers 2–5 (logged); tier 1 stays on.
// Audit twin (read-only): ~/.wos-runtime/harness/wos_mcp_health.py.  Log: ~/.wos-runtime/logs/wos-mcp-gate.jsonl.
// Errors: an exception while deciding refuses any tool outside the static set (fail closed).
//
// @ts-nocheck

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GATE = "wos-mcp-gate";
const H = () => os.homedir();
const WDB = () => path.join(H(), ".wos-runtime");
export const allowlistPath = () => process.env.WOS_MCP_ALLOWLIST ?? path.join(WDB(), "harness", "mcp_allowlist.yaml");
const LOG = () => process.env.WOS_MCP_GATE_LOG ?? path.join(WDB(), "logs", "wos-mcp-gate.jsonl");
const OFF_FILE = () => path.join(WDB(), "butler", "mcp-gate.off");
const agentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(H(), ".pi", "agent");
const SUBAGENTS_PKG = (process.env.WISDOM_OS_ROOT ?? "") + "/Obsidian Vault/Context/99_Reference/pi-interactive-subagents";
const POINTER = "WOS admits an MCP tool only when DIR-wos lists it in mcp_allowlist.yaml (read-only tools under `tools:`; " +
  "write-capable remote-only tools under `write_tools:`). Otherwise use the skill's `internal-cli` CLI.";

// ── tier 3: REVIEWED tools (unchanged from r1; evidence: request 2026-10-02 REPORT.md §"Tool list evidence") ──
export const REVIEWED = new Set([
  "read", "bash", "edit", "write", "ls",                       // Pi core built-ins; `powershell` deliberately absent
  "grep", "find",                                              // /opt/pi-dist/extensions/internal
  "wos_reload_runtime", "wos_retrieve", "skill_find",
  "wos_ask", "wos_fd_result", "fd_query_wisdom", "fd_kg_check", "fd_qmd", "fd_liveness", "fd_bulletin", "fd_session_status",
  "subagent", "subagent_message", "subagents_list", "ask_question", "safe_bash",
  "om_source", "record_observations", "finish_chunk",
  "om_memory_ls", "om_memory_read", "om_memory_grep", "om_memory_write", "om_memory_edit", "om_memory_finish_consolidation",
  "AskUserQuestion", "monitor_diff", "channel_reply", "gchat_detach", "agent_home_list_sessions",
  "dm_session_list", "dm_session_search", "dm_session_status", "dm_session_read", "dm_session_events", "dm_project_list",
  "dm_compute_list", "dm_session_monitor", "dm_monitor", "dm_session_wait", "dm_session_message", "dm_session_create",
  "dm_session_fork", "dm_session_rename", "dm_session_archive", "dm_session_stop", "dm_session_assign_project",
  "dm_session_move",
]);

// ── tier 2: the MCP family + allowlist ──
const MCP_FAMILY_EXACT = new Set(["codemode", "tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
export const isMcpFamily = (name: string) => /^mcp__/.test(name) || MCP_FAMILY_EXACT.has(name);

export type Allow = { tools: string[]; write_tools: string[] };
let allowCache = { key: "", list: { tools: [], write_tools: [] } as Allow };
/** Parse the allowlist (sections `tools:` and `write_tools:`). Absent/empty/unreadable → both empty (deny all). */
export function readAllowlist(): Allow {
  const p = allowlistPath();
  let st: any;
  try { st = fs.statSync(p); } catch { allowCache = { key: "", list: { tools: [], write_tools: [] } }; return allowCache.list; }
  const key = `${p}:${st.mtimeMs}:${st.size}`;
  if (allowCache.key === key) return allowCache.list;
  const list: Allow = { tools: [], write_tools: [] };
  try {
    let sec: keyof Allow | null = null;
    for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
      const h = /^(tools|write_tools):\s*(\[\s*\])?\s*$/.exec(line);
      if (h) { sec = h[1] as keyof Allow; continue; }
      if (/^\S/.test(line)) { sec = null; continue; }
      const m = sec && /^\s+-\s+["']?([A-Za-z0-9_.\-]+\*?)["']?\s*$/.exec(line);
      if (m) list[sec!].push(m[1]);
    }
  } catch { list.tools = []; list.write_tools = []; }
  allowCache = { key, list };
  return list;
}
export const matches = (name: string, entries: string[]) =>
  entries.some((e) => (e.endsWith("*") ? e.length > 1 && name.startsWith(e.slice(0, -1)) : e === name));
/** Kept for callers of r1: true if the name is in either section. */
export const allowlisted = (name: string, a: Allow = readAllowlist()) => matches(name, a.tools) || matches(name, a.write_tools);

/** Tier-2 verdict for an MCP-family name: null = allowed, else the refusal reason. Exported for tests. */
export function mcpVerdict(name: string, info: any, a: Allow = readAllowlist()): string | null {
  if (matches(name, a.write_tools)) return null;
  if (!matches(name, a.tools)) return `${name} is not in ${allowlistPath()}. ` + POINTER;
  if (!/^mcp__/.test(name)) return null;                       // tool_search / codemode / resource tools: Pi-defined
  const ro = info?.annotations?.readOnlyHint;
  if (ro === true && info?.annotations?.destructiveHint !== true) return null;
  return `${name} is listed under \`tools:\` (read-only) but its server does not declare readOnlyHint=true now ` +
    `(annotations ${JSON.stringify(info?.annotations ?? null)}). DIR-wos must re-review it, or list it under \`write_tools:\`. ` + POINTER;
}

// ── tier 4: registered WOS tool (by registering source) ──
function trustedProjectExtDirs(): string[] {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(agentDir(), "trust.json"), "utf8"));
    return Object.entries(t).filter(([, v]) => v === true).map(([k]) => path.join(k, ".pi", "extensions"));
  } catch { return []; }
}
export function reviewedRoots(): string[] {
  return [path.join(agentDir(), "extensions"), path.join(WDB(), "pi_extensions"), path.join(WDB(), "pi_packages"),
    SUBAGENTS_PKG, "/opt/pi-dist/extensions", ...trustedProjectExtDirs()];
}
const under = (p: string, root: string) => { const r = path.relative(root, p); return r === "" || (!!r && !r.startsWith("..") && !path.isAbsolute(r)); };
const realOr = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
export function reviewedSource(si: any, roots = reviewedRoots()): boolean {
  const p = typeof si?.path === "string" ? si.path : "";
  if (!p || !path.isAbsolute(p) || p.startsWith("builtin:")) return false;
  const cands = [path.resolve(p), realOr(p)];
  return roots.some((r) => cands.some((c) => under(c, r) || under(c, realOr(r))));
}

// ── tier 1: the gate's own controls ──
function resolveTarget(raw: unknown, cwd: string): string {
  let s = String(raw ?? "");
  if (s.startsWith("@")) s = s.slice(1);
  if (s === "~") s = H(); else if (s.startsWith("~/")) s = path.join(H(), s.slice(2));
  const abs = path.isAbsolute(s) ? path.resolve(s) : path.resolve(cwd || process.cwd(), s);
  // realpath through the nearest existing ancestor (a symlinked dir cannot hide the target)
  const parts: string[] = []; let cur = abs;
  for (;;) {
    try { const r = fs.realpathSync(cur); return parts.length ? path.join(r, ...parts.reverse()) : r; }
    catch { const up = path.dirname(cur); if (up === cur) return abs; parts.push(path.basename(cur)); cur = up; }
  }
}
export function isGateControlPath(p: string): boolean {
  const ctl = [allowlistPath(), OFF_FILE(), path.join(agentDir(), "extensions", "wos-mcp-gate.ts")].map((x) => path.resolve(x));
  return ctl.includes(p) || ctl.map(realOr).includes(p);
}

// ── logging (bounded, never throws) ──
const loggedOnce = new Set<string>();
function log(o: any) {
  try {
    const p = LOG(); fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), gate: GATE, pid: process.pid,
      agent: process.env.PI_SUBAGENT_AGENT ?? null, ...o }).slice(0, 2000) + "\n");
  } catch { /* logging must never change a decision */ }
}
const off = () => { try { return fs.existsSync(OFF_FILE()); } catch { return false; } };
const refuse = (tier: string, toolName: string, why: string) => {
  log({ decision: "refused", tier, tool: toolName, why: why.slice(0, 300) });
  return { block: true, reason: `WOS-MCP-GATE refused ${toolName}: ${why}` };
};

/** The whole decision. Exported for tests; `getAllTools` is injected so tests need no Pi runtime. */
export function decide(event: any, ctx: any, getAllTools: () => any[]): undefined | { block: true; reason: string } {
  const name = String(event?.toolName ?? "");
  const input = event?.input ?? {};
  if (name === "write" || name === "edit") {                     // tier 1 — always on
    const t = resolveTarget(input.path ?? input.file_path, ctx?.cwd || process.cwd());
    if (isGateControlPath(t)) return refuse("gate-control", name, `${t} is a control of this gate (installer-only, DIR-wos).`);
  }
  if (REVIEWED.has(name)) return undefined;                      // tier 3 fast path
  if (off()) { log({ decision: "allowed-kill-switch", tool: name }); return undefined; }
  const info = () => (getAllTools() ?? []).find((t: any) => t?.name === name);
  if (isMcpFamily(name)) {                                       // tier 2
    const why = mcpVerdict(name, info());
    return why ? refuse("mcp-family", name, why) : undefined;
  }
  const i = info();                                              // tier 4
  if (i && reviewedSource(i.sourceInfo)) {
    if (!loggedOnce.has(name)) { loggedOnce.add(name); log({ decision: "allowed-registered-source", tool: name, source: i.sourceInfo?.path }); }
    return undefined;
  }
  return refuse("default-deny", name, `${name} is not a reviewed WOS/Pi tool (source ${i?.sourceInfo?.path ?? "unknown"}). ` +
    `Add it to the reviewed set via DIR-wos. ` + POINTER);
}

export default function (pi: any) {
  pi.on("tool_call", (event: any, ctx: any) => {
    try {
      return decide(event, ctx, () => (typeof pi.getAllTools === "function" ? pi.getAllTools() : []));
    } catch (e) {
      const name = String(event?.toolName ?? "");
      if (REVIEWED.has(name)) return undefined;
      return { block: true, reason: `WOS-MCP-GATE refused ${name}: gate error (${String(e?.message ?? e).slice(0, 120)}); failing closed. ` + POINTER };
    }
  });
}
