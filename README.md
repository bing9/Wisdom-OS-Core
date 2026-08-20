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
cli.mjs                    direct state CLI
archive/web-v0.1/          retained browser prototype; not shipped as the product interface
```

## Status

`v0.2` is the Pi-first architecture and adapter. Publication is gated on Node 20/22 CI plus a clean
install test with `pi -e .`. The old browser cockpit is preserved under `archive/web-v0.1/` for
history; it is not loaded by the package.

## License

MIT
