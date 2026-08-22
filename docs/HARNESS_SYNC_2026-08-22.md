# Harness sync — 2026-08-22

Reconciliation of the private Pi harness delta into Wisdom OS Core. Mechanism-level, not file-level:
the public extensions intentionally strip private policy, so **behaviours and invariants are
compared, never bytes**.

## Bounded scope

| Source | Range | Count |
|---|---|---|
| Private runtime repo | commits since 2026-08-20 00:00 | 77 |
| Private dotfile repo | commits since 2026-08-20 00:00 | 5 |
| Live Pi extension root | files present at sync time | 4 (`wos-butler`, `wos-guards`, `wos-lane`, `wos-return`) |

Core baseline before this sync: `72aeba9`, tree clean, one commit ahead of `origin/main`.

## Runtime — the result names the binary that produced it

Two Node majors are reachable on the maintainer's host and they disagree about what a "pass" is.

| Runtime | `execPath` | Version | Positive gate | Unit summary |
|---|---|---|---|---|
| system | `/usr/bin/node` | v16.20.2 | 12 passed · 0 failed · exit 0 | `8 pass / 0 fail of 8` — counts **files** |
| bundled | dotslash-managed Node 24 | v24.10.0 | 12 passed · 0 failed · exit 0 | `40 pass / 0 fail of 40` — counts **subtests** |

`/usr/local/bin/node` and `/usr/bin/node` resolve to the same v16 binary; there are two runtimes
here, not three. Negative gate under v24: **11/11 mutations killed, exit 3**.

**Honesty clause: Node 20 and 22 are declared in CI only. Neither has been run locally.** Direct
`npm` install is blocked on this host by policy and was not worked around.

## Classification

### PORTED

| Mechanism | Public home | Private source | Test handle |
|---|---|---|---|
| Terminal-message safety — a guard may append only to an assistant message carrying no tool-call block | `src/safety.mjs` `isTerminalMessage` / `mayAppendTo` | `wos-guards.ts` `message_end`; incident 2026-08-19 (appending mid-flight produced a provider rejection for assistant prefill and cost a turn) | `tests/safety.test.mjs`; gate check `guard-fixtures` |
| Append-don't-replace note attachment across all three content shapes | `src/safety.mjs` `appendNote` | same | `tests/safety.test.mjs` |
| One-file kill switch + fail-open wrapper: a control must never propagate its own failure into the turn | `src/safety.mjs` `killSwitch` / `failOpen`, wired into all three passive butler hooks and the guards handler | `wos-butler.ts` / `wos-guards.ts` `off()` sentinels | `tests/safety.test.mjs`; gate check `read-only-zero-bytes` |
| Gate manifest that never re-dates an existing gate, and retires rather than drops | `src/gatelog.mjs` `gateManifest` / `writeManifest` | `wos-guards.ts` `writeManifest` | `tests/gatelog.test.mjs` |
| Gate telemetry carrying real-vs-synthetic provenance, so "installed" and "working" cannot share a word | `src/gatelog.mjs` `gateEvent` / `logGate` / `gateCoverage` | `wos-guards.ts` `logGate` (`caught_by`, `synthetic`) | `tests/gatelog.test.mjs`; gate check `guard-fixtures` |
| Result-time predicates extracted so tests import the shipped implementation | `src/guard-predicates.mjs` | `wos-guards.ts` `__predicates` | `tests/guard-predicates.test.mjs` |
| Delegation return transaction **contract**: envelope completeness, verifier independence, exact-session binding, exactly-once delivery, idle ≠ completion, declared missing-report recovery | `src/return-envelope.mjs` | `wos-return.ts` + `fleet/return_channel.py`; commits `4fcea78`, `ad88333`, `10bb491`, `f194de7`, `220b64f`, `23f2676`, `c67eb8e`, `b311d81`, `14fe195` | `tests/return-envelope.test.mjs`; gate check `return-envelope` |
| Evidence separated from lifecycle — passing evidence is not DONE | already in `src/domain.mjs`; now **pinned by the gate** | commits `f6a8a21`, `8ccc9aa` (the A39 P0) | gate check `lifecycle-gates` |
| The release gate itself: check-don't-grep, negative control that must kill | `scripts/release-check.mjs` | commits `0c17b3f`, `7d98fd8`, `83e056a`, `d01286c` (a gate that cannot fail; a negative control that is the true inverse) | `--negative`, 11 mutations |

### ALREADY-COVERED

| Behaviour | Existing Core primitive | Test |
|---|---|---|
| Atomic write + read-back verification, lock, revision increment | `src/store.mjs` `writeState` / `updateState` | `tests/store.test.mjs`; gate check `restart-resume` |
| Bounded journals (events 500, receipts 200) | `extensions/wos-butler.ts` | gate check `unit-suite` |
| No read-only path writes | `WISDOM_OS_READ_ONLY` across all write hooks | gate check `read-only-zero-bytes` |
| Recurring correction → governed improvement proposal; semantic changes need a human call | `src/domain.mjs` `recordProcessSignal` / `validateImprovementTransition` | gate check `improvement-governance` |
| Maker ≠ verifier for consequential delivery | `src/domain.mjs` `validateTaskTransition` | gate check `lifecycle-gates` |
| Pi API correctness — `agent_settled` + `ctx.isIdle`, `ctx.mode` / `ctx.hasUI`, `sendMessage` vs `appendEntry`, no long work in extension startup | `extensions/*.ts`; gate-path resolution is lazy, never at load | gate check `unit-suite` |
| Fresh-project vs shared-project state roots | `src/store.mjs` `resolveStatePath` | gate check `state-roots` |

### PRIVATE — stays out, reason named

| Mechanism | Why it does not travel |
|---|---|
| `wos-return.ts` transport: dispatch process, receipt ledger, Herdr/tmux runtime classification, re-steer recovery | Organization-specific process supervision and a private ledger. The **contract** is ported; the transport is not portable and would ship dead code. |
| Butler handover reader (`butler_core.py` cron, `handover.md` / `brief.md` / `authority.md`, staleness thresholds) | Reads a private cron-produced artifact at private paths. Core's butler computes cheaply and directly from portable state instead. |
| Authority registry, granted-subject regex, reserved-subject list, "asked for granted authority" gate | Encodes one person's delegation policy. Public equivalent would be configuration, not code. |
| Personal mirror extract, voice and verbosity policy, `Harness persona` branding, personal Case queue | Personal content, explicitly out of the package. |
| `herdr-agent-state.ts` | Owned and overwritten by Herdr; Core integrates through ordinary Pi lifecycle only. |
| Employer-internal integrations: internal query, analytics, dashboard and social platforms, private sync paths, the private knowledge store and distiller | Employer systems and private data stores. |
| `wos_lane_provenance.py` adversarial provenance checks (commit `01d90fa`) | Reads the private Case corpus and Soul layer. |
| Notebook-reproducibility and source-delta implementations (commits `232667d`, `e08adb4`, `dca3bb5`) | The generic contract is "a content hash is only primary if it describes the live revision"; the implementations are specific to the private sync and dashboard stack. |

### DEFERRED — reusable, not safe or complete now

| Item | Acceptance gap | Owner |
|---|---|---|
| ~~`LANDED / PROVED / COST` improvement vocabulary~~ | **Resolved in the A53-c9/c10 commit** — every proposal now carries `landing` / `proof` / `cost` and cannot apply without all three. | done |
| ~~Continuous-improvement / dream loop as a Pi extension~~ | **Resolved in the A53-c9/c10 commit** — see the section below. | done |
| Intent/goal projection: stable criteria IDs and versions, definition-of-done, review question, reviewer, transition history, one canonical outcome-derived projection, no-op on unchanged state | Core has no goal entity. The portable slice is the evidence-vs-lifecycle split, which **is** ported and gated; the projection layer needs a Core goal model first. | unassigned |
| `/goal` stop behaviour — one honoured block, no claimed invocation-count bound | Depends on a host stop-hook contract Core does not define. Commit `90d0bb8` records that the banner claimed a bound the measurements refuted; porting the claim without the measurement would repeat that. | unassigned |
| Ledger runaway containment (`ledger_guard.py`, rows/distinct redundancy + rate + size) | Genuinely generic and valuable. Core's journals are bounded by count only, which is a weaker control than volume-without-information detection. Needs its own gate and negative control. | unassigned |
| Mutual-recursion / fork-bomb re-entry guard (commit `c97a283`) | Core has no multi-process entrypoints today, so a guard here could not fail and would not be a gate. Revisit when Core grows a background path. | unassigned |

## Refutations of the brief

Reported first, because they are the one thing a director cannot obtain another way.

1. **`mcp__happy__change_title` does not exist in this session.** No happy MCP server is connected. The "first tool call: name yourself" mandate was unexecutable; the stream is unnamed on the phone.
2. **`/usr/local/bin/node` and `/usr/bin/node` are the same binary**, both v16.20.2 with `execPath=/usr/bin/node`. Two runtimes, not three.
3. **A fourth live private extension exists that the brief never names:** `wos-return.ts`, symlinked into the Pi extension root on 2026-08-21 06:56. It is the mechanism this very stream is held to, and Core had no counterpart. It is now the largest single port.
4. **`extensions/wos-guards.ts` claimed to preserve "terminal-message safety" and did not.** Core registered no `message_end` handler at all, so there was nothing to protect and nothing to test. The claim is corrected and the predicate is now shipped and gated.
5. **`archive/porting/PRIVATE_PROVENANCE.md` acceptance criterion "a behavior table maps every retained mechanism to a test" was unmet.** The guard predicates were exported "for replay tests" and had **zero** tests; `__predicates` re-declared each regex inline, so any test importing it would have exercised a second copy while the handler used the first.
6. Everything else in the brief's baseline held exactly: Core HEAD, commit counts, portability 0 findings, `pi -e .` exit 0, CI declaring only Node 22, `CLAUDE.md` still naming the deleted `wisdom-os.ts` extension, and the npm block.

## Defects found in this work, by this work

- The first `read-only-zero-bytes` implementation matched only a hook's signature line, so it read "does not consult READ_ONLY" on a hook that did. Caught by the gate on its first run.
- `restart-resume` asserted a decision title the handoff never emits, and attached run evidence to the wrong entity. Caught by the gate.
- **`return-envelope` was self-satisfying**: it iterated `REQUIRED_ENVELOPE_FIELDS` to test `REQUIRED_ENVELOPE_FIELDS`, so deleting `verified_by` from the list simply stopped testing it. The mutation `envelope-drops-verifier` **survived the first negative run**. The expected set is now pinned literally in both the gate and the unit test. This is precisely the private harness's own `dfd1911` finding ("the grader, three self-satisfying checks") reproduced in new code.
- The `private-path-leaks` mutation had to be assembled at runtime: written as a literal it would sit inside a packaged file and the portability audit would correctly fail the gate on the gate.

## Coverage limits — stated, not hidden

- `unit-suite` and `pi-load` are **not** mutation-covered. `unit-suite` is the substrate every other mutation runs through; `pi-load` needs the `pi` binary resolvable inside a temporary copy.
- The negative gate mutates 11 conditions across 10 of the 12 checks. It does not prove the absence of other bypasses.
- Node 20 and 22 remain CI-declared and locally unrun.
- Gate telemetry ships with **zero live hits by construction** — the coverage report will read `never` for all three gates until the package runs somewhere real. That is the honest state, and `gateCoverage` reports it rather than counting installation as evidence.

## A53-c9/c10 — the continuous-improvement loop (second commit)

Scope addition received after the RC was cut, and deliberately kept as a **separate commit** so the
sync could be frozen and verified independently. RC SHA: `572d01b`.

`src/dream.mjs` (kernel) + `extensions/wos-dream.ts` (adapter). Mechanism only — Core ships the loop,
the private harness keeps the beliefs.

| Requirement | How it is enforced | Provable by |
|---|---|---|
| Bounded session / time / correction-failure triggers | `shouldRun` — 20 turns, ≥60 min apart, 2 corrections, ≤8 runs/session, ≤3 proposals/run, 200-run journal. Every refusal states which bound held. | `dream-loop` |
| Never blocks the foreground | Runs on `agent_settled` only when `ctx.isIdle()`, detached via `setTimeout(…, 0)`, wrapped `failOpen`; `session_start` does no IO at all | `dream-loop` (asserts the startup handler touches no store call) |
| Coalesces duplicates | `coalesce` folds by `verb::subject`, unions evidence, strengthens an already-open proposal instead of opening a second | `dream-loop` |
| Evidence-backed proposals, not self-approved policy | `canApply` requires landing, proof, cost, falsifier, rollback, auto-disable, and a verifier ≠ maker | `dream-governance` |
| Semantic changes human-gated | An enforced gate, not a comment: `needsHumanApproval && !approvedByHuman` → cannot apply. Every belief-level proposal is semantic. | `dream-governance` |
| Independent verification | `verifier` must differ from `maker`, checked in the same gate | `dream-governance` |
| Auto-disable can fire | `qualityVerdict` disables the loop at a ≥60% human-rejection rate over its **own** proposals; the disabled flag survives `normalizeState` | `dream-governance` |

### The scar tissue, ported

1. **One-directional compounding (55 accepts, 0 retirements ever).** `retire` and `refute` are
   first-class verbs with their own evidence paths — retirement earned by *absence of use* past a
   review date, refutation by the belief's own falsifier being observed. The release check requires a
   fixture that actually yields a retirement proposal; mutation `retirement-is-decorative` disables
   that branch and must be killed. A verb no fixture can reach is decoration.
2. **Detectors with zero callers.** Proposals are written into `state.improvements` — the collection
   `computeButlerBrief` already surfaces — so `reachesHumanSurface` asserts end to end that an
   emitted proposal appears in the brief a human opens. Mutation `proposal-never-surfaces` parks the
   proposal off-surface and must be killed.
3. **The coalescer matching its own output.** Everything the loop writes is stamped
   `producedBy: 'dream'` and `selectEvents` excludes those rows across signals, events and cases. The
   check uses a mixed fixture so the exclusion is observable — an all-foreign fixture cannot tell the
   two implementations apart. Mutation `coalescer-eats-own-output` removes the filter and must be
   killed.

**A defect this found in the gate itself:** the first version of the scar-3 check asserted against a
state containing nothing the loop had produced, so it passed under both the correct and the broken
filter. The mutation survived and named the wrong owning check. Fixed by making the fixture mixed —
the same class of error as the self-satisfying envelope check above, found the same way.

### A53-c9/c10 verification

Positive **14/14, exit 0** and negative **17/17 mutations killed, exit 3**, under *both*
`/usr/bin/node` v16.20.2 and the bundled v24.10.0. Six of the seventeen mutations target this loop.

### What the loop still cannot do

- It proposes; it never applies. Application remains `/wos improve` plus the existing
  canary → independent verifier → live path.
- It has **no live hits by construction** on a fresh install. `gateCoverage` and the run journal will
  both read empty until it runs somewhere real. That is the honest state, not a pass.
- `add` proposals are only as good as the correction classes a human or the guards name; the loop
  invents no classes of its own.

## Commits

| SHA | Contents |
|---|---|
| `572d01b` | the sync RC — ported mechanisms, five corrections, the 12-check release gate |
| second commit | A53-c9/c10 — the continuous-improvement loop, checks 13 and 14, six further mutations |

No push, no npm publish, no tag, and no change to live private extension loading. A53 moves to
`READY FOR REVIEW` only.
