/**
 * wos-skill-find — model-callable `skill_find(query)` over the FULL generated skill index
 * (request 2026-09-27, spec R3 of role-scoped-skill-catalog.spec.md).
 *
 * WHY. Directors/Butler start with a trimmed resident skill list (`--no-skills` + `--skill`). A
 * trimmed skill must stay reachable by the MODEL, not only by a human slash command (the 12h
 * `/skill-find` counterexample, FINAL-REVIEW4). Coverage must be the full index — local skills
 * (loaded or not), agent-market-compat, every Agent Market plugin on disk, 99_Reference/learn —
 * or a miss is a false "does not exist" (the 2026-09-26 `/pi-learn` false negative).
 *
 * CONTRACT.
 *  - Registered ONCE per runtime, at session_start (guarded), with a constant description and
 *    schema: the tool block of the system prompt is byte-stable across turns and compactions.
 *  - Reads the generated index only (skill_roles_gen.py is its sole writer); never scans disk.
 *    The index is loaded lazily on first call and cached for the runtime.
 *  - Returns ≤5 {name, description, path}, ranked by name + description match.
 *  - A miss is TYPED (`SKILL_FIND_MISS`) and names every root searched; every miss (and a
 *    missing/unreadable index, `SKILL_INDEX_UNAVAILABLE`) is appended to the demand-signal JSONL.
 *  - `read_top: true` returns the top hit's SKILL.md body (truncated) so a role WITHOUT the
 *    `read` tool still has an executable discovery path (FINAL-REVIEW4: researcher lacked `read`).
 *
 * @pi-child-safe: read-only search over the generated skill index; its only write is one append-only demand-signal JSONL line per miss.
 *
 * Env: WOS_SKILL_INDEX (index path), WOS_SKILL_DEMAND_LOG (demand JSONL), WOS_SKILL_ROLE (logged only).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOME = os.homedir();
export const INDEX_PATH = process.env.WOS_SKILL_INDEX || path.join(HOME, ".wos-runtime/pi/skill-roles/skill_index.json");
export const DEMAND_LOG = process.env.WOS_SKILL_DEMAND_LOG || path.join(HOME, ".wos-runtime/pi/skill-roles/skill_find_demand.jsonl");
const MAX_RESULTS = 5;
const BODY_CAP = 24000;
const MIN_SCORE = 3;
const STOP = new Set(["a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "with", "skill", "skills", "use", "how", "i", "my", "me", "is", "it", "do", "what", "which"]);

type Row = { name: string; description: string; path: string; root: string; source: string; default_loaded: boolean; disable_model_invocation?: boolean };
type Index = { schema: string; count: number; roots: { root: string; source: string; exists: boolean }[]; skills: Row[] };

let cached: Index | null = null;
let cachedErr = "";

export function loadIndex(p = INDEX_PATH): Index {
	if (cached) return cached;
	const raw = JSON.parse(fs.readFileSync(p, "utf8"));
	if (raw?.schema !== "skill-index/v1" || !Array.isArray(raw.skills)) throw new Error(`bad index schema at ${p}`);
	cached = raw as Index;
	return cached;
}

export function resetForTest() {
	cached = null;
	cachedErr = "";
}

function tokens(s: string): string[] {
	return s.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((t) => t.length >= 2 && !STOP.has(t));
}

export function score(q: string, r: Row): number {
	const ql = q.toLowerCase().trim();
	const name = r.name.toLowerCase();
	const desc = r.description.toLowerCase();
	const nameToks = tokens(name.replace(/[-_]/g, " "));
	const descToks = new Set(tokens(desc));
	let s = 0;
	if (ql === name || ql.replace(/\s+/g, "-") === name) s += 100;
	else if (ql.length >= 3 && name.includes(ql.replace(/\s+/g, "-"))) s += 30;
	const qt = tokens(ql);
	let covered = 0;
	for (const t of qt) {
		let hit = false;
		if (nameToks.includes(t)) (s += 12), (hit = true);
		else if (nameToks.some((n) => n.startsWith(t) || (n.length >= 4 && t.startsWith(n)))) (s += 6), (hit = true);
		if (descToks.has(t)) (s += 3), (hit = true);
		else if (t.length >= 4 && desc.includes(t)) s += 1;
		if (hit) covered += 1;
	}
	// coverage: a skill matching MOST of the query outranks one matching a single strong name word
	if (qt.length > 1) s += Math.round((12 * covered) / qt.length);
	// CJK / phrase queries: raw substring match on the description
	if (/[\u4e00-\u9fff]/.test(ql) && desc.includes(ql)) s += 8;
	return s;
}

export function search(query: string, idx: Index) {
	const scored = idx.skills
		.map((r) => ({ r, s: score(query, r) }))
		.filter((x) => x.s >= MIN_SCORE) // a lone substring hit (score 1-2) is noise, not a match
		.sort((a, b) => b.s - a.s || Number(b.r.default_loaded) - Number(a.r.default_loaded) || a.r.name.localeCompare(b.r.name) || a.r.path.localeCompare(b.r.path));
	return scored.slice(0, MAX_RESULTS);
}

function appendDemand(rec: Record<string, unknown>) {
	try {
		fs.mkdirSync(path.dirname(DEMAND_LOG), { recursive: true });
		fs.appendFileSync(DEMAND_LOG, JSON.stringify(rec) + "\n");
	} catch {
		/* demand logging must never break the tool */
	}
}

/** read_top containment (r3 ruling 7): the file's realpath must lie under the realpath of the row's declared root. */
export function containedBody(r: Row): { ok: true; body: string } | { ok: false; why: string } {
	try {
		if (!r.root) return { ok: false, why: "index row has no declared root" };
		const root = fs.realpathSync(r.root);
		const real = fs.realpathSync(r.path);
		if (real !== root && !real.startsWith(root + path.sep)) return { ok: false, why: `realpath ${real} escapes declared root ${root}` };
		const st = fs.statSync(real);
		if (!st.isFile()) return { ok: false, why: `${real} is not a regular file` };
		return { ok: true, body: fs.readFileSync(real, "utf8") };
	} catch (e) {
		return { ok: false, why: String((e as Error)?.message || e) };
	}
}

export function runSkillFind(query: string, readTop: boolean, meta: { session?: string; cwd?: string; role?: string } = {}) {
	const base = { ts: new Date().toISOString(), query, role: meta.role || process.env.WOS_SKILL_ROLE || "unscoped", session: meta.session || "", cwd: meta.cwd || "", index: INDEX_PATH };
	let idx: Index;
	try {
		idx = loadIndex();
	} catch (e) {
		cachedErr = String((e as Error)?.message || e);
		appendDemand({ ...base, kind: "SKILL_INDEX_UNAVAILABLE", error: cachedErr });
		return { text: `SKILL_INDEX_UNAVAILABLE: ${INDEX_PATH} (${cachedErr}). Fall back: dispatch a subagent (full catalog) for this domain work.`, details: { kind: "SKILL_INDEX_UNAVAILABLE" } };
	}
	const hits = search(query, idx);
	if (!hits.length) {
		const roots = idx.roots.filter((r) => r.exists).map((r) => r.root);
		appendDemand({ ...base, kind: "SKILL_FIND_MISS", roots_searched: roots.length, index_count: idx.count });
		return {
			text: [`SKILL_FIND_MISS: no skill matches "${query}" in ${idx.count} indexed skills.`, "Roots searched:", ...roots.map((r) => `- ${r}`), "Logged as a demand signal. Try other words, or dispatch a subagent (full catalog)."].join("\n"),
			details: { kind: "SKILL_FIND_MISS", roots },
		};
	}
	const lines = hits.map((h, i) => `${i + 1}. ${h.r.name} [${h.r.source}${h.r.default_loaded ? "" : ", not in default catalog"}]\n   ${h.r.description.slice(0, 400)}\n   path: ${h.r.path}`);
	let text = `skill_find: ${hits.length} result(s) for "${query}". Load one with the read tool on its path.\n` + lines.join("\n");
	if (readTop) {
		const c = containedBody(hits[0].r);
		if (c.ok) {
			const body = c.body;
			text += `\n\n--- ${hits[0].r.path} ---\n` + (body.length > BODY_CAP ? body.slice(0, BODY_CAP) + `\n[truncated at ${BODY_CAP} chars; read the path for the rest]` : body);
		} else {
			text += `\n\nread_top REFUSED: ${c.why}`;
		}
	}
	return { text, details: { kind: "SKILL_FIND_HIT", results: hits.map((h) => ({ name: h.r.name, path: h.r.path, score: h.s })) } };
}

const TOOL = {
	name: "skill_find",
	label: "Skill Find",
	description:
		"Search the FULL skill index (every local skill incl. ones not loaded in this session, agent-market-compat, all Agent Market plugins on disk, 99_Reference/learn). Use when a task may have a specialised skill that is not listed in your <skills> section. Returns up to 5 name/description/path; then read the SKILL.md at that path. A miss names the roots searched.",
	parameters: Type.Object({
		query: Type.String({ description: "What you need, in words likely to appear in a skill name or description" }),
		read_top: Type.Optional(Type.Boolean({ description: "Also return the top hit's SKILL.md body (for roles without the read tool)" })),
	}),
	async execute(_id: string, params: { query: string; read_top?: boolean }, _signal: unknown, _onUpdate: unknown, ctx: any) {
		let session = "";
		try {
			session = String(ctx?.sessionManager?.getSessionId?.() ?? "");
		} catch {
			/* optional */
		}
		const r = runSkillFind(String(params.query || ""), Boolean(params.read_top), { session, cwd: ctx?.cwd, role: scope.role || "unscoped" });
		return { content: [{ type: "text" as const, text: r.text }], details: r.details };
	},
};

// ---------------------------------------------------------------------------------------------- runtime scoping (r3)
// PRIMARY path for role-scoped catalogs: independent of how the session was launched (Herdr restore, handoff, manual,
// liveness restart). At session_start the role is derived ONCE by the launcher shim's runtime mode (same designation /
// om_current logic, same alarm file, flock-deduped). In before_agent_start Pi exposes the structured prompt inputs;
// the skill list is `systemPromptOptions.skills` (the rendered <skills> section is built from it after the hook).
// We replace it with the subset whose realpath is a declared resident, preserving Pi's order. Same inputs every turn
// => byte-identical <skills> section on every request; compaction never touches the system prompt.
// Children (pi-interactive-subagents workers) keep the full catalog and never call the shim.
const SHIM = process.env.WOS_SKILL_ROLES_SHIM || path.join(HOME, ".wos-runtime/pi/skill-roles/skill_role_launch.py");
const PY = process.env.WOS_SKILL_ROLES_PYTHON || "/usr/bin/python3";
type Scope = { role: string | null; residents: Set<string> | null; why: string };
const DEBUG = process.env.WOS_SKILL_FIND_DEBUG || "";   // opt-in diagnostics file (tests / incident triage)
function dbg(rec: Record<string, unknown>) {
	if (!DEBUG) return;
	try {
		fs.appendFileSync(DEBUG, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...rec }) + "\n");
	} catch {
		/* never break the session */
	}
}
const scope: Scope = { role: null, residents: null, why: "not yet derived" };

function isChild(): boolean {
	return Boolean(process.env.PI_SUBAGENT_ID || process.env.PI_SUBAGENT_SESSION || process.env.PI_SUBAGENT_NAME);
}

// request 2026-09-27: 43 of the skill paths live on the wisdom-os rclone mount, and every uncached
// `realOrSelf` was a main-thread `openat(O_PATH)`+`readlink` there (94 per filter in the stall-catcher bench),
// in `trimSkills` on EVERY before_agent_start. Realpaths are resolved ONCE per session, asynchronously (Bun runs
// fs.promises on its thread pool, off the main thread), at session_start, and reused. A symlink retarget
// mid-session is irrelevant to prompt trimming (and a stable answer keeps the <skills> section byte-stable).
// A path not warmed (rare: a skill appeared after session_start) still resolves synchronously once, then is memoized.
const REAL = new Map<string, string>();
function realOrSelf(p: string): string {
	const hit = REAL.get(p);
	if (hit !== undefined) return hit;
	let v = p;
	try {
		v = fs.realpathSync(p);
	} catch {
		v = p;
	}
	REAL.set(p, v);
	return v;
}
/** Resolve many paths off the main thread and memoize them (never throws). */
export async function warmRealpaths(paths: Iterable<string>): Promise<number> {
	const todo = [...new Set([...paths].filter((p) => typeof p === "string" && p && !REAL.has(p)))];
	await Promise.all(todo.map((p) => fs.promises.realpath(p).then((v) => REAL.set(p, v), () => REAL.set(p, p))));
	return todo.length;
}
/** Every skill file Pi knows about, as the runtime reports it (skills come back as commands with a path). */
function knownSkillPaths(pi: any): string[] {
	try {
		const cmds = typeof pi?.getCommands === "function" ? pi.getCommands() : [];
		return (Array.isArray(cmds) ? cmds : [])
			.filter((c: any) => c && c.source === "skill" && typeof c.sourceInfo?.path === "string")
			.map((c: any) => String(c.sourceInfo.path));
	} catch {
		return [];
	}
}
export function _realCacheForTest(): Map<string, string> {
	return REAL;
}

export function deriveScope(sessionId: string, sessionFile: string, resolve: (p: string) => string = realOrSelf): Scope {
	if (isChild()) return { role: "worker", residents: null, why: "subagent child: full catalog" };
	try {
		// an earlier request r2: local $HOME cwd (Bun chdir()s into the cwd inside vfork() while Pi is frozen). The
		// shim takes an absolute session file and never reads its cwd (evidence r2/cwd_probe_results.txt, real stores).
		const cwdOk = path.isAbsolute(SHIM) && (!sessionFile || path.isAbsolute(sessionFile));
		const r = spawnSync(PY, [SHIM, "--runtime", "--session-id", sessionId || "none", "--session-file", sessionFile || ""], { encoding: "utf8", timeout: 15000, ...(cwdOk ? { cwd: os.homedir() } : {}) });
		if (r.status !== 0) return { role: null, residents: null, why: `shim exit ${r.status}: ${String(r.stderr || "").slice(0, 200)}` };
		const j = JSON.parse(String(r.stdout || "{}"));
		if (!j.role || !Array.isArray(j.resident_paths) || !j.resident_paths.length) return { role: null, residents: null, why: j.why || "unscoped" };
		return { role: j.role, residents: new Set(j.resident_paths.map(resolve)), why: j.why || "" };
	} catch (e) {
		return { role: null, residents: null, why: `shim unavailable: ${String((e as Error)?.message || e)}` };
	}
}

// r5 (P0 canary): before_agent_start only fires for runs started by user INPUT. Runs started any other way (a queued
// wos-fleet-message, a subagent result, a Butler follow-up: sendMessage triggerTurn / agent.continue) and every later
// turn of such a run render the prompt from Pi's BASE options (the full loader skill list), which an extension cannot
// reach from an event context; after /reload that base is rebuilt full. So the trim must ALSO sit on the per-request
// path: `context_with_system` sees every provider request's messages (a structuredClone, request-local) including the
// leading system message and any mid-transcript system-section updates. We filter every `sections.skills` text to the
// resident <skill> blocks. Measured: filter(full rendered section) is BYTE-IDENTICAL to Pi's own rendering of the
// trimmed list, so both paths yield one prefix (no flip-flop between user-started and triggered runs).
const SKILL_BLOCK_RE = /  <skill>\n[\s\S]*?\n  <\/skill>\n/g;
const filterCache = new Map<string, string>();
const residentKeys = new WeakMap<Set<string>, string>();
function residentKey(r: Set<string>): string {
	let k = residentKeys.get(r);
	if (k === undefined) {
		k = [...r].sort().join("\n");
		residentKeys.set(r, k);
	}
	return k;
}
export function filterSkillsText(text: string, residents: Set<string>): string {
	const key = residentKey(residents) + "\u0000" + text;   // cache keyed by (resident set, input)
	const hit = filterCache.get(key);
	if (hit !== undefined) return hit;
	let kept = 0;
	const out = text.replace(SKILL_BLOCK_RE, (block: string) => {
		const m = /<location>([\s\S]*?)<\/location>/.exec(block);
		if (m && residents.has(realOrSelf(m[1]))) {
			kept += 1;
			return block;
		}
		return "";
	});
	const res = kept ? out : text; // never an empty catalog
	if (filterCache.size > 64) filterCache.clear();
	filterCache.set(key, res);
	return res;
}

/** Deterministic trim; returns null when trimming must not happen (never an empty catalog). */
export function trimSkills(skills: any[], residents: Set<string>): any[] | null {
	const kept = skills.filter((s) => s && typeof s.filePath === "string" && residents.has(realOrSelf(s.filePath)));
	return kept.length ? kept : null;
}

export default function (pi: ExtensionAPI) {
	if (process.env.WOS_SKILL_FIND_OFF === "1") return;
	// per-runtime closure (not module state): a /reload builds a new runtime and registers once again
	let registered = false;
	let derivedFor: string | null = null;
	pi.on("session_start", async (_event: any, ctx: any) => {
		let sid = "", sfile = "";
		try {
			sid = String(ctx?.sessionManager?.getSessionId?.() ?? "");
			sfile = String(ctx?.sessionManager?.getSessionFile?.() ?? "");
		} catch {
			/* unscoped */
		}
		// derive ONCE per session (a /new or session switch is a new session, and a new prompt anyway)
		if (derivedFor !== sid + "|" + sfile) {
			derivedFor = sid + "|" + sfile;
			// Warm the skill realpaths off the main thread BEFORE the residents are canonicalized.
			const skillPaths = knownSkillPaths(pi);
			try {
				await warmRealpaths(skillPaths);
			} catch {
				/* best effort */
			}
			const d = deriveScope(sid, sfile, (p) => p); // raw resident paths; canonicalized below, off-main
			if (d.residents) {
				try {
					await warmRealpaths(d.residents);
				} catch {
					/* best effort */
				}
				d.residents = new Set([...d.residents].map(realOrSelf));
			}
			Object.assign(scope, d);
		}
		dbg({ ev: "session_start", reason: _event?.reason, sid, sfile, role: scope.role, why: scope.why, residents: scope.residents ? scope.residents.size : null });
		if (registered) return; // once per runtime: constant tool block, no re-registration drift
		registered = true;
		pi.registerTool(TOOL as any);
	});
	pi.on("context_with_system", (event: any) => {
		if (!scope.residents || !Array.isArray(event?.messages)) return;
		let changed = 0;
		for (const m of event.messages) {
			if (m && m.role === "system" && m.sections && typeof m.sections.skills === "string") {
				const f = filterSkillsText(m.sections.skills, scope.residents);
				if (f !== m.sections.skills) {
					m.sections.skills = f;
					changed += 1;
				}
			}
		}
		if (changed) dbg({ ev: "context_with_system", filtered_system_messages: changed });
		return { messages: event.messages };
	});
	pi.on("before_agent_start", (event: any) => {
		const o0 = event?.systemPromptOptions;
		dbg({ ev: "before_agent_start", role: scope.role, residents: scope.residents ? scope.residents.size : null, skillsType: Array.isArray(o0?.skills) ? o0.skills.length : typeof o0?.skills });
		if (!scope.residents) return;
		const o = event?.systemPromptOptions;
		if (!o || !Array.isArray(o.skills)) return;
		const kept = trimSkills(o.skills, scope.residents);
		dbg({ ev: "trim", before: o.skills.length, after: kept ? kept.length : null });
		if (kept) o.skills = kept; // new array: never mutate Pi's shared resource list in place
	});
}
