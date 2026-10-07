/**
 * wos-compaction-mode.ts — per-session compaction point: `long` (Pi native) or `short` (~270k).
 *
 * request 2026-09-26 (R2). the owner (2026-09-26): "OM compaction point I want to be able
 * to switch in pi extension for each session, we can switch between long (1M normal) and short (270k)".
 *
 *   /compaction short [tokens]   compact when context > tokens (default 270000) — even on 750k/1M models
 *   /compaction long             Pi native threshold (contextWindow − reserveTokens); this file does nothing
 *   /compaction default          drop the explicit choice; the role default applies again
 *   /compaction status           mode, target, context tokens, OM gate state, last decision
 *
 * PERSISTENCE. A switch is a session custom entry `wos.compaction.mode` (like OM's `om.enabled`), read
 * back from `ctx.sessionManager.getBranch()`; it survives resume, /reload and fork.
 *
 * DEFAULTS (the owner decided 2026-09-26, option A): Directors AND Butler short (~270k); the owner's own
 * interactive sessions and subagents long. Anything unresolved is long.
 * BUTLER. Butler is not a registered Director. It is recognised only by its exact designation row in
 * the live projection ~/.wos-runtime/director/om_current.json (the same projection OM identity and the
 * role arbiter read): key "Butler" AND director_id "Butler" AND state "active" AND session_path equal
 * to this session's file. An unreadable, malformed or non-matching projection means not Butler, so long.
 * ROLE (R2: fail-safe). "director" only when OM's CANONICAL identity resolver proves it
 * (`pi-observational-memory/src/identity.ts` resolveDirectorIdentity: registered in directors.yaml
 * AND designation state === "active" AND session_path matches). Anything unproven — unreadable
 * registry, unregistered row, missing state, OM not importable — is NOT a Director and gets `long`,
 * the owner's interactive default. No second registry parser lives here: when the shared
 * directors-registry parser lands in OM, this file inherits it.
 *
 * 🔴 WHY IT TRIGGERS ONLY WHEN IDLE. Pi 0.87.1 has no per-session compaction-threshold API, and
 * `ctx.compact()` begins with `await this.abort()`. OM's old `turn_end → ctx.compact` was removed on
 * 2026-09-20 for exactly that (request 2026-09-19). So short mode compacts only
 * after `agent_settled` + a quiet delay, and only if: `ctx.isIdle()`, no queued message, no run has
 * started since settle (own agent_start/agent_settled tracking). Once started, if ANY run starts before
 * this file's `session_before_compact` handler runs (e.g. a subagent result delivered with
 * `triggerTurn`), the compaction is CANCELLED and re-evaluated at the next settle.
 *
 * 🔴 OM QUALITY GATE (R2: canonical). Coverage is OM's own `computeFrontier` (contiguous prefix from
 * index −1, gaps/holes block) and token arithmetic is OM's `estimateEntryTokens` / `isSourceEntry`,
 * imported from the OM package — no second ledger fold. Defer while observer chunks are pending or the
 * source tokens between the covered frontier and the projected cut exceed `gate.maxLagTokens`;
 * re-check every `gate.recheckMs`; proceed after `gate.maxDeferMs` (OM's own hook still waits for
 * observers and clamps the cut to its frontier, so unobserved history stays verbatim).
 *
 * 🔴 R4: A SETTLE IS NOT PROOF OF IDLE. In Pi 0.87.1 a prompt accepted during/after `agent_settled`
 * (deferred settled actions; the input → auth → before_agent_start window) runs with
 * `_isAgentRunActive=false`, so `isIdle()` is true while a prompt is on its way. A manual compaction
 * started then rejects that prompt, and `ctx.compact()` aborts. So short mode also refuses while:
 *   - an `input` event was seen with no `agent_start` yet (accepted prompt pending; 120 s safety expiry),
 *   - a WOS settled continuation is outstanding (`globalThis.__wosSettledSends`, shared helper), or
 *   - a WOS settled injection was stamped (`globalThis.__wosSettledInjection`) after the last run
 *     start, within 120 s. This also covers an owner that does not use the helper yet.
 *
 * 🔴 R6 (request 2026-09-26): OBSERVABLE + HARD CEILING. Every non-trivial decision is
 * logged, rate-limited per (reason) so a busy session cannot flood the log: `skip` rows carry the reason, a
 * `below-target`/`long` heartbeat row appears at most every `log.heartbeatMs`, and `turn_end` records mid-run
 * over-target peaks (`over-target-run-active`), so an overshoot is visible WHILE it happens, not only after.
 * A run that starts inside the post-settle quiet window is logged (`quiet-window-preempted`). Above the hard
 * ceiling (`hardCeilingRatio` × target, default 1.5) the OM lag defer is skipped at the next safe point (OM's own
 * hook still clamps the cut to its frontier). The safety invariants are unchanged: never mid-run, never with a
 * pending/accepted prompt, never after a false settle. `/compaction status` shows the last skip reason.
 *
 * Never mutates messages, never writes settings. Decisions → ~/.pi/agent/compaction-mode/events.jsonl.
 * Kill switch: `touch ~/.pi/agent/compaction-mode/OFF` or `PI_COMPACTION_MODE=off` ⇒ inert (native).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ENTRY = "wos.compaction.mode";
export const STATUS_KEY = "compaction";
const HOME = os.homedir();
export const STATE_DIR = process.env.WOS_COMPACTION_STATE_DIR ?? path.join(HOME, ".pi", "agent", "compaction-mode");
export const CONFIG_FILE = process.env.WOS_COMPACTION_CONFIG ?? path.join(HOME, ".pi", "agent", "compaction-mode.json");
export const OM_ROOT =
	process.env.WOS_OM_PACKAGE_ROOT ??
	path.join(HOME, ".wos-runtime", "pi_packages", "observational-memory");

export type Mode = "long" | "short";
export type Role = "director" | "butler" | "child" | "interactive";

export interface Config {
	shortTargetTokens: number;
	defaults: Record<Role, Mode>;
	minNewTokensSinceCompaction: number;
	quietDelayMs: number;
	gate: { maxLagTokens: number; maxDeferMs: number; recheckMs: number; keepRecentTokens: number };
	/** R6: above target × ratio the OM lag defer is skipped at the next safe point (0 disables). */
	hardCeilingRatio: number;
	/** R6.2: at ≥ ratio × context window compact at the next safe point regardless of OM (0 disables). */
	emergencyWindowRatio: number;
	/** R6: skip rows repeat at most every skipLogMs per reason; below-target/long heartbeat every heartbeatMs. */
	log: { skipLogMs: number; heartbeatMs: number; maxRowsPerHour: number };
}

export const DEFAULT_CONFIG: Config = {
	shortTargetTokens: 270_000,
	// the owner's decision (2026-09-26, option A): Directors + Butler short; his interactive sessions and
	// subagents long. `/compaction short|long` per session always overrides.
	defaults: { director: "short", butler: "short", child: "long", interactive: "long" },
	// Loop guard: OM's post-compaction floor measured p50 ≈ 115k, p90 ≈ 126k tokens. Require real growth.
	minNewTokensSinceCompaction: 60_000,
	quietDelayMs: 1_500,
	gate: { maxLagTokens: 20_000, maxDeferMs: 180_000, recheckMs: 15_000, keepRecentTokens: 20_000 },
	hardCeilingRatio: 1.5,
	emergencyWindowRatio: 0.9,
	log: { skipLogMs: 300_000, heartbeatMs: 1_800_000, maxRowsPerHour: 30 },
};

/** The canonical OM functions this file reuses. Loaded from the OM package; null if unavailable. */
export interface OmApi {
	computeFrontier: (branch: any[]) => { coveredUpToIndex: number; pending: unknown[]; blockedReason?: string; gap?: unknown };
	estimateEntryTokens: (entry: any) => number;
	isSourceEntry: (entry: any) => boolean;
	resolveDirectorIdentity: (p: { sessionPath: string | null; readDesignations: () => string; readRegistry: () => string }) => { directorId: string } | null;
	defaultDirectorReaders: () => { readDesignations: () => string; readRegistry: () => string };
	/** R6.1: OM's canonical consolidator-run fold + max runtime. Optional: loaded separately; absent ⇒ state unknown. */
	consolidatorRunStates?: (branch: any[]) => Map<string, { runId: string; startedAt: number; terminal: boolean }>;
	consolidatorMaxRuntimeMs?: number;
	/** R6.2: OM's canonical worker-liveness probe (procfs scan for `om-consolidator-<runId>`). */
	consolidatorWorkerAlive?: (runId: string) => Promise<boolean>;
}

export async function loadOmApi(root = OM_ROOT): Promise<OmApi | null> {
	try {
		const frontier = await import(path.join(root, "src", "ledger", "frontier.ts"));
		const progress = await import(path.join(root, "src", "ledger", "progress.ts"));
		const tokens = await import(path.join(root, "src", "tokens.ts"));
		const identity = await import(path.join(root, "src", "identity.ts"));
		const api: OmApi = {
			computeFrontier: frontier.computeFrontier,
			estimateEntryTokens: tokens.estimateEntryTokens,
			isSourceEntry: progress.isSourceEntry,
			resolveDirectorIdentity: identity.resolveDirectorIdentity,
			defaultDirectorReaders: identity.defaultDirectorReaders,
		};
		if (!Object.values(api).every((f) => typeof f === "function")) return null;
		try {
			const cons = await import(path.join(root, "src", "hooks", "consolidator-orphans.ts"));
			if (typeof cons.consolidatorRunStates === "function" && typeof cons.ORPHAN_AFTER_MS === "number") {
				api.consolidatorRunStates = cons.consolidatorRunStates;
				api.consolidatorMaxRuntimeMs = cons.ORPHAN_AFTER_MS;
			}
			if (typeof cons.consolidatorWorkerAlive === "function") api.consolidatorWorkerAlive = cons.consolidatorWorkerAlive;
		} catch {
			/* consolidator state unknown: the ceiling then never bypasses the OM gate */
		}
		return api;
	} catch {
		return null;
	}
}

export interface ConsolidatorState {
	/** true when OM's liveness probe was available (the ceiling may bypass the OM lag defer only then). */
	known: boolean;
	running: boolean;
	runId?: string;
	ageMs?: number;
	basis?: "worker-alive" | "within-max-runtime" | "unprobed-new-run" | "age-only";
}

export interface ConsolidatorLiveness {
	alive: Set<string>;
	probed: Set<string>;
}

/** Unterminated consolidator runs per OM's canonical fold (started, no settled / terminal failure record). */
export function unterminatedConsolidatorRuns(branch: any[], om: OmApi | null): Array<{ runId: string; startedAt: number }> {
	if (!om?.consolidatorRunStates) return [];
	try {
		return [...om.consolidatorRunStates(branch).values()].filter((s) => !s.terminal).map((s) => ({ runId: s.runId, startedAt: s.startedAt }));
	} catch {
		return [];
	}
}

/**
 * R6.2: is an OM consolidator run still in flight? Mirrors the candidate predicate of OM's own
 * `checkConsolidatorOrphans` (src/hooks/consolidator-orphans.ts): an unterminated run is an ORPHAN only when
 * it is older than ORPHAN_AFTER_MS AND OM's `consolidatorWorkerAlive` finds no live worker. So:
 *   live worker ⇒ running, regardless of age;  no worker and younger than ORPHAN_AFTER_MS ⇒ running;
 *   no worker and older ⇒ orphan ⇒ not running.
 * A run that appeared after the liveness probe is treated as running (conservative). Without the liveness
 * probe (`liveness` null) it falls back to age alone and reports known=false.
 */
export function consolidatorStateFrom(branch: any[], om: OmApi | null, now: number, liveness: ConsolidatorLiveness | null): ConsolidatorState {
	if (!om?.consolidatorRunStates || typeof om.consolidatorMaxRuntimeMs !== "number") return { known: false, running: false };
	const known = liveness !== null;
	for (const r of unterminatedConsolidatorRuns(branch, om)) {
		const ageMs = now - r.startedAt;
		const young = r.startedAt > 0 && ageMs < om.consolidatorMaxRuntimeMs;
		if (!liveness) {
			if (young) return { known, running: true, runId: r.runId, ageMs, basis: "age-only" };
			continue;
		}
		if (!liveness.probed.has(r.runId)) return { known, running: true, runId: r.runId, ageMs, basis: "unprobed-new-run" };
		if (liveness.alive.has(r.runId)) return { known, running: true, runId: r.runId, ageMs, basis: "worker-alive" };
		if (young) return { known, running: true, runId: r.runId, ageMs, basis: "within-max-runtime" };
		// no live worker and past OM's max runtime: an orphan by OM's own predicate
	}
	return { known, running: false };
}

/** R6.2: run OM's liveness probe for every unterminated run (async: procfs). null when the probe is unavailable. */
export async function probeConsolidatorLiveness(branch: any[], om: OmApi | null): Promise<ConsolidatorLiveness | null> {
	if (!om?.consolidatorWorkerAlive || !om.consolidatorRunStates) return null;
	const out: ConsolidatorLiveness = { alive: new Set(), probed: new Set() };
	for (const r of unterminatedConsolidatorRuns(branch, om)) {
		let alive = true; // a probe error counts as alive (conservative)
		try {
			alive = await om.consolidatorWorkerAlive(r.runId);
		} catch {
			/* keep alive=true */
		}
		out.probed.add(r.runId);
		if (alive) out.alive.add(r.runId);
	}
	return out;
}


export function loadConfig(file = CONFIG_FILE): Config {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		const pos = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
		const mode = (v: unknown, d: Mode): Mode => (v === "long" || v === "short" ? v : d);
		const D = DEFAULT_CONFIG;
		return {
			shortTargetTokens: pos(raw.shortTargetTokens, D.shortTargetTokens),
			defaults: {
				director: mode(raw.defaults?.director, D.defaults.director),
				butler: mode(raw.defaults?.butler, D.defaults.butler),
				child: mode(raw.defaults?.child, D.defaults.child),
				interactive: mode(raw.defaults?.interactive, D.defaults.interactive),
			},
			minNewTokensSinceCompaction: pos(raw.minNewTokensSinceCompaction, D.minNewTokensSinceCompaction),
			quietDelayMs: pos(raw.quietDelayMs, D.quietDelayMs),
			gate: {
				maxLagTokens: pos(raw.gate?.maxLagTokens, D.gate.maxLagTokens),
				maxDeferMs: pos(raw.gate?.maxDeferMs, D.gate.maxDeferMs),
				recheckMs: Math.max(1_000, pos(raw.gate?.recheckMs, D.gate.recheckMs)),
				keepRecentTokens: pos(raw.gate?.keepRecentTokens, D.gate.keepRecentTokens),
			},
			hardCeilingRatio: raw.hardCeilingRatio === 0 ? 0 : Math.max(1, pos(raw.hardCeilingRatio, D.hardCeilingRatio)),
			emergencyWindowRatio: raw.emergencyWindowRatio === 0 ? 0 : Math.min(0.99, Math.max(0.5, pos(raw.emergencyWindowRatio, D.emergencyWindowRatio))),
			log: {
				skipLogMs: Math.max(10_000, pos(raw.log?.skipLogMs, D.log.skipLogMs)),
				heartbeatMs: Math.max(60_000, pos(raw.log?.heartbeatMs, D.log.heartbeatMs)),
				maxRowsPerHour: Math.max(1, Math.min(600, Math.round(pos(raw.log?.maxRowsPerHour, D.log.maxRowsPerHour)))),
			},
		};
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function killSwitchOn(env: NodeJS.ProcessEnv = process.env, stateDir = STATE_DIR): boolean {
	if ((env.PI_COMPACTION_MODE ?? "").trim().toLowerCase() === "off") return true;
	try {
		return fs.existsSync(path.join(stateDir, "OFF"));
	} catch {
		return false;
	}
}

/** Director only when OM's canonical resolver proves it; otherwise child (launch env) or interactive. */
/** Exact Butler designation in the live projection; anything else (incl. read/parse failure) ⇒ false. */
export function isButlerSession(sessionFile: string | null, readDesignations: () => string): boolean {
	if (!sessionFile) return false;
	try {
		const d = JSON.parse(readDesignations());
		if (!d || typeof d !== "object" || Array.isArray(d)) return false;
		const row = (d as any).Butler;
		return !!row && typeof row === "object" && row.director_id === "Butler" && row.state === "active" && row.session_path === sessionFile;
	} catch {
		return false;
	}
}

export function classifyRole(sessionFile: string | null, om: OmApi | null, env: NodeJS.ProcessEnv = process.env): Role {
	if (om && sessionFile) {
		let readers: { readDesignations: () => string; readRegistry: () => string } | null = null;
		try {
			readers = om.defaultDirectorReaders();
			if (om.resolveDirectorIdentity({ sessionPath: sessionFile, ...readers })?.directorId) return "director";
		} catch {
			/* unproven ⇒ not a Director */
		}
		if (readers && isButlerSession(sessionFile, readers.readDesignations)) return "butler";
	}
	if ((env.PI_SUBAGENT_AGENT ?? "").trim() || (env.PI_SUBAGENT_NAME ?? "").trim()) return "child";
	return "interactive";
}

export interface ModeState {
	mode: Mode;
	targetTokens: number;
	source: "session" | "default";
}

/** Last explicit switch on THIS branch wins; `{mode:"default"}` clears it. */
export function resolveMode(branch: any[], role: Role, cfg: Config): ModeState {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e?.type !== "custom" || e?.customType !== ENTRY) continue;
		const m = e.data?.mode;
		if (m === "default") break;
		if (m === "long" || m === "short") {
			const t = Number(e.data?.targetTokens);
			return { mode: m, targetTokens: Number.isFinite(t) && t > 0 ? t : cfg.shortTargetTokens, source: "session" };
		}
	}
	return { mode: cfg.defaults[role], targetTokens: cfg.shortTargetTokens, source: "default" };
}

function sourceTokens(e: any, om: OmApi | null): number {
	if (om) {
		try {
			return om.isSourceEntry(e) ? om.estimateEntryTokens(e) : 0;
		} catch {
			return 0;
		}
	}
	if (e?.type !== "message" && e?.type !== "custom_message") return 0;
	try {
		return Math.ceil(JSON.stringify((e.type === "message" ? e.message?.content : e.content) ?? "").length / 4);
	} catch {
		return 0;
	}
}

/** Source tokens appended after the newest compaction entry on the branch (all of it if none). */
export function tokensSinceLastCompaction(branch: any[], om: OmApi | null = null): number {
	let n = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i]?.type === "compaction") break;
		n += sourceTokens(branch[i], om);
	}
	return n;
}

export interface OmGate {
	omEnabled: boolean;
	available: boolean;
	inFlight: number;
	coveredIndex: number;
	cutIndex: number;
	lagTokens: number;
	blocked?: string;
}

/**
 * OM coverage vs the projected cut, using OM's own frontier. Lag = source tokens still in context
 * (after the last compaction's firstKept boundary) that lie between the covered frontier and the cut
 * where the newest `keepRecentTokens` begin.
 */
export function omGate(branch: any[], keepRecentTokens: number, om: OmApi | null): OmGate {
	let omEnabled = false;
	for (const e of branch) if (e?.type === "custom" && e.customType === "om.enabled") omEnabled = e.data?.enabled === true;
	if (!om) return { omEnabled, available: false, inFlight: 0, coveredIndex: -1, cutIndex: branch.length, lagTokens: 0, blocked: "om-api-unavailable" };
	const f = om.computeFrontier(branch);
	let tail = 0;
	let cutIndex = branch.length;
	for (let i = branch.length - 1; i >= 0; i--) {
		tail += sourceTokens(branch[i], om);
		if (tail >= keepRecentTokens) {
			cutIndex = i;
			break;
		}
	}
	// In-context floor: entries before the last compaction's firstKept are already summarized.
	let floor = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i]?.type !== "compaction") continue;
		const kept = branch.findIndex((e) => e?.id === branch[i].firstKeptEntryId);
		floor = kept >= 0 ? kept - 1 : i;
		break;
	}
	let lagTokens = 0;
	for (let i = Math.max(f.coveredUpToIndex, floor) + 1; i < cutIndex; i++) lagTokens += sourceTokens(branch[i], om);
	return { omEnabled, available: true, inFlight: f.pending.length, coveredIndex: f.coveredUpToIndex, cutIndex, lagTokens, blocked: f.blockedReason };
}

const FINAL_STOP = new Set(["stop", "length", "error", "aborted"]);

/**
 * R5 (09-20 failure class): Pi can emit a FALSE agent_settled. A concurrent prompt rejected with
 * "Agent is already processing a prompt" runs `_runAgentPrompt`'s finally, which clears
 * `_isAgentRunActive` and emits agent_settled while the first run is still active. So a compaction
 * needs a structural proof that the transcript is at rest: the last role message on the branch is an
 * assistant message with a FINAL stopReason, and it is not an `aborted` produced by our own compaction.
 */
export function lastMessageFinal(branch: any[], ownCompactAt = 0): { ok: boolean; why: string } {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e?.type !== "message") continue;
		const m = e.message ?? {};
		if (m.role !== "assistant") return { ok: false, why: `last-message-${m.role ?? "unknown"}` };
		const sr = String(m.stopReason ?? "");
		if (!FINAL_STOP.has(sr)) return { ok: false, why: `assistant-stopReason-${sr || "none"}` };
		const ts = typeof m.timestamp === "number" ? m.timestamp : Date.parse(e.timestamp ?? "") || 0;
		if (sr === "aborted" && ownCompactAt && ts >= ownCompactAt) return { ok: false, why: "own-abort" };
		return { ok: true, why: sr };
	}
	return { ok: false, why: "no-message" };
}

export type Decision =
	| { action: "none"; why: string }
	| { action: "defer"; why: string; gate: OmGate }
	| { action: "compact"; why: string; gate?: OmGate };

/** Pure decision: should short mode compact now? `deferStartedAt` bounds the OM gate. */
export function decide(p: {
	state: ModeState;
	tokens: number | null;
	branch: any[];
	cfg: Config;
	idle: boolean;
	pending: boolean;
	now: number;
	deferStartedAt: number | null;
	om?: OmApi | null;
	/** Why a prompt may be pending although Pi reports idle (R4); null when none. */
	promptPending?: string | null;
	/** R5: own agent_start/agent_end accounting shows no open loop and a settle after the latest end. */
	quiescent?: boolean;
	/** R5: when this file last triggered a compaction (to discount our own `aborted`). */
	ownCompactAt?: number;
	/** R6.2: consolidator state from OM's liveness probe; absent ⇒ unknown and not running. */
	consolidator?: ConsolidatorState;
	/** R6.2: the model context window (emergency valve); absent ⇒ valve off. */
	contextWindow?: number | null;
}): Decision {
	const { state, tokens, branch, cfg } = p;
	const om = p.om ?? null;
	if (state.mode !== "short") return { action: "none", why: "long-mode-native" };
	if (tokens === null || tokens === undefined) return { action: "none", why: "no-usage-yet" };
	if (tokens <= state.targetTokens) return { action: "none", why: "below-target" };
	if (!p.idle || p.pending) return { action: "none", why: "not-idle-or-message-pending" };
	if (p.promptPending) return { action: "none", why: `prompt-pending:${p.promptPending}` };
	if (p.quiescent === false) return { action: "none", why: "run-not-quiescent" };
	const fin = lastMessageFinal(branch, p.ownCompactAt ?? 0);
	if (!fin.ok) return { action: "none", why: `not-at-rest:${fin.why}` };
	if (branch[branch.length - 1]?.type === "compaction") return { action: "none", why: "already-compacted" };
	if (tokensSinceLastCompaction(branch, om) < cfg.minNewTokensSinceCompaction) return { action: "none", why: "loop-guard-min-growth" };
	const gate = omGate(branch, cfg.gate.keepRecentTokens, om);
	// R6.2 emergency valve: at ≥ emergencyWindowRatio × the context window, compact at this safe point even
	// if OM lags or a consolidator runs (OM's hook still clamps the cut to its frontier). Never mid-run: all
	// the idle/pending/quiescent/at-rest checks above still apply.
	const win = Number(p.contextWindow);
	if (cfg.emergencyWindowRatio > 0 && Number.isFinite(win) && win > 0 && tokens >= cfg.emergencyWindowRatio * win)
		return { action: "compact", why: "emergency-window", gate };
	if (!gate.omEnabled) return { action: "compact", why: "over-target-om-off-native-summary" };
	// R6.1: never compact while an OM consolidator run is unterminated (bounded by OM's own max runtime:
	// past it the run is an orphan by OM's definition). Applies to every path below, incl. the ceiling.
	const cons: ConsolidatorState = p.consolidator ?? { known: false, running: false };
	if (cons.running) return { action: "defer", why: "om-consolidator-running", gate };
	const behind = !gate.available || gate.inFlight > 0 || gate.lagTokens > cfg.gate.maxLagTokens;
	if (!behind) return { action: "compact", why: "over-target-om-covered", gate };
	// R6 hard ceiling: far above target, waiting for OM coverage costs more than it saves. OM's own
	// session_before_compact hook still waits for its observers and clamps the cut to its frontier.
	const ceiling = ceilingTokens(state, cfg);
	if (ceiling !== null && tokens > ceiling && cons.known) return { action: "compact", why: "over-ceiling-proceed-om-clamps", gate };
	const started = p.deferStartedAt ?? p.now;
	if (p.now - started >= cfg.gate.maxDeferMs) return { action: "compact", why: "om-gate-bound-reached-proceed-om-clamps", gate };
	const why = !gate.available ? "om-api-unavailable" : gate.inFlight > 0 ? "om-observers-in-flight" : "om-coverage-lag";
	return { action: "defer", why, gate };
}

/** R6: the hard ceiling for a short-mode session, or null (long mode / disabled). */
export function ceilingTokens(state: ModeState, cfg: Config): number | null {
	if (state.mode !== "short" || !cfg.hardCeilingRatio) return null;
	return Math.round(state.targetTokens * cfg.hardCeilingRatio);
}

/**
 * R6.1: canonical rate-limit key for a decision reason. Dynamic parts (owner names, run/session ids,
 * numbers) are stripped so the key set is bounded; the row itself still carries the full reason.
 */
export function reasonKey(why: string): string {
	return String(why)
		.replace(/^(prompt-pending:wos-settled-send):[^:]*:/, "$1:*:")
		.replace(/^(prompt-pending:wos-settled-injection):.*$/, "$1:*")
		.replace(/^(not-at-rest:assistant-stopReason)-.*$/, "$1-*")
		.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4,})+/gi, "<id>")
		.replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
		.replace(/\d+/g, "<n>")
		.slice(0, 80);
}

/**
 * R6.1: global cap on decision rows (skip/eval/defer) per session: at most `max()` rows per rolling hour.
 * `take()` returns null when capped; otherwise the number of rows suppressed since the last written one.
 */
export function makeHourlyCap(now: () => number, max: () => number) {
	const written: number[] = [];
	let suppressed = 0;
	return {
		take(): number | null {
			const t = now();
			while (written.length && t - written[0] >= 3_600_000) written.shift();
			if (written.length >= max()) {
				suppressed++;
				return null;
			}
			written.push(t);
			const s = suppressed;
			suppressed = 0;
			return s;
		},
	};
}

/** R6: per-reason rate limiter for decision rows. Returns true when this row should be written. */
export function makeRateLimiter(now: () => number) {
	const lastAt = new Map<string, number>();
	return (key: string, intervalMs: number): boolean => {
		const t = now();
		const prev = lastAt.get(key);
		if (prev !== undefined && t - prev < intervalMs) return false;
		lastAt.set(key, t);
		return true;
	};
}

export function logEvent(row: Record<string, unknown>, stateDir = STATE_DIR): void {
	try {
		fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		fs.appendFileSync(path.join(stateDir, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n", { mode: 0o600 });
	} catch {
		/* telemetry must never break a session */
	}
}

export function statusText(state: ModeState, off: boolean): string {
	if (off) return "cmp:off(native)";
	return state.mode === "short" ? `cmp:short ${Math.round(state.targetTokens / 1000)}k` : "cmp:long";
}

export default async function compactionMode(
	pi: any,
	deps: { now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout; om?: OmApi | null } = {},
) {
	if ((process.env.OM_WORKER ?? "").trim()) return; // never inside OM's own worker subprocesses
	const now = deps.now ?? Date.now;
	const setTimer = deps.setTimer ?? setTimeout;
	const clearTimer = deps.clearTimer ?? clearTimeout;
	const om: OmApi | null = deps.om !== undefined ? deps.om : await loadOmApi();
	if (!om) logEvent({ ev: "om-api-unavailable", root: OM_ROOT });
	let cfg = loadConfig();
	let role: Role = "interactive";
	let state: ModeState = { mode: "long", targetTokens: cfg.shortTargetTokens, source: "default" };
	let sessionId = "";
	let timer: any = null;
	let deferStartedAt: number | null = null;
	let compacting = false; // a compaction THIS file started is in flight
	let runActive = false; // own tracking: agent_start → agent_settled (kept for the race cancel)
	let loopsOpen = 0; // R5: agent_start ++ / agent_end -- (Pi emits one pair per agent loop, incl. continue)
	// Event ORDER, not wall time: several lifecycle events can share one millisecond.
	let evSeq = 0;
	let lastStartAt = 0;
	let lastEndAt = 0;
	let lastSettleAt = 0;
	let ownCompactAt = 0;
	let pendingInputs = 0; // R5: counter, not a flag — two prompts can be in flight before one starts
	let lastInputAt = 0;
	const quiescent = () => loopsOpen === 0 && lastSettleAt > lastEndAt && lastSettleAt > lastStartAt || (loopsOpen === 0 && lastStartAt === 0 && lastEndAt === 0);
	let runStartedSinceTrigger = false;
	let lastRunStartAt = 0;
	const PENDING_EXPIRY_MS = 120_000;
	const promptPending = (): string | null => {
		const t = now();
		if (pendingInputs > 0 && t - lastInputAt < PENDING_EXPIRY_MS) return "input-accepted-run-not-started";
		if (pendingInputs > 0) {
			logEvent({ ev: "input-pending-expired", sessionId, pendingInputs, ageMs: t - lastInputAt });
			pendingInputs = 0;
		}
		try {
			const reg = (globalThis as any).__wosSettledSends ?? {};
			for (const [owner, v] of Object.entries<any>(reg)) {
				if (v && (v.state === "unsent" || v.state === "issued" || v.state === "accepted")) return `wos-settled-send:${owner}:${v.state}`;
			}
			const st = (globalThis as any).__wosSettledInjection;
			if (st && typeof st.at === "number" && st.at > lastRunStartAt && t - st.at < PENDING_EXPIRY_MS) return `wos-settled-injection:${st.by ?? "?"}`;
		} catch {
			/* ignore */
		}
		return null;
	};
	let last = "";
	// R6 observability: last skip, over-target episode (first crossing, peak), per-reason rate limiter.
	const allow = makeRateLimiter(now);
	const cap = makeHourlyCap(now, () => cfg.log.maxRowsPerHour);
	let lastSkip: { why: string; at: number; tokens: number | null } | null = null;
	let overSince: number | null = null;
	let peakTokens = 0;
	const observeTokens = (tokens: number | null) => {
		if (tokens === null || state.mode !== "short") return;
		if (tokens <= state.targetTokens) {
			overSince = null;
			peakTokens = 0;
			return;
		}
		if (overSince === null) overSince = now();
		if (tokens > peakTokens) peakTokens = tokens;
	};
	const TRIVIAL = new Set(["below-target", "long-mode-native", "no-usage-yet"]);
	const noteSkip = (why: string, tokens: number | null, extra: Record<string, unknown> = {}) => {
		lastSkip = { why, at: now(), tokens };
		const trivial = TRIVIAL.has(why);
		const key = trivial ? "heartbeat" : `skip:${reasonKey(why)}`;
		if (!allow(key, trivial ? cfg.log.heartbeatMs : cfg.log.skipLogMs)) return;
		const suppressed = cap.take();
		if (suppressed === null) return; // global per-session hourly cap reached
		const ceiling = ceilingTokens(state, cfg);
		logEvent({
			...(suppressed > 0 ? { suppressedSinceLast: suppressed } : {}),
			ev: trivial ? "eval" : "skip",
			why,
			sessionId,
			tokens,
			target: state.mode === "short" ? state.targetTokens : null,
			ceiling,
			role,
			mode: state.mode,
			overMs: overSince === null ? null : now() - overSince,
			peakTokens: overSince === null ? null : peakTokens,
			...extra,
		});
	};

	const branchOf = (ctx: any): any[] => {
		try {
			return ctx.sessionManager.getBranch() ?? [];
		} catch {
			return [];
		}
	};
	const refresh = (ctx: any) => {
		cfg = loadConfig();
		let file: string | null = null;
		try {
			file = String(ctx.sessionManager.getSessionFile?.() ?? "") || null;
			sessionId = path.basename(file ?? "");
		} catch {
			/* ignore */
		}
		role = classifyRole(file, om);
		state = resolveMode(branchOf(ctx), role, cfg);
		try {
			ctx.ui?.setStatus?.(STATUS_KEY, statusText(state, killSwitchOn()));
		} catch {
			/* no UI */
		}
	};
	const cancelTimer = () => {
		if (timer) clearTimer(timer);
		timer = null;
	};
	const schedule = (ctx: any, ms: number) => {
		cancelTimer();
		timer = setTimer(() => {
			timer = null;
			evaluate(ctx);
		}, ms);
		timer?.unref?.();
	};

	let probing = false;
	const evaluate = async (ctx: any) => {
		if (killSwitchOn() || compacting || probing) return;
		// R6.2: OM's consolidator liveness probe is async (procfs); run it only when a run is unterminated,
		// then re-read EVERYTHING below (the probe yields, so the session may have moved on).
		let liveness: ConsolidatorLiveness | null = null;
		if (state.mode === "short" && om?.consolidatorRunStates) {
			const b0 = branchOf(ctx);
			if (unterminatedConsolidatorRuns(b0, om).length > 0) {
				probing = true;
				try {
					liveness = await probeConsolidatorLiveness(b0, om);
				} finally {
					probing = false;
				}
				if (killSwitchOn() || compacting) return;
			} else if (om.consolidatorWorkerAlive) liveness = { alive: new Set(), probed: new Set() };
		}
		let idle = false;
		let pending = true;
		let tokens: number | null = null;
		let contextWindow: number | null = null;
		try {
			idle = !!ctx.isIdle() && !runActive;
			pending = !!ctx.hasPendingMessages?.();
			const u = ctx.getContextUsage?.();
			tokens = u?.tokens ?? null;
			contextWindow = u?.contextWindow ?? ctx.model?.contextWindow ?? null;
		} catch {
			return; // stale ctx after session replacement
		}
		observeTokens(tokens);
		const branch = branchOf(ctx);
		const pp = state.mode === "short" ? promptPending() : null;
		const consolidator = consolidatorStateFrom(branch, om, now(), liveness);
		const d = decide({ state, tokens, branch, cfg, idle, pending, now: now(), deferStartedAt, om, promptPending: pp, quiescent: quiescent(), ownCompactAt, consolidator, contextWindow });
		if (d.action === "none" && (d.why.startsWith("prompt-pending") || d.why === "run-not-quiescent" || d.why.startsWith("not-at-rest"))) {
			last = `${d.action}:${d.why}`;
			noteSkip(d.why, tokens);
			schedule(ctx, Math.max(cfg.quietDelayMs, 5_000)); // bounded re-check; the next settle also re-arms
			return;
		}
		last = `${d.action}:${d.why}`;
		if (d.action === "none") {
			noteSkip(d.why, tokens);
			if (d.why === "below-target" || d.why === "long-mode-native") deferStartedAt = null;
			return;
		}
		if (d.action === "defer") {
			if (deferStartedAt === null) deferStartedAt = now();
			lastSkip = { why: `defer:${d.why}`, at: now(), tokens };
			const suppressed = allow(`defer:${reasonKey(d.why)}`, cfg.gate.recheckMs * 4) ? cap.take() : null;
			if (suppressed !== null)
				logEvent({ ...(suppressed > 0 ? { suppressedSinceLast: suppressed } : {}), ev: "defer", why: d.why, sessionId, tokens, role, gate: d.gate, deferredMs: now() - deferStartedAt, ...(d.why === "om-consolidator-running" ? { consolidator } : {}) });
			schedule(ctx, cfg.gate.recheckMs);
			return;
		}
		const deferredMs = deferStartedAt === null ? 0 : now() - deferStartedAt;
		deferStartedAt = null;
		compacting = true;
		ownCompactAt = now();
		runStartedSinceTrigger = false;
		logEvent({
			ev: "compact",
			why: d.why,
			sessionId,
			tokens,
			target: state.targetTokens,
			ceiling: ceilingTokens(state, cfg),
			role,
			gate: d.gate,
			deferredMs,
			overMs: overSince === null ? 0 : now() - overSince,
			peakTokens,
			overshootTokens: Math.max(0, peakTokens - state.targetTokens),
			contextWindow,
			...(consolidator.running ? { consolidator } : {}),
		});
		const done = (ev: string, extra: Record<string, unknown> = {}) => {
			compacting = false;
			logEvent({ ev, sessionId, tokensBefore: tokens, ...extra });
		};
		try {
			ctx.compact({
				onComplete: () => done("compacted"),
				onError: (err: Error) => done("compact-failed", { error: String(err?.message ?? err).slice(0, 300) }),
			});
		} catch (err: any) {
			done("compact-failed", { error: String(err?.message ?? err).slice(0, 300) });
		}
	};

	pi.on("session_start", (_e: any, ctx: any) => {
		runActive = false;
		loopsOpen = 0;
		pendingInputs = 0;
		refresh(ctx);
		if (state.mode === "short") schedule(ctx, cfg.quietDelayMs);
	});
	pi.on("input", () => {
		if (loopsOpen === 0) { // input during an open loop is queued into that run
			pendingInputs++;
			lastInputAt = now();
		}
		return undefined; // never transforms or handles
	});
	pi.on("agent_start", (_e: any, ctx: any) => {
		// A NEW run (not an internal continue loop: those start before the run's settle) consumes one
		// accepted prompt.
		const newRun = loopsOpen === 0 && lastSettleAt >= lastEndAt; // (sequence numbers; equal only when both 0)
		runActive = true;
		loopsOpen++;
		lastStartAt = ++evSeq;
		if (newRun && pendingInputs > 0) pendingInputs--;
		lastRunStartAt = now();
		if (compacting) runStartedSinceTrigger = true;
		if (timer && state.mode === "short") {
			let tokens: number | null = null;
			try {
				tokens = ctx?.getContextUsage?.()?.tokens ?? null;
			} catch {
				/* stale ctx */
			}
			observeTokens(tokens);
			if (tokens !== null && tokens > state.targetTokens) noteSkip("quiet-window-preempted", tokens);
		}
		cancelTimer();
	});
	// R6: observe (never act) at every turn boundary inside a run, so a mid-run overshoot is visible.
	pi.on("turn_end", (_e: any, ctx: any) => {
		if (state.mode !== "short" || killSwitchOn()) return undefined;
		let tokens: number | null = null;
		try {
			tokens = ctx.getContextUsage?.()?.tokens ?? null;
		} catch {
			return undefined;
		}
		observeTokens(tokens);
		if (tokens !== null && tokens > state.targetTokens) {
			const ceiling = ceilingTokens(state, cfg);
			noteSkip(ceiling !== null && tokens > ceiling ? "over-ceiling-run-active" : "over-target-run-active", tokens);
		}
		return undefined; // observation only: no drafts, no continuation
	});
	pi.on("agent_end", () => {
		loopsOpen = Math.max(0, loopsOpen - 1);
		lastEndAt = ++evSeq;
	});
	pi.on("agent_settled", (_e: any, ctx: any) => {
		runActive = false;
		lastSettleAt = ++evSeq;
		// request 2026-10-05: a fresh Director is designated AFTER its session_start (bootstrap registers
		// it last), so session_start classified it interactive/child -> long until a reload. Re-classify at each settle
		// until it resolves as director/butler (two small file reads; stops once proven, never demotes a proven role).
		if (role !== "director" && role !== "butler") {
			const before = role;
			refresh(ctx);
			if (role !== before) logEvent({ ev: "reclassified", sessionId, from: before, role, mode: state.mode });
		}
		if (state.mode === "short" && !killSwitchOn()) schedule(ctx, cfg.quietDelayMs);
	});
	// A message delivered during OUR compaction started a run: cancel ours rather than race it.
	pi.on("session_before_compact", (event: any) => {
		if (!compacting || event?.reason !== "manual") return undefined;
		const pp = promptPending();
		if (runStartedSinceTrigger || runActive || pp || !quiescent()) {
			logEvent({ ev: "cancel-run-started-during-compaction", sessionId, promptPending: pp });
			return { cancel: true };
		}
		return undefined;
	});
	pi.on("session_shutdown", () => cancelTimer());

	pi.registerCommand("compaction", {
		description: "Per-session compaction point: /compaction short [tokens] | long | default | status",
		handler: async (args: string, ctx: any) => {
			const [verb, num] = String(args ?? "").trim().split(/\s+/);
			refresh(ctx);
			const say = (m: string) => {
				try {
					ctx.ui?.notify?.(m, "info");
				} catch {
					/* headless */
				}
			};
			if (verb === "short" || verb === "long" || verb === "default") {
				const t = Number(num);
				const targetTokens = verb === "short" && Number.isFinite(t) && t >= 50_000 ? Math.round(t) : cfg.shortTargetTokens;
				pi.appendEntry(ENTRY, { mode: verb, targetTokens, role, at: new Date().toISOString() });
				refresh(ctx);
				logEvent({ ev: "switch", sessionId, mode: verb, targetTokens, role });
				say(`compaction: ${statusText(state, killSwitchOn())} (${state.source})`);
				if (state.mode === "short") schedule(ctx, cfg.quietDelayMs);
				else cancelTimer();
				return;
			}
			let tokens: number | null = null;
			let win: number | null = null;
			try {
				const u = ctx.getContextUsage?.();
				tokens = u?.tokens ?? null;
				win = u?.contextWindow ?? ctx.model?.contextWindow ?? null;
			} catch {
				/* ignore */
			}
			const g = omGate(branchOf(ctx), cfg.gate.keepRecentTokens, om);
			say(
				[
					`compaction ${statusText(state, killSwitchOn())} — source=${state.source} role=${role}`,
					`context=${tokens ?? "?"} window=${win ?? "?"} ${state.mode === "short" ? `trigger>${state.targetTokens} (idle)` : "native trigger"}`,
					`OM ${g.omEnabled ? "on" : "off"}${g.available ? "" : " (api unavailable)"}: inFlight=${g.inFlight} lagToCut=${g.lagTokens} (max ${cfg.gate.maxLagTokens}, defer ≤${cfg.gate.maxDeferMs / 1000}s)${g.blocked ? ` blocked=${g.blocked}` : ""}`,
					`ceiling=${ceilingTokens(state, cfg) ?? "-"}${overSince !== null ? ` · over target ${Math.round((now() - overSince) / 1000)}s, peak ${peakTokens}` : ""}`,
					`last=${last || "none"}${lastSkip ? ` · last skip=${lastSkip.why} ${Math.round((now() - lastSkip.at) / 1000)}s ago` : ""}${killSwitchOn() ? " · KILL SWITCH ON" : ""}`,
				].join("\n"),
			);
		},
	});
}
