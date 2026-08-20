# Core Contract

**The human owns intent and irreversible judgment; AI owns coordination and execution.**

## 1. Intent is the input

A useful intent names:

- desired outcome
- why now
- boundaries and non-goals
- evidence that would change the decision
- acceptance condition

The human should not need to design the agent organization. The Butler and Directors compile intent into execution.

## 2. Context is the durable source of truth

No agent or chat session may hold unique project context. Every material change returns to shared state as one of:

- decision and trade-off
- requirement delta
- feedback
- agent run and command
- artifact and evidence
- outcome and review

Replacement test: a blank agent can continue within five minutes using only the shared folder and generated handoff.

## 3. Butler is global and quiet

The Butler continuously scans all areas, but surfaces no more than three findings. It may:

- identify an unbanked P0 decision
- identify blocked critical work
- identify missing or overdue verification
- prepare context and a handoff
- ask a Director to act

It may not make irreversible human calls or remove gates.

## 4. Director owns one delivery area

Every area has one Director contract:

- mandate: what the area exists to produce
- delivery contract: what counts as complete
- current decisions and tasks
- independent verification rule
- handoff back to the Butler

The Director is a role, not a memory silo. It can be replaced without losing work.

## 5. Agents are disposable execution capacity

The Director chooses maker and verifier agents based on the work. Agent identity is not part of the durable data model except as run evidence.

Maker and verifier must differ for consequential delivery.

## 6. Gates protect judgment quality

A decision cannot enter `BANK` without:

- explicit human call
- owner
- date
- resolved premise

A task cannot enter `DONE` without:

- acceptance criteria
- evidence
- independent verifier
- verification result
- explicit human acceptance

A decision cannot enter `LEARN` without an outcome, review, and case-law update.

## 7. Feedback must compound

Feedback is not a chat reply. It must be attached to the decision or task and state whether the requirement changed. Outcomes strengthen, revise, or demote prior case law.

## 8. Pi is the primary interaction surface

The product interface is the **Pi TUI**, loaded as a Pi package. The TUI exposes decisions,
verification, handoffs, and due outcome reviews where the work already happens; it does not require a
separate web application or a second inbox.

The durable kernel remains the contract plus event ledger. Pi is the primary adapter; other agents
and orchestrators may use the direct CLI or JSON state. Every UI is a view and may be replaced without
changing the record.

The archived v0.1 browser prototype is historical reference only. It is not shipped or started by
default.

Backlog/context is source code; orchestration is compiled runtime.

## 9. Capture is automatic; semantic promotion is governed

The Pi adapter automatically preserves human turns, touched artifacts, failed tools, and completion
receipts. During the turn, the agent documents material decisions, tasks, requirement deltas,
corrections, and evidence through the typed kernel tool. A missed semantic capture remains visible in
the raw event journal; it is not lost with the transcript.

Automatic capture does not equal automatic approval. BANK, DONE, case-law changes, and semantic
harness policy retain their human gates.

## 10. Accumulation is not compounding

A session journal, artifact list, or growing board provides continuity but does not prove learning.
The loop compounds only when an outcome strengthens, amends, or refutes a case and that precedent
later changes, challenges, or confirms another decision. Refuted cases remain retrievable.

## 11. The harness learns from its own failures

Every human correction or verifier rejection is a typed process signal. A recurring class
automatically becomes an improvement proposal with its evidence, expected effect, and falsifier.

- Mechanical and reversible controls may enter the work queue automatically.
- Semantic policy changes require explicit human approval.
- Every control requires a regression test, rollback, quality auto-disable, canary result, and an
  independent verifier before going live.
- Recurrence after launch is a falsifier: the improvement can be amended or disabled rather than
  accumulating as permanent policy.
