# Wisdom OS Core

**Humans define intent; Pi carries execution context; outcomes revise the next decision.**

Wisdom OS Core is a Pi-native, local-first package for durable multi-agent work. The primary
interface is the **Pi TUI**, not a web application. It automatically captures decision-shaped work,
documents requirement changes and evidence outside the chat, and turns repeated correction classes
into governed harness-improvement work.

```text
Intent → Decision → Task → Evidence → Outcome → Case law → next decision
```

## Install

```bash
pi install git:github.com/bing9/Wisdom-OS-Core@v0.2.0
pi
```

For a checkout:

```bash
pi -e .
```

The extension starts automatically. No server is required.

- `/wos` — compact TUI: top three findings plus active work
- `/wos path` — show the active state file
- `/wos shared` — move this project from private-local state to `<project>/.wisdom-os/state.json`
- `/wos handoff decision <id>` — place a restartable handoff in the editor
- `/wos decide <id>` — explicit human BANK gate
- `/wos verify <id>` — independent verification plus human DONE gate
- `/wos learn <id>` — outcome review and case-law disposition
- `/wos precedent <case-id> <decision-id>` — record whether precedent changed the later call
- `/wos improve <improvement-id>` — approve a semantic canary or disable the proposal
- `/dream` — the continuous-improvement loop: last run, its bounds, and what is awaiting a call
- `wisdom_os` — model tool for decisions, tasks, feedback, evidence, handoffs, and precedents

Default state is private and project-keyed under `~/.wisdom-os/projects/`. Set
`WISDOM_OS_STATE=/absolute/path/state.json` for an explicit location or
`WISDOM_OS_READ_ONLY=1` for a zero-write session.

## What works out of the box

| Pi lifecycle | Wisdom OS behavior |
|---|---|
| Session starts | Opens the project state and shows a quiet status indicator |
| Human types | Preserves the input in a bounded private event journal |
| Agent starts | Injects active work and matching precedents |
| Agent writes or a tool fails | Records artifact/run evidence |
| Agent settles | Writes a completion receipt with answer excerpt and touched artifacts |
| Human/verification correction | Records a process signal; recurrence automatically opens an improvement |
| `/wos` | Shows at most three judgment items and current work |

The adapter records raw observations automatically, and the Pi agent uses `wisdom_os` to document
material decisions, requirement changes, tasks, and corrections during the turn. BANK, DONE,
semantic harness changes, and case-law changes remain explicit human gates.

## Decisions

Every durable harness decision, why it was made, whether it still holds, and where it is
implemented is in **`docs/DECISIONS.md`**. Superseded and refuted decisions stay listed there.

## How it compounds

A session journal provides continuity; it is not learning. Compounding occurs only when:

1. work records an expected outcome;
2. evidence and an independent verifier arrive;
3. a human accepts the consequential result;
4. the outcome strengthens, amends, or refutes a case;
5. that case returns before a later decision and is recorded as changing, challenging, or confirming it.

Refuted cases remain retrievable as negative precedent.

The harness uses the same discipline on itself:

```text
correction → recurring class → improvement proposal/task → regression test → canary
→ independent verification → live control with rollback/auto-disable → recurrence measured again
```

Mechanical, reversible improvements can enter the work queue automatically. Semantic policy changes
require human approval. See `docs/CORE_CONTRACT.md` and `docs/PI_PACKAGE_DESIGN.md`.

`extensions/wos-dream.ts` runs that loop continuously, on bounded triggers, after the turn has
settled. It can **retire and refute**, not only add: a belief unused past its review date is proposed
for retirement with the absence itself as the evidence, and a belief whose own falsifier fires is
proposed for refutation. A loop that can only add makes its owner more self-consistent, never more
correct. It proposes and never applies, it turns itself off if humans keep rejecting its output, and
it never treats its own proposals as evidence. `/dream` shows its state.

## Direct CLI

The CLI uses the same local state directly; it does not require HTTP:

```bash
node cli.mjs init
node cli.mjs butler
node cli.mjs list task
node cli.mjs handoff decision <id>
node cli.mjs precedents "query"
```

## Repository map

```text
extensions/wos-guards.ts   portable result-time safety gates, same production name
extensions/wos-butler.ts   lifecycle capture, context, receipts, typed tool, same production name
extensions/wos-lane.ts     Pi judgment overlays, same production name
skills/wisdom-os-core/     on-demand operating contract
skills/port-private-extension/ repeatable private→public extraction method
prompts/wos-review.md      outcome-to-case review prompt
src/domain.mjs             transition gates, improvement loop, handoff, precedent retrieval
src/store.mjs              private/shared local state, lock, atomic write, read-back
src/safety.mjs             terminal-message predicate, append-don't-replace, kill switch, fail-open
src/gatelog.mjs            gate manifest, gate telemetry, real-vs-synthetic coverage
src/guard-predicates.mjs   the shipped result-time predicates, importable by tests
src/return-envelope.mjs    delegation return transaction: completeness, exactly-once, idle ≠ done
src/dream.mjs              continuous-improvement loop: bounded triggers, add/amend/retire/refute
extensions/wos-dream.ts    the loop's Pi adapter — runs on settle, never in the foreground
scripts/release-check.mjs  the release gate, positive and negative
cli.mjs                    direct state CLI
docs/DECISIONS.md          the decisions register: one row per durable decision, superseded rows kept
pi-config/                 sanitized, installable Pi harness config (generated weekly; see pi-config/README.md)
archive/web-v0.1/          retained browser prototype; not shipped as the product interface
```

## Portable Pi harness config

`pi-config/` is a sanitized export of a working, heavily customized WOS-style Pi harness: settings,
guard and statusline extensions, subagent role profiles, the `AGENTS.md` contract as a template,
the model-choice table, the MCP allowlist, and the Director fleet scripts. A deterministic exporter
outside this repo regenerates it every week. A gate refuses the whole export if any private name,
path, host, id, token or project name remains, and the portability audit below covers `pi-config/`
too. Each run makes a local commit only when something changed. It never pushes. To install on a new
box, follow `pi-config/README.md`: fill three placeholders, run `python3 install.py` to see the plan,
then run it again with `--apply`. What stays private, and why, is listed in `pi-config/EXCLUDED.md`.

## Release gate

One command is the gate, and it has two jaws:

```bash
node scripts/release-check.mjs             # 15 checks — must exit 0
node scripts/release-check.mjs --negative  # 25 mutations — must exit 3
```

A **required** check that does not run is a failure, not a note. Waiving one is explicit
(`WISDOM_OS_RELEASE_ALLOW_SKIP=pi-load`) and the run then prints `NOT RELEASE-GRADE`.

`--negative` copies the tree, breaks one load-bearing condition at a time, and requires the normal
gate to reject each one *by the check that owns it*. Exit 3 means every mutation was killed; exit 0
would be indistinguishable from having tested nothing. A gate that cannot fail is not a gate.

Every run prints its own `process.execPath` and `process.version` first. This is not decoration:
Node 16 counts test **files** where Node 24 counts **subtests**, so the same green suite reports
`9 pass` under one runtime and `55 pass` under another. A pass count without its runtime is not
reproducible.

## Status

`v0.2` is the Pi-first architecture and adapter. CI runs the same release gate on Node 20 and 22.
Locally the gate has been run under Node v16.20.2 and v24.10.0 — Node 20 and 22 are declared in CI
and have **not** been exercised on the maintainer's host. The old browser cockpit is preserved under
`archive/web-v0.1/` for history; it is not loaded by the package.

The most recent private→public reconciliation is recorded in `docs/HARNESS_SYNC_2026-08-22.md`,
including what was deliberately left private.

## License

MIT
