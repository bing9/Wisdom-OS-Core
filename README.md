# Wisdom OS Core

**Humans define intent; AI manages execution; outcomes compound into better decisions.**

Wisdom OS Core is a portable, local-first kernel for multi-agent work. It keeps durable context, decisions, requirements, feedback, evidence, and handoffs outside any one agent session. A Butler surfaces at most three human judgments; Directors own delivery areas; replaceable agents do the work.

The core formula:

```text
Intent → Context → Decision → Task → Evidence → Outcome → Case law
```

## Three principles

1. **Work continuity over agent identity** — shared context must let a blank agent resume within five minutes.
2. **Human intent, AI execution** — humans own outcomes and irreversible calls; AI owns coordination, delegation, and handoffs.
3. **Decision compounding over task throughput** — feedback, evidence, and outcomes must improve future judgment, not merely close tasks.

Read the full [Principles](docs/PRINCIPLES.md) and the operational [Core Contract](docs/CORE_CONTRACT.md).

The project deliberately starts with the smallest compounding layer. The board UI is an instrument panel, not the product. The product is a restartable decision record that survives Claude Code, Codex, Hermes, or the next agent runtime.

## Why this exists

Agent throughput is rising faster than work continuity. Chat history, agent identity, and orchestration topology are weak sources of truth. The durable asset is the work folder:

```text
Context = memory and truth
Backlog = priority
Director = delivery contract
Agent = replaceable worker
Verifier = release gate
```

If a new agent cannot resume from the shared state in five minutes, the system does not own the work yet.

## What is implemented

- Drag-and-drop Decision Flywheel: `SENSE → DISTILL → JUDGE → BANK → LEARN`
- Drag-and-drop Delivery Pipeline: `BACKLOG → READY → DOING → VERIFY → DONE`
- Per-area Director mandate and delivery contract
- Butler scan that returns at most three P0 findings
- Transition gates: no banked decision without a human call; no completed task without independent verification and human acceptance
- Feedback and requirement-delta ledger
- Agent command/run/evidence ledger
- Restartable handoff generator
- Shared HTTP API and agent CLI
- JSON export/import and local-first persistence
- Optimistic revision guard for concurrent agents
- Zero runtime dependencies

## Quick start

```bash
cp data/board.example.json data/board.json
npm test
npm start
```

Open `http://127.0.0.1:4178`.

Agent access:

```bash
node cli.mjs butler
node cli.mjs list decision
node cli.mjs handoff decision decision-first-pilot
node cli.mjs move task task-first-pilot doing
node cli.mjs feedback decision decision-first-pilot "Reviewer" "The wedge is too broad" "Narrow to one live workflow"
node cli.mjs run task task-first-pilot "Claude Code" "npm test" "pass" "test output"
```

Set `DECISION_COCKPIT_URL` when the server is not at the default URL.

## Core boundary

Wisdom OS Core does not try to become another complex agent orchestrator. It stores intent and context in a portable contract; AI runtimes can compile that contract into whatever director/subagent topology fits the moment.

Default flow:

1. Human states desired outcome, boundary, and stakes.
2. Butler identifies the smallest decision that unblocks work.
3. Area Director assembles context and delegates execution.
4. Maker produces an artifact; an independent verifier supplies evidence.
5. Human banks consequential calls and accepts final delivery.
6. Outcome updates case law, making the next decision cheaper and better.

See `docs/CORE_CONTRACT.md`.

## Portability

State is plain JSON; the API is regular HTTP; agent commands are a zero-dependency Node CLI. Project artifacts can remain in Google Drive, Git, Obsidian, or another folder system. Wisdom OS Core stores links and decision context rather than taking ownership of every artifact.

## Influences

- [Canvasight](https://github.com/Niall-Young/Canvasight): canvas-native task and asset context
- [Dashi Taskboard](https://github.com/chuspeeism/dashi-taskboard): shared API/CLI, optimistic versions, and explicit human acceptance
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban): multi-agent worktree orchestration

Wisdom OS Core is an independent implementation focused on decision compounding rather than coding-agent throughput.

## Status

`v0.1` is a concierge MVP: the kernel, gates, UI, API, CLI, persistence, and tests work. The next validation is one real multi-agent workstream—not more UI.

Success does not require scale. One deep user whose real decisions repeatedly improve is enough; stars, user count, and organizational growth are optional.

## License

MIT
