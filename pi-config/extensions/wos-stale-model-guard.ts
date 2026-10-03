/**
 * wos-stale-model-guard — a RESTORED session must not launch on a model you can no longer use,
 * and a 403 must never be rendered as "An unknown error occurred (Unexpected)".
 *
 * 🔴 INCIDENT 2026-09-22 ~20:30 CEST. the owner ran plain `pi` twice from the WOS root. Both printed
 * the banner and then died with `error: An unknown error occurred (Unexpected)`. It looked like a
 * launch failure. It was not. Session `<session>` (last touched 2026-09-19) was RESTORED with its
 * pinned model `openai/gpt-6-astra`; his `hi` came back:
 *
 *     OpenAI API error (403): 403 Access to this Codex model is currently restricted.
 *     See https://intranet.example/codex-gpt-6 for the latest access status.
 *
 * Pi auto-switched to `anthropic/claude-fable-5-1`, which answered:
 *
 *     403 Access to Fable is currently restricted.
 *     See https://intranet.example/claude-fable-5 for the latest access status.
 *
 * Both exact remedies were sitting in the session record; neither reached the screen.
 * (Verbatim from entries 22 and 25 of
 *  ~/.pi/agent/sessions/--home-owner-wisdom-os-Wisdom OS--/
 *  2026-09-19T15-58-15-761Z_SESSION-ID.jsonl)
 *
 * Two independent defects, both closed here:
 *
 *  1. A RESTORED model bypasses the current enabled-model scope. Global settings were already
 *     correct; the stale session simply re-pinned something outside it. `pi --list-models` still
 *     ADVERTISES the restricted models, so listing is not entitlement — only a real call proves
 *     access.
 *  2. A provider 403 carrying an actionable URL was collapsed into a generic message.
 *
 * 🔴 WHICH HOOK ACTUALLY FIRES — measured, not assumed. `docs/extensions.md` says `model_select`
 * fires on "session restore" with `event.source === "restore"`. IT DOES NOT, in Pi at employer 0.86.1.
 * The shipped build has exactly three `_emitModelSelect` call sites — `setModel(...,"set")` and two
 * `cycleModel(...,"cycle")` — and the string `"restore"` appears nowhere in the binary as a
 * model_select source. A full hook trace of a restored stale session confirms it: `model_select`
 * never fires at startup. The hook that does is `session_start`, and it already carries the
 * restored pin:
 *
 *   session_start           reason=startup  ctx.model=anthropic/claude-fable-5-1   t+0ms
 *   before_agent_start                      ctx.model=anthropic/claude-fable-5-1   t+174ms
 *   before_provider_request payload=claude-fable-5-1                               t+204ms  ← 403
 *
 * So the scope check runs on `session_start`, 204 ms before the first provider request is built.
 * The `model_select`/`restore` handler is KEPT as forward-compatible cover: if a later Pi starts
 * emitting the documented source, the same check runs there and the `session_start` pass is a
 * no-op (the model is in scope by then). Evidence:
 * ~/.wos-runtime/staging/stale-model-guard-20260922/live-proof/probe/order.jsonl
 *
 * Deliberately narrow: only a RESTORED pin is remapped. An explicit `/model` pick or a Ctrl+P
 * cycle is a live human choice and is never second-guessed — not even across a `/reload`, because
 * an explicit pick is remembered for the life of the process. If that model 403s, the user sees
 * the exact reason (defect 2) and decides. Recursion is guarded, because `setModel` re-enters the
 * `model_select` hook (with source "set").
 *
 * COEXISTENCE. `wos-model-catalog-gap.ts` re-registers the `anthropic` provider so that
 * `claude-opus-5-5` exists at all. This guard never looks at a hardcoded model list: scope is
 * the CURRENT `enabledModels` resolved against the live registry (or the launch `--models`), so a model that the
 * catalog-gap extension adds and `enabledModels` allows is in scope by construction.
 *
 * @pi-child-safe: startup scope check + 403 surfacing only; honours the child's launch --model (never remaps an explicit dispatch pin); no transcript mutation, no file I/O unless WOS_STALE_MODEL_GUARD_LOG is set.
 *
 * LAUNCH `--model` IS A CHOICE, NOT A RESTORE (2026-09-22, request 2026-09-22).
 * `session_start` reports a model named on the command line exactly like a restored pin
 * (reason=startup). Once this guard is loaded into subagent children, a Director's explicit
 * dispatch `model:` outside `enabledModels` would have been silently remapped to the default.
 * So a pinned model equal to this process's own `--model` argument is treated like a human pick.
 *
 * 🔴 INCIDENT 2026-09-23 11:43–11:56Z — THIS GUARD SWITCHED DIRECTORS TO OPUS 5 ON /reload
 * (request 2026-09-23). Butler's reload wave left DIR-example,
 * example-project and DIR-example on `anthropic/claude-opus-5` although settings.json allowed only
 * `claude-opus-5-5` (+ two GPTs + muse). The hypothesis "old binary lacks 5.5" was REFUTED: the
 * catalog lives in the on-disk employer extension (re-read on every /reload), DIR-example's deleted exe is
 * byte-identical to the current pi.real, and an old e37140 build lists 5.5 too. The actor was this
 * guard, via two defects, reproduced in isolation (staging/reload-model-guard-20260923/evidence):
 *
 *  3. `ctx.scopedModels` is Pi's STARTUP snapshot. Settings reload never refreshes it. A process
 *     started before 5.5 was enabled keeps a scope without 5.5 (and with opus-5 first) forever, so
 *     5.5 looked out of scope and the "remap" chose scoped[0] = claude-opus-5.
 *  4. The "remembered for the life of the process" human pick lived in the extension instance.
 *     /reload re-activates every extension, so the pick was forgotten exactly when it mattered.
 *
 * Fixes: scope is re-derived from the CURRENT `enabledModels` in settings.json against the live
 * registry on every check (the launch `--models` flag still wins, because that IS the scope); a
 * human pick is stored process-wide (globalThis, keyed by session) so it survives /reload; and the
 * check also runs on `before_agent_start` — every prompt, the earliest hook before a provider
 * request — so an out-of-scope model that appears after session_start (a fallback, a failed
 * startup remap) is remapped to the configured default on the next turn, and a remap that cannot
 * happen (default unregistered, no auth) is reported on EVERY turn instead of silently continuing.
 * If the configured default is enabled but not currently registered, the guard refuses to guess
 * another model and says so.
 *
 * 🔴 INCIDENT 2026-09-24 ~05:4xZ — A SELF-CONTRADICTING ERROR (request 2026-09-24).
 * "anthropic/claude-opus-5-5 is outside your enabled models, but the default anthropic/claude-opus-5-5
 * is not registered right now": the restored model was the default and was enabled. Scope had been
 * decided from a live `getAvailable()` snapshot that lacked the anthropic models at that instant
 * (anthropic is env/auth-gated and registered by employer's extension + wos-model-catalog-gap, queued
 * until the runner initialises). Fixes: (1) the configured default is never warned about or remapped;
 * (2) "enabled" is decided from the configured patterns (`enabledByConfig`, literal-first kept); the
 * registry only supplies the remap TARGET; (3) a snapshot missing the running model is "registry not
 * ready" — a quiet trace, no notice, re-checked on the next turn. Real protection unchanged: a
 * restored model NOT enabled, with a registered default, still remaps; a genuinely unregistered
 * default (registry does hold the running model) still errors every turn.
 *
 * ── OPERATIONS ───────────────────────────────────────────────────────────────────────────────
 * KILL SWITCH        WOS_STALE_MODEL_GUARD=0 | off | false | no   → activate() registers nothing.
 * TRACE LOG          WOS_STALE_MODEL_GUARD_LOG=/path/to.jsonl     → one JSON line per decision.
 *                    Unset (default) = no file I/O at all.
 * TARGET OVERRIDE    WOS_STALE_MODEL_GUARD_TARGET=provider/id     → preferred remap target; used
 *                    only if that model is in scope, else ignored.
 * EVENT BUS          every decision is emitted on `pi.events` as "wos:stale-model-guard".
 *
 * INSTALL   ln -sfn ~/.wos-runtime/pi_extensions/wos-stale-model-guard.ts \
 *                   ~/.pi/agent/extensions/wos-stale-model-guard.ts
 * REVERT    rm -f ~/.pi/agent/extensions/wos-stale-model-guard.ts
 *           (one command; the source file stays in ~/.wos-runtime/pi_extensions/ and is inert
 *            until it is symlinked back. Pre-change snapshot + SHA256SUMS:
 *            ~/.wos-runtime/staging/stale-model-guard-20260922/)
 * TESTS     /usr/local/lib/happy_cli/node \
 *             ~/.wos-runtime/pi_extensions/wos_stale_model_guard_test.mjs
 *           (add --mutants for the known-bad run: every test must go red)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TAG = "wos-stale-model-guard";
const TRACE_EVENT = "wos:stale-model-guard";

type ModelRef = { provider?: string; id?: string } | undefined;

function key(m: ModelRef): string {
	return m ? `${m.provider ?? "?"}/${m.id ?? "?"}` : "none";
}

/** message_end carries `{ provider, model }` (model is the id string), not `{ provider, id }`. */
function messageKey(m: { provider?: string; model?: string } | undefined): string {
	return m ? `${m.provider ?? "?"}/${m.model ?? "?"}` : "none";
}

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/i;

/** The model named by this process's own `--model` flag (thinking suffix stripped), or null. */
export function cliModel(argv: readonly string[] = process.argv): string | null {
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		let v: string | undefined;
		if (a === "--model") v = argv[i + 1];
		else if (a.startsWith("--model=")) v = a.slice("--model=".length);
		if (v && !v.startsWith("-")) return v.replace(THINKING_SUFFIX, "");
	}
	return null;
}

/** Does the pinned model equal the launch `--model` (either `provider/id` or a bare `id`)? */
export function isLaunchPick(pinned: ModelRef, argv: readonly string[] = process.argv): boolean {
	const cli = cliModel(argv);
	if (!cli || !pinned) return false;
	return cli.includes("/") ? cli === key(pinned) : cli === pinned.id;
}

function disabled(): boolean {
	return /^(0|off|false|no)$/i.test(String(process.env.WOS_STALE_MODEL_GUARD ?? "").trim());
}

/** Entitlement refusals: a status 401/403, or a provider phrasing that means "not for you". */
export function isAccessRefusal(text: string): boolean {
	if (/(^|[^\d])(401|403)([^\d]|$)/.test(text)) return true;
	return /\b(access (?:to [^.]*)?(?:is )?(?:currently )?restricted|access denied|not authori[sz]ed|unauthori[sz]ed|forbidden|permission denied)\b/i.test(
		text,
	);
}

/** Global settings.json, read read-only on every check. Never written, never required. */
function readSettings(): any {
	const dir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
	try {
		return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
	} catch {
		return null; // no settings, unreadable, or malformed
	}
}

/** Pi's configured default `provider/id`, or null. */
function configuredDefault(settings: any = readSettings()): string | null {
	if (typeof settings?.defaultProvider === "string" && typeof settings?.defaultModel === "string") {
		return `${settings.defaultProvider}/${settings.defaultModel}`;
	}
	return null;
}

/** Did this process launch with an explicit `--models` scope? Then Pi's startup scope is the scope. */
export function hasCliModels(argv: readonly string[] = process.argv): boolean {
	return argv.some((a) => a === "--models" || a.startsWith("--models="));
}

function globRegex(glob: string): RegExp {
	let re = "";
	for (const ch of glob) {
		if (ch === "*") re += ".*";
		else if (ch === "?") re += ".";
		else if (ch === "[" || ch === "]") re += ch;
		else re += ch.replace(/[.+^${}()|\\/-]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, "i");
}

/**
 * Resolve `enabledModels` patterns against models that exist now — the same shapes Pi accepts:
 * `provider/id`, bare `id`, globs on either, optional `:thinking` suffix. Pattern order is kept.
 */
export function resolveEnabled<T extends { provider?: string; id?: string }>(
	patterns: readonly unknown[],
	available: readonly T[],
): T[] {
	const out: T[] = [];
	const add = (m: T) => {
		if (!out.some((o) => key(o) === key(m))) out.push(m);
	};
	for (const raw of patterns) {
		if (typeof raw !== "string" || !raw.trim()) continue;
		const p = raw.trim().replace(THINKING_SUFFIX, "");
		// 🔴 LITERAL FIRST (2026-09-23, request 2026-09-23). The host renamed
		// `openai/gpt-5.6-sol-1m` to `openai/gpt-5.6-sol[1m]`: a real id that contains `[`/`]`.
		// Treated as a glob, `[1m]` is a character class that matches `…sol1`/`…solm` and never the
		// id itself, so an enabledModels entry naming that exact model resolved to NOTHING and the
		// model read as out of scope. Pi matches it literally (measured: `pi --models
		// "openai/gpt-5.6-sol[1m]" --list-models` warns nothing; `openai/nonexist[1m]` warns).
		const lower = p.toLowerCase();
		const hit = p.includes("/")
			? available.find((m) => key(m).toLowerCase() === lower)
			: available.find((m) => String(m.id ?? "").toLowerCase() === lower);
		if (hit) {
			add(hit);
			continue;
		}
		if (/[*?[]/.test(p)) {
			const re = globRegex(p);
			for (const m of available) if (re.test(key(m)) || re.test(String(m.id ?? ""))) add(m);
		}
	}
	return out;
}

/** Process-wide state. Survives /reload (which re-activates every extension); dies with the process. */
const STATE = Symbol.for("wos.stale-model-guard.process-state.v1");
function processState(): { picks: Map<string, string> } {
	const g = globalThis as any;
	if (!g[STATE] || !(g[STATE].picks instanceof Map)) g[STATE] = { picks: new Map<string, string>() };
	return g[STATE];
}
function sessionKey(ctx: any): string {
	try {
		const sm = ctx?.sessionManager;
		return String(sm?.getSessionFile?.() || sm?.getSessionId?.() || "process");
	} catch {
		return "process";
	}
}

type Scope = {
	source: string;
	models: Array<{ provider?: string; id?: string }>;
	patterns: unknown[] | null;
	/** The live registry snapshot (source "settings" only). Used to pick a remap TARGET, never to decide scope. */
	available?: Array<{ provider?: string; id?: string }>;
};

/**
 * Is `pinned` allowed by the CONFIGURED enabledModels patterns? Decided from the patterns, not from a
 * registry snapshot (2026-09-24, request 2026-09-24): the pinned model itself is
 * a candidate, so a model the registry has not published yet is still judged by what settings.json says.
 * The registry snapshot is added only so literal-first matching keeps Pi's semantics — when the literal
 * id `openai/gpt-5.6-sol[1m]` is registered, that pattern means exactly that model and never the
 * character-class match `…sol1`.
 */
export function enabledByConfig(
	patterns: readonly unknown[],
	pinned: { provider?: string; id?: string },
	available: readonly { provider?: string; id?: string }[] = [],
): boolean {
	const want = key(pinned).toLowerCase();
	return resolveEnabled(patterns, [...available, pinned]).some((m) => key(m).toLowerCase() === want);
}

/**
 * The scope NOW. `ctx.scopedModels` is frozen at process start (Pi never re-resolves it on a
 * settings reload), so it is used only for an explicit `--models` launch, or when the live registry
 * is not reachable, or when settings.json names no `enabledModels`.
 */
function currentScope(ctx: any, settings: any): Scope {
	const snapshot = ((ctx?.scopedModels ?? []) as Array<{ model: ModelRef }>).map((s) => s.model).filter(Boolean) as Array<{
		provider?: string;
		id?: string;
	}>;
	if (hasCliModels()) return { source: "cli-models", models: snapshot, patterns: null };
	const patterns = Array.isArray(settings?.enabledModels) ? settings.enabledModels : null;
	const registry = ctx?.modelRegistry;
	if (patterns?.length && typeof registry?.getAvailable === "function") {
		let available: any[] = [];
		try {
			const got = registry.getAvailable();
			// A non-array (e.g. a Promise from an async registry) is an unreadable snapshot, not "no models".
			available = Array.isArray(got) ? got : [];
		} catch {
			return { source: "session-snapshot", models: snapshot, patterns };
		}
		return { source: "settings", models: resolveEnabled(patterns, available), patterns, available };
	}
	return { source: "session-snapshot", models: snapshot, patterns };
}

export default function activate(pi: ExtensionAPI): void {
	if (disabled()) return; // kill switch: no hooks, no behaviour change at all

	let remapping = false;
	// A model the human explicitly chose lives in processState().picks (keyed by session), so it
	// survives /reload. Never second-guessed.

	const trace = (record: Record<string, unknown>) => {
		const line = { tag: TAG, at: new Date().toISOString(), ...record };
		try {
			(pi as any).events?.emit?.(TRACE_EVENT, line);
		} catch {
			/* the bus must never break a session */
		}
		const path = process.env.WOS_STALE_MODEL_GUARD_LOG;
		if (!path) return;
		try {
			appendFileSync(path, `${JSON.stringify(line)}\n`);
		} catch {
			/* diagnostics are best-effort */
		}
	};

	/**
	 * The whole guard, in one place, driven by whichever hook exposes the restored pin first.
	 * Runs before any provider request is built, and never touches a live human choice.
	 */
	const enforceScope = async (phase: string, source: string | undefined, pinned: ModelRef, ctx: any) => {
		const restored = key(pinned);

		if (remapping) {
			// pi.setModel() re-enters model_select (with source "set") — never recurse into ourselves.
			trace({ phase, source, model: restored, action: "reentry-ignored" });
			return;
		}
		if (!pinned) {
			trace({ phase, source, model: restored, action: "no-model" });
			return;
		}
		if (processState().picks.get(sessionKey(ctx)) === restored) {
			// Chosen by hand in this process (e.g. /model, then /reload). Human intent outranks scope.
			trace({ phase, source, model: restored, action: "human-pick-respected" });
			return;
		}

		if (isLaunchPick(pinned)) {
			// Named on this process's command line (`pi --model …`, or a subagent's dispatch pin).
			trace({ phase, source, model: restored, action: "launch-pick-respected" });
			return;
		}

		const settings = readSettings();
		const def = configuredDefault(settings);
		const scope = currentScope(ctx, settings);
		const scopedKeys = scope.models.map((m) => key(m));
		const perTurn = phase === "before_agent_start";

		// 🔴 INCIDENT 2026-09-24 ~05:4xZ (request 2026-09-24). the owner's turn printed
		// "anthropic/claude-opus-5-5 is outside your enabled models, but the default anthropic/claude-opus-5-5
		// is not registered right now" — the restored model WAS the default AND was in enabledModels. Scope
		// had been decided from a `modelRegistry.getAvailable()` snapshot that did not (yet) contain the
		// anthropic models (auth/env-gated, registered by two extensions, applied after the factories run).
		// A registry snapshot is not configuration. Three rules, in this order:
		//  (1) the configured default is never stale — never warned about, never remapped;
		//  (2) "enabled" is decided from the CONFIGURED enabledModels patterns (literal-first kept);
		//  (3) a snapshot that does not contain the model demonstrably running is "registry not ready":
		//      a quiet trace, no notice, and the check re-runs on the next turn / session event.
		if (def && restored.toLowerCase() === def.toLowerCase()) {
			trace({ phase, source, model: restored, action: "in-scope", basis: "configured-default", scopeSource: scope.source });
			return;
		}
		if (scope.source === "settings") {
			const available = scope.available ?? [];
			if (enabledByConfig(scope.patterns ?? [], pinned, available)) {
				trace({ phase, source, model: restored, action: "in-scope", basis: "enabled-models", scopeSource: scope.source });
				return;
			}
			if (!available.some((m) => key(m) === restored)) {
				// The running model is missing from the snapshot ⇒ the snapshot is partial/empty, not truth.
				trace({ phase, source, model: restored, action: "registry-not-ready", registered: available.length, scopeSource: scope.source });
				return;
			}
		}
		if (!scopedKeys.length) {
			if (scope.source === "settings") {
				// enabledModels is configured but NOTHING in it is registered right now — never guess.
				trace({ phase, source, model: restored, action: "scope-unresolved", scopeSource: scope.source });
				if (perTurn) {
					ctx?.ui?.notify(
						`${TAG}: none of your enabled models is registered right now; this turn runs on ${restored}. ` +
							`Pick one with /model.`,
						"error",
					);
				}
				return;
			}
			// no scoping configured ⇒ every available model is legitimate
			trace({ phase, source, model: restored, action: "no-scope", scopeSource: scope.source });
			return;
		}

		if (scopedKeys.includes(restored)) {
			trace({ phase, source, model: restored, action: "in-scope", scoped: scopedKeys, scopeSource: scope.source });
			return;
		}

		// Prefer an explicit override, then Pi's configured default, then the first scoped model —
		// but only ever a model that is actually in scope. If the configured default is ENABLED but not
		// registered right now, refuse to guess a different model: report it, retry next turn.
		const override = process.env.WOS_STALE_MODEL_GUARD_TARGET;
		const wanted = [override, def].find((k) => typeof k === "string" && k && scopedKeys.includes(k));
		const defEnabledButMissing =
			!wanted &&
			!!def &&
			scope.source === "settings" &&
			resolveEnabled(scope.patterns ?? [], [{ provider: def.split("/")[0], id: def.slice(def.indexOf("/") + 1) }])
				.length > 0;
		if (defEnabledButMissing) {
			trace({ phase, source, model: restored, target: def, action: "remap-rejected", reason: "target-unregistered", scoped: scopedKeys, scopeSource: scope.source });
			ctx?.ui?.notify(
				`${TAG}: ${restored} is outside your enabled models, but the default ${def} is not registered ` +
					`right now, so it cannot be remapped. This turn runs on ${restored}. Pick one with /model.`,
				"error",
			);
			return;
		}
		const safeEntry = wanted ? scope.models[scopedKeys.indexOf(wanted)] : scope.models[0];
		const safe: ModelRef = safeEntry
			? (ctx?.modelRegistry?.find?.(safeEntry.provider, safeEntry.id) ?? safeEntry)
			: undefined;
		if (!safe) {
			trace({ phase, source, model: restored, action: "no-target", scoped: scopedKeys });
			return;
		}

		remapping = true;
		try {
			// Pi's setModel throws when the provider has no auth; older docs say it returns false.
			const ok = await pi.setModel(safe as never);
			if (ok === false) {
				trace({ phase, source, model: restored, target: key(safe), action: "remap-rejected", reason: "no-auth", scoped: scopedKeys });
				ctx?.ui?.notify(
					`${TAG}: ${restored} is outside your enabled models and ${key(safe)} has no configured auth. ` +
						`This turn runs on ${restored}. Pick one with /model.`,
					"error",
				);
				return;
			}
			trace({ phase, source, model: restored, target: key(safe), action: "remapped", scoped: scopedKeys, scopeSource: scope.source });
			ctx?.ui?.notify(
				`${TAG}: this session was pinned to ${restored}, which is outside your current enabled ` +
					`models. Remapped to ${key(safe)}. Pick another with /model.`,
				"warn",
			);
		} catch (error: any) {
			// Never block a session from starting over a convenience remap.
			trace({
				phase,
				source,
				model: restored,
				target: key(safe),
				action: "remap-failed",
				error: String(error?.message ?? error),
			});
			ctx?.ui?.notify(
				`${TAG}: could not remap ${restored} to ${key(safe)} (${error?.message ?? error}). ` +
					`This turn runs on ${restored}. Pick one with /model.`,
				"error",
			);
		} finally {
			remapping = false;
		}
	};

	// THE hook that actually carries a restored pin in 0.86.1 (startup, resume, fork, reload).
	pi.on("session_start", async (event: any, ctx: any) => {
		await enforceScope("session_start", event?.reason, ctx?.model, ctx);
	});

	// EVERY PROMPT, before the first provider request is built (2026-09-23). Catches an out-of-scope
	// model that appeared after session_start, retries a remap that failed there, and reports a
	// remap that cannot happen on every turn until it is resolved. In scope ⇒ a trace, nothing else.
	pi.on("before_agent_start", async (_event: any, ctx: any) => {
		await enforceScope("before_agent_start", "turn", ctx?.model, ctx);
	});

	// Forward-compatible cover for the documented — but currently never emitted — restore source.
	pi.on("model_select", async (event: any, ctx: any) => {
		if (event?.source === "set" || event?.source === "cycle") {
			// A live human choice. Remember it process-wide so a later /reload does not undo it.
			if (!remapping) processState().picks.set(sessionKey(ctx), key(event?.model));
			trace({ phase: "model_select", source: event?.source, model: key(event?.model), action: "not-restore" });
			return;
		}
		if (event?.source !== "restore") {
			trace({ phase: "model_select", source: event?.source, model: key(event?.model), action: "not-restore" });
			return;
		}
		await enforceScope("model_select", "restore", event?.model, ctx);
	});

	pi.on("message_end", (event: any, ctx: any) => {
		// 🔴 Surface the provider's own words. The generic "Unexpected" cost an hour of diagnosis
		// while the exact remedy URL sat unread in the session record.
		const message = event?.message;
		if (message?.stopReason !== "error") return;
		const text = String(message?.errorMessage ?? "");
		if (!text) return;
		const model = messageKey(message);
		if (!isAccessRefusal(text)) {
			trace({ phase: "message_end", model, action: "error-not-access", error: text });
			return; // any other error is Pi's to render; we do not touch it
		}
		trace({ phase: "message_end", model, action: "access-refusal-surfaced", error: text });
		ctx?.ui?.notify(
			`${TAG}: ${model} refused access — ${text} ` +
				`(listing in \`pi --list-models\` does NOT prove entitlement; switch with /model)`,
			"error",
		);
	});
}
