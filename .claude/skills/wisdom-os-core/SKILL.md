---
name: wisdom-os-core
description: Operate the Wisdom OS Core Butler, Director areas, decision flywheel, delivery pipeline, and handoff ledger.
---

# Wisdom OS Core

Use this skill whenever working in a project managed by Wisdom OS Core.

## Start

```bash
npm start
node cli.mjs butler
```

## Read before acting

```bash
node cli.mjs list decision
node cli.mjs list task
node cli.mjs handoff decision <id>
```

## Record work

```bash
node cli.mjs move task <id> doing
node cli.mjs feedback <type> <id> <source> <note> [requirement-delta]
node cli.mjs run <type> <id> <agent> <command-or-prompt> <result> [artifact]
```

## Gates

- Butler returns at most three human judgments.
- Director owns delivery; it does not hold unique memory.
- A decision enters BANK only after the human call, owner, date, and resolved premise exist.
- A task enters DONE only after independent verification and explicit human acceptance.
- Never edit `data/board.json` directly to bypass a gate.

## Finish

Generate the handoff, verify persistence through the API, and report the decision or artifact—not a list of agent activity.
