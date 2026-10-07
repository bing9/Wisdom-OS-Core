# Principles

**Wisdom OS Core exists to make work survive agents, let AI manage execution, and compound outcomes into better judgment.**

These three principles define the product. A feature that advances none of them does not pass the worth-it gate.

## 1. Work continuity over agent identity

No agent, chat, or runtime may hold unique project memory. Intent, context, decisions, requirement changes, feedback, evidence, outcomes, and handoffs belong in shared durable state.

**Replacement test:** remove every active agent. A blank agent should continue the work within five minutes using only the shared folder and generated handoff.

## 2. Human intent, AI execution

The human owns desired outcomes, boundaries, acceptance conditions, and irreversible judgment. AI compiles that intent into Directors, makers, verifiers, sequencing, and handoffs.

The human should not need to choose which agent runs next or when agents exchange work.

**Calm test:** the Butler returns at most three consequential human judgments—not an inbox of agent activity.

## 3. Decision compounding over task throughput

Finishing tasks is not enough. Feedback must become a requirement delta; evidence must resolve a premise; outcomes must strengthen, revise, or demote prior case law.

```text
Intent → Context → Decision → Task → Evidence → Outcome → Case law
```

**Compounding test:** every consequential outcome must make a future decision cheaper, faster, or better.

**Depth test:** one deep user whose real decisions repeatedly improve is sufficient validation. User count, GitHub stars, and organizational scale are optional—not the product objective.

## Product consequences

- The work folder is the source of truth; agent topology is disposable runtime state.
- Butler and Directors coordinate execution, but cannot make irreversible human calls.
- `BANK`, `DONE`, and `LEARN` are protected by explicit evidence and acceptance gates.
- Kanban, canvas, TUI, Claude Code, Codex, Hermes, and future runtimes are replaceable adapters.
- More orchestration and more UI are not progress unless they improve continuity, human calm, or decision compounding.

See [Core Contract](CORE_CONTRACT.md) for the operational rules that implement these principles.
