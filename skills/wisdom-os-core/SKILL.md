---
name: wisdom-os-core
description: Operate the Pi-native Wisdom OS Core: retrieve durable project context, record decisions and requirement deltas, attach run evidence, produce restartable handoffs, and review outcomes into amendable or refutable case law. Use for any project managed by Wisdom OS Core.
---

# Wisdom OS Core

Pi is the primary interface. The extension loads automatically from the package; use its
`wisdom_os` tool for durable state and `/wos` for the TUI.

## Start

```bash
pi -e .
```

No server is required. State defaults to a private project-keyed directory under
`~/.wisdom-os/projects/`. `/wos shared` creates `<project>/.wisdom-os/state.json` when a team wants
the state in the project.

## Before acting

1. Read the context injected by the extension.
2. Use `wisdom_os { action: "status" }` when the active object is unclear.
3. Retrieve precedents before a consequential decision; preserve amended and refuted cases.

## Record while working

- Explicit decision or requirement change → `wisdom_os` immediately.
- Human correction or verifier rejection → `wisdom_os` action `record_correction`; a second instance of the same class automatically opens governed harness-improvement work.
- New deliverable → create a task with an acceptance condition.
- Material command/result/artifact → record a run. The adapter also captures writes and failed tools.
- Need to resume elsewhere → generate a handoff; do not rely on transcript replay.

## Gates

- Human owns irreversible intent.
- A decision cannot enter BANK without human call, owner, date, and resolved premise.
- A task cannot enter DONE without evidence, an independent verifier, verification, and human acceptance.
- A case can be strengthened, amended, or refuted. Refuted cases remain retrievable as negative precedent.
- Repeated mechanical failures automatically enter the task queue; semantic harness changes require `/wos improve` approval.
- A harness control goes live only with regression test, rollback, quality auto-disable, canary result, and independent verification.
- The TUI is a view; shared JSON state is the record.

## Finish

Leave a completion receipt with the artifact and reproducer. If an outcome changed a prior belief,
record the case-law disposition and how the precedent affected the next decision.
