# Pi Package Design — zero-command capture, governed promotion, compounding retrieval

## Decision — Pi TUI, not a web application

The 2026-08-20 architecture decision is that **Pi is the product interaction surface**. The browser cockpit is
retired from the live architecture and preserved under `archive/web-v0.1/` only. There is no web
server, browser tab, or HTTP API in the default path. The direct local store is the kernel; Pi
extensions provide the TUI and lifecycle adapter; the CLI is the headless adapter.

## Product promise

After:

```bash
pi install git:github.com/bing9/Wisdom-OS-Core@v0.2.0
```

Pi starts with a quiet Wisdom OS adapter in **private-local** mode under
`~/.wisdom-os/projects/<cwd-hash>/`. No setup prompt interrupts the first turn.

- `/wos shared` explicitly opts this project into `<project>/.wisdom-os/state.json`.
- `WISDOM_OS_STATE=/absolute/path/state.json` binds another state root.
- `WISDOM_OS_READ_ONLY=1` injects existing state while performing zero writes.

No command is required for continuity. Commands remain available for explicit control and human gates.

## The boundary

```text
Kernel                         Pi adapter                         TUI
state + transition gates  ←→  lifecycle capture + retrieval  ←→  judgment surfaces
```

The kernel owns truth. The adapter feeds and reads it. The TUI never becomes a second store.

## Package

```text
wisdom-os-core/
├── extensions/
│   ├── wos-guards.ts   # portable build of production wos-guards
│   ├── wos-butler.ts   # portable build of production wos-butler
│   └── wos-lane.ts     # portable build of production wos-lane
├── skills/
│   ├── wisdom-os-core/SKILL.md
│   └── port-private-extension/SKILL.md
├── prompts/
│   └── wos-review.md
├── src/
│   ├── domain.mjs    # transition gates, handoff, precedent retrieval
│   └── store.mjs     # private/shared state, lock, atomic write, read-back
└── package.json
```

The three public extensions are explicit, ordered package entrypoints. They descend from the running
private extensions rather than a ground-up rewrite. Every module delegates to the same store and
kernel; no TUI component owns state. Future reusable behavior lands here first, then private adapters
configure it.

## What happens automatically

| Pi event | Portable behavior | What it may not claim |
|---|---|---|
| `session_start` | Resolve project state; show one compact status; restore active task/decision | That an idle project is healthy |
| `input` | Append the typed human turn to a bounded local event journal; attach it to the active entity | That every sentence is a decision |
| `before_agent_start` | Inject active handoff plus top relevant active/amended/refuted precedents | That retrieved precedent governs without matching scope |
| `tool_execution_end` | Capture failed commands and write/edit artifact paths as run evidence | That a successful command means the artifact is correct |
| `agent_settled` | Persist a completion receipt: answer, artifacts touched, reproducer, unresolved clauses | That the task is DONE |
| explicit human acceptance | Move a verified task to DONE | Nothing—human acceptance is required by the kernel gate |
| outcome/review due | Surface one learning overlay; bank outcome and amend/strengthen/refute a case | That silence means confirmation |

## The two compounding chains

### Decision chain

```text
typed direction
  → automatic raw capture + agent-authored requirement / decision / task
  → run + artifact evidence
  → independent verification
  → human acceptance
  → dated outcome review
  → case law: strengthened | amended | refuted
  → relevant precedent injected before the next decision
  → precedent-use record: changed | challenged | confirmed
```

### Harness chain

```text
human correction / verifier rejection / failed control
  → typed process signal
  → same class recurs twice
  → improvement proposal with evidence + expected effect + falsifier
  → mechanical/reversible: task opens automatically
  → semantic: human approves the canary in /wos improve
  → regression test + rollback + quality auto-disable
  → independent verification
  → live control
  → recurrence measurement strengthens, amends, or disables it
```

A journal is continuity, not learning. **Compounding begins only when an outcome changes the next
decision or when a measured failure changes the future harness.** Artifact counts and session counts
are not learning metrics.

## Required state additions (v2 migration)

```json
{
  "cases": [
    {
      "id": "case-...",
      "claim": "...",
      "scope": { "time": "...", "population": "...", "logic": "..." },
      "sourceDecisionIds": ["decision-..."],
      "expectedOutcome": "...",
      "reviewDate": "...",
      "observedOutcome": "...",
      "status": "active | amended | refuted",
      "confidence": "low | medium | high",
      "falsifier": "..."
    }
  ],
  "precedentUses": [
    {
      "caseId": "case-...",
      "decisionId": "decision-...",
      "effect": "changed | challenged | confirmed",
      "at": "..."
    }
  ],
  "processSignals": [
    { "id": "signal-...", "type": "correction", "klass": "...", "detail": "...", "semantic": true }
  ],
  "improvements": [
    {
      "id": "improvement-...", "klass": "...", "stage": "proposed | canary | live | disabled",
      "evidenceIds": ["signal-..."], "expectedEffect": "...", "falsifier": "...",
      "regressionTest": "...", "rollback": "...", "autoDisable": "...",
      "maker": "...", "verifier": "...", "canaryResult": "..."
    }
  ]
}
```

Retrieval is initially deterministic lexical scoring over title, claim and scope. It returns the
source and status, including refuted cases; it never silently drops negative evidence. An embedding
index is optional later and may never become the only path.

## Tools and commands

One model tool, `wisdom_os`, with strict actions:

`status · create_decision · create_task · feedback · record_run · record_correction · propose_move · handoff · precedents`

The tool may prepare a consequential transition, but BANK / DONE / case-law amendment requires the
existing human gates.

Commands are convenience, not required memory:

- `/wos` — top three + active work
- `/wos path` / `/wos shared` — inspect or opt into project-shared state
- `/wos decide <id>` — human BANK gate
- `/wos verify <id>` — independent verification + human DONE gate
- `/wos learn <id>` — outcome and case-law disposition
- `/wos precedent <case-id> <decision-id>` — record whether precedent changed, challenged, or confirmed the call
- `/wos improve <improvement-id>` — approve a semantic canary or disable the proposal

There is deliberately no `/wos open`: a second interface would become a second place to check.

## Public/private split

**Public `wisdom-os-core`:** generic state, lifecycle adapter, tools, overlays, gates, retrieval.

**Private optional adapter:** personal voice, private paths, private taxonomies, company tools,
organization-specific directors. The public package exposes configuration points; it never embeds a
person's policy or data.

Herdr's `herdr-agent-state.ts` remains managed by Herdr and is not copied.

## Pi manifest

```json
{
  "keywords": ["pi-package", "decision-os", "context-engineering"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

## Acceptance

1. Fresh install produces private project-keyed state and a visible but quiet status without a setup
   prompt or any application-source edit.
2. Session A records one decision, one requirement delta and one artifact. A fresh Session B restores
   them without replaying A's transcript.
3. Maker cannot mark its own consequential task DONE; an independent verifier plus human acceptance
   succeeds.
4. An outcome can refute a case. The refuted case remains retrievable and is injected as negative
   precedent on a matching future decision.
5. A precedent-use row proves a prior case changed, challenged or confirmed the later decision.
6. Print/JSON/RPC modes run without TUI calls; read-only mode performs zero writes.
7. Package passes Node 20 and 22 CI and can be tested with `pi -e .` before publication.
