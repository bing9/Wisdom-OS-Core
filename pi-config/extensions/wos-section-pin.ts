/**
 * wos-section-pin r3 — keep run-type-dependent system-prompt sections byte-stable per session
 * (request 2026-09-28).
 *
 * ROOT CAUSE (r1). employer's pi-dist `extensions/internal/repo-info.ts` writes the `repo_workspace` section ONLY in
 * `before_agent_start`, which fires only for runs started by user INPUT. Runs started by a queued wos-fleet-message /
 * subagent result / follow-up render the base options WITHOUT it, so Pi records `sections: {repo_workspace: <text>|null}`
 * updates on every input <-> triggered switch, and the HEAD system block changes (cacheRead stops at the ~5.8k tools
 * breakpoint).
 *
 * WHY r1 DID NOT HOLD (DIR-example <session>, 13 warm misses 15:56–19:14Z 2026-09-28). r1 neutralised the
 * mid-transcript UPDATE messages against messages[0]. But when ANY `context` handler returns a changed list (wos-guards'
 * active-turn anchor does on every call; open-loop / OM filters often do), pi.real `restoreSystemMessages` replaces all
 * system messages with ONE collapsed head `getCurrentSystemMessage(current)` BEFORE `context_with_system` runs. The
 * toggle is then baked into messages[0] and there is no update left to neutralise: r1 was a no-op. (Before an OM fold
 * with `systemMessage`, messages[0] was not even a system message: r1 returned early.)
 *
 * r2 FIX. Operate on the section's EFFECTIVE value: every PINNED section is (a) removed from every non-leading system
 * message (an update left empty is dropped) and (b) set on the FIRST system message to the session's STICKY value, placed
 * LAST in its section order: the most recent non-null value seen in this runtime, else the most recent non-null value on
 * the session branch (system messages + compaction.systemMessage), else absent. Result: byte-identical head whether or
 * not before_agent_start ran; at most one flip per session (absent -> present the first time an input run ever sets it).
 * Old Pi runtimes without `context_with_system` never call this.
 * r3 (request 2026-10-04). Pi's built-in MCP extension writes `mcp_servers` ONLY in
 * before_agent_start too (pi.real: `pi.on("before_agent_start", … sections[MCP_SERVERS_SECTION] = …)`), and the base
 * options a triggered run renders from (pi.real `_installAgentNextTurnRefresh`: `_runSystemPromptOptions ?? base`) do
 * not carry it. Since example_mcp became `deferred` (2026-10-03 20:35Z) every input <-> triggered switch toggled
 * `mcp_servers` <text>|null: replayed over all sessions 2026-10-03..10-04T09:32Z, 4 prefix misses whose ONLY
 * post-mitigation head difference was mcp_servers (DIR-wos 09:21:07Z cw 250,329). Pinned like repo_workspace. A server
 * removed from mcp.json keeps its last summary until the session's branch is replaced (stale text, no cache cost).
 * Kill switch: WOS_SECTION_PIN_OFF=1 or touch ~/.wos-runtime/butler/section-pin.off. Sections: WOS_PIN_SECTIONS (csv).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_PINNED = ["repo_workspace", "mcp_servers"];
const OFF = path.join(os.homedir(), ".wos-runtime", "butler", "section-pin.off");

function pinnedNames(): string[] {
	const v = process.env.WOS_PIN_SECTIONS;
	return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_PINNED;
}

function contentText(c: any): string {
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : "")).join("");
	return "";
}

const own = (o: any, k: string) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

/** Latest non-null value of `name` among system messages in `messages` (in order), or undefined. */
export function latestValue(messages: any[], name: string): string | undefined {
	let v: string | undefined;
	for (const m of messages || []) {
		if (m && m.role === "system" && own(m.sections, name)) {
			const x = m.sections[name];
			if (typeof x === "string") v = x;
		}
	}
	return v;
}

/** Latest non-null value of `name` on a session branch (message entries + compaction.systemMessage), or undefined. */
export function latestOnBranch(entries: any[], name: string): string | undefined {
	let v: string | undefined;
	for (const e of entries || []) {
		const m = e?.type === "message" ? e.message : e?.type === "compaction" ? e.systemMessage : undefined;
		if (m && m.role === "system" && own(m.sections, name) && typeof m.sections[name] === "string") v = m.sections[name];
	}
	return v;
}

/**
 * Pure transform (exported for tests). `sticky` maps a pinned name -> the value to enforce (undefined = keep absent).
 * Returns a NEW array when anything changes, else the input array.
 */
export function pinSections(messages: any[], pinned: string[], sticky: Record<string, string | undefined>): any[] {
	if (!Array.isArray(messages) || messages.length === 0) return messages;
	const first = messages.findIndex((m) => m && m.role === "system");
	if (first < 0) return messages;
	let changed = false;
	const out: any[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!m || m.role !== "system") {
			out.push(m);
			continue;
		}
		const sec0 = m.sections && typeof m.sections === "object" ? m.sections : {};
		if (i === first) {
			const sec: Record<string, any> = {};
			for (const [k, v] of Object.entries(sec0)) if (!pinned.includes(k)) sec[k] = v;
			for (const n of pinned) if (typeof sticky[n] === "string") sec[n] = sticky[n]; // pinned sections render LAST
			const same = JSON.stringify(Object.entries(sec)) === JSON.stringify(Object.entries(sec0));
			if (same) {
				out.push(m);
				continue;
			}
			changed = true;
			const c = { ...m };
			if (Object.keys(sec).length) c.sections = sec;
			else delete c.sections;
			out.push(c);
			continue;
		}
		if (!pinned.some((n) => own(sec0, n))) {
			out.push(m);
			continue;
		}
		changed = true;
		const sec: Record<string, any> = {};
		for (const [k, v] of Object.entries(sec0)) if (!pinned.includes(k)) sec[k] = v;
		const empty = Object.keys(sec).length === 0 && contentText(m.content).length === 0
			&& !(m.toolsAdded && m.toolsAdded.length) && !(m.toolsRemoved && m.toolsRemoved.length);
		if (empty) continue;
		const c = { ...m };
		if (Object.keys(sec).length) c.sections = sec;
		else delete c.sections;
		out.push(c);
	}
	return changed ? out : messages;
}

export default function (pi: any) {
	if (process.env.WOS_SECTION_PIN_OFF === "1") return;
	const remembered: Record<string, string | undefined> = {}; // per runtime (a /reload re-reads the branch)
	pi.on("context_with_system", (event: any, ctx: any) => {
		if (fs.existsSync(OFF) || !Array.isArray(event?.messages)) return;
		const names = pinnedNames();
		const sticky: Record<string, string | undefined> = {};
		for (const n of names) {
			const seen = latestValue(event.messages, n);
			if (seen !== undefined) remembered[n] = seen;
			if (remembered[n] === undefined) {
				try {
					remembered[n] = latestOnBranch(ctx?.sessionManager?.getBranch?.() ?? [], n);
				} catch {
					/* branch unavailable: keep what the request carries */
				}
			}
			sticky[n] = remembered[n];
		}
		const out = pinSections(event.messages, names, sticky);
		return out === event.messages ? undefined : { messages: out };
	});
}
