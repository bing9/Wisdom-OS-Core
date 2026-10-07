# Decisions register

This is the one maintained list of the harness's lasting decisions. It records what was decided, why,
what follows from it, whether it still holds, where it is implemented, and what evidence backs it.
Timestamped documents such as `docs/HARNESS_SYNC_2026-08-22.md` are the evidence. This file is the index.

**Status words.** `active`: in force. `superseded`: replaced by a later decision, which the row names.
`refuted`: shown wrong by evidence. Superseded and refuted rows are never deleted. They are the
negative precedent that stops the next change from rediscovering a known mistake.

## Index

| ID | Decision | Status |
|---|---|---|
| D01 | Pi TUI is the product surface; no web app in the default path | active |
| D01-old | The v0.1 browser cockpit is the product interface | superseded by D01 |
| D02 | Shared state outside the chat is the source of truth | active |
| D03 | Private-local state by default; shared is opt-in; read-only writes zero bytes | active |
| D04 | BANK, DONE and LEARN need an explicit human act; passing evidence is not DONE | active |
| D05 | Maker and verifier differ for consequential delivery | active |
| D06 | The Butler surfaces at most three findings | active |
| D07 | A guard may append only to a terminal assistant message | active |
| D08 | One extension-registration grammar; an unreadable event name is refused | active |
| D08-old | The extension audit skips registrations it cannot read | superseded by D08 |
| D09 | Every control has a kill switch and fails open | active |
| D10 | Gate telemetry separates real hits from synthetic ones | active |
| D11 | Delegation returns through a complete envelope; idle is not done | active |
| D11-old | The envelope check derives its expected fields from the code under test | refuted |
| D12 | The release gate has two jaws and prints its own runtime | active |
| D13 | Recurring corrections become governed improvement proposals | active |
| D13-old | The landing/proof/cost improvement vocabulary is deferred | superseded by D13 |
| D14 | The improvement loop can retire and refute; it proposes, never applies | active |
| D15 | Public mechanism, private configuration; reusable behavior lands in Core first | active |
| D16 | The prose "unproven claim" predicate is safe to port | refuted |
| D17 | The live Pi harness config ships as a sanitized, installable `pi-config/` | active |
| D17-old | `pi-config/` is replaced by one directory rename | superseded by D17 |
| D18 | Single-user safety: guard against our own agents' accidents, not attackers | active |
| D19 | MCP tools are admitted only from a read-only allowlist | active |
| D20 | One model-choice table assigns the model per role | active |
| D21 | A figure registry keeps every version; the review gallery shows only the latest | active |
| D21-old | The review gallery shows every version of every figure | superseded by D21 |
| D22 | Harness decisions live in this one register, updated at the point of change | active |
| D23 | `AGENTS.md` ships as a neutral template plus the owner's version as a worked example | active |
| D23-old | The owner's `AGENTS.md`, mechanically sanitized, is the install template | superseded by D23 |
| D24 | The publish audit covers every tracked file, commit message and identity, with an external fail-closed deny list | active |
| D24-old | The portability audit scans `package.json` `files` with an optional deny list | superseded by D24 |
| D25 | Employer internals and the owner's own principles never ship; the gate also refuses CJK text | active |

## Entries

### D01 — Pi TUI is the product surface (2026-08-20)
- **Why:** the work already happens in Pi. A second inbox or browser tab splits attention and becomes a second store.
- **Consequence:** no server, HTTP API or browser in the default path. Every UI is a replaceable view over the store.
- **Implementation:** `package.json` (`pi` manifest), `extensions/`. **Evidence:** `docs/PI_PACKAGE_DESIGN.md` §Decision; gate check `pi-load`.

### D01-old — browser cockpit as product (v0.1) — superseded by D01
- Kept under `archive/web-v0.1/` for provenance only. It is not shipped or started.

### D02 — Shared state is the source of truth
- **Why:** a chat session that holds unique context is lost when the session ends.
- **Consequence:** the replacement test applies. A blank agent must be able to continue within five minutes from the shared state and a generated handoff.
- **Implementation:** `src/store.mjs` (atomic write, lock, read-back). **Evidence:** `docs/CORE_CONTRACT.md` §2; gate check `restart-resume`.

### D03 — State roots and read-only mode
- **Why:** first use must be private and quiet. Sharing is an explicit choice, and inspection must never write.
- **Consequence:** the default root is `~/.wisdom-os/projects/<hash>/`. `/wos shared` opts a project into shared state. `WISDOM_OS_READ_ONLY=1` performs zero writes.
- **Implementation:** `src/store.mjs` `resolveStatePath`. **Evidence:** gate checks `state-roots` and `read-only-zero-bytes`.

### D04 — Human gates; evidence is not lifecycle
- **Why:** an agent that banks decisions or closes work on its own judgment removes the human's monopoly on intent.
- **Consequence:** BANK needs a human call, an owner, a date and a resolved premise. DONE needs acceptance criteria, evidence, an independent verifier and explicit human acceptance. LEARN needs an outcome and a case update.
- **Implementation:** `src/domain.mjs`. **Evidence:** `docs/CORE_CONTRACT.md` §6; gate check `lifecycle-gates`; mutation `done-without-human`.

### D05 — Maker ≠ verifier for consequential delivery
- **Why:** a maker checking its own work misses the errors it made.
- **Consequence:** a consequential task cannot reach DONE when the verifier is the maker. D18 narrows *when* the fleet dispatches a verifier; it does not weaken this gate.
- **Implementation:** `src/domain.mjs` `validateTaskTransition`. **Evidence:** `docs/CORE_CONTRACT.md` §5; gate check `lifecycle-gates`.

### D06 — The Butler is global and quiet
- **Why:** more surfaced items mean more review work for the human, not more calm.
- **Consequence:** the Butler shows at most three findings. It prepares context, but it never makes irreversible calls or removes gates.
- **Implementation:** `extensions/wos-butler.ts`. **Evidence:** `docs/CORE_CONTRACT.md` §3.

### D07 — Terminal-message safety
- **Why:** on 2026-08-19, appending to an assistant message that was still mid-turn caused a provider rejection and cost the turn.
- **Consequence:** a guard may rewrite only a terminal assistant message (no tool-call block), and only through `guardedMessageRewrite`.
- **Implementation:** `src/safety.mjs`. **Evidence:** `tests/safety.test.mjs`; gate check `terminal-message-safety`; mutations listed in `docs/HARNESS_SYNC_2026-08-22.md` §PORTED.

### D08 — Extension registration grammar G1–G4
- **Why:** event-specific policy can be enforced only when the event name is readable at audit time.
- **Consequence:** registrations use `pi.on("literal", handler)` only. A computed or aliased registration is refused.
- **Implementation:** `src/registration-grammar.mjs`, `scripts/extension-audit.mjs`; commit `24e783b`. **Evidence:** `docs/CORE_CONTRACT.md` §8.1; `tests/registration-grammar.test.mjs`.

### D08-old — skip unreadable registrations — superseded by D08
- At `22e4efd` the audit saw a computed `message_end` registration and reported zero handlers. The release gate passed with an unconditional rewriter installed.

### D09 — Kill switch and fail-open
- **Why:** a control that throws into the turn does more harm than the error it guards against.
- **Consequence:** every control has a one-file off switch, and its own failure is contained.
- **Implementation:** `src/safety.mjs` `killSwitch` / `failOpen`. **Evidence:** `tests/safety.test.mjs`.

### D10 — Real vs synthetic gate provenance
- **Why:** "installed" and "working" must not share a word.
- **Consequence:** coverage reports `live`, `synthetic-only` or `never`. A synthetic hit is never claimed as working.
- **Implementation:** `src/gatelog.mjs`. **Evidence:** `tests/gatelog.test.mjs`; gate check `guard-fixtures`.

### D11 — Delegation return envelope
- **Why:** a child that goes idle without reporting looks finished and is not.
- **Consequence:** a return must carry the exact initiating session, a named awaiter, an independent verifier and a declared missing-report action. Delivery happens exactly once or stays pending.
- **Implementation:** `src/return-envelope.mjs`. **Evidence:** `tests/return-envelope.test.mjs`; gate check `return-envelope`.

### D11-old — self-derived field list — refuted
- The check iterated the list it was meant to verify, so deleting a field also stopped testing it. Mutation `envelope-drops-verifier` survived. The expected set is now pinned literally (`docs/HARNESS_SYNC_2026-08-22.md` §Defects).

### D12 — Two-jaw release gate
- **Why:** a gate that cannot fail is not a gate. A pass count reported without its runtime cannot be reproduced.
- **Consequence:** `node scripts/release-check.mjs` must exit 0, and `--negative` must kill every mutation (exit 3). A required check that is skipped counts as a failure.
- **Implementation:** `scripts/release-check.mjs`. **Evidence:** `README.md` §Release gate.

### D13 — Governed improvement loop
- **Why:** a repeated correction class is a harness defect, not bad luck.
- **Consequence:** a recurrence opens a proposal with landing, proof and cost. Semantic changes need human approval. Going live needs regression, rollback, quality auto-disable, canary and an independent verifier.
- **Implementation:** `src/domain.mjs`, `src/dream.mjs`. **Evidence:** `docs/CORE_CONTRACT.md` §11; gate checks `improvement-governance` and `dream-governance`.

### D13-old — landing/proof/cost deferred — superseded by D13
- This was deferred in the first 08-22 sync, then resolved in commit `e596fe1`.

### D14 — The loop can subtract
- **Why:** a loop that can only add makes its owner more self-consistent, never more correct.
- **Consequence:** the loop proposes retirement (unused past review) and refutation (own falsifier fired). It never applies a change and never counts its own proposals as evidence.
- **Implementation:** `src/dream.mjs`, `extensions/wos-dream.ts`. **Evidence:** gate check `dream-loop`.

### D15 — Portability: public mechanism, private configuration
- **Why:** a second, private copy of a mechanism drifts from the public one.
- **Consequence:** ported files keep their production names. Paths, identities, organization tools and personal policy stay private. A packaged-file finding fails the gate.
- **Implementation:** `scripts/portability-audit.mjs`. **Evidence:** `docs/PORTABILITY.md`; gate check `portability`.

### D16 — prose "unproven claim" predicate — refuted
- Its own history records three gates killed by its false alarms, and a "no real hit" claim that a replay had just disproved. Only the evidence tiers are ported (D10). The replay tier and a predicate with a quiet false-positive control remain deferred (`docs/HARNESS_SYNC_2026-08-22.md` §DEFERRED).

### D17 — Sanitized, installable `pi-config/` (2026-10-03)
- **Why:** the harness had become specific to one owner. Rebuilding it on a new box must need zero private data.
- **Consequence:** a local-only exporter regenerates `pi-config/` every week. A gate refuses the whole export on any name, path, host, id, token or project hit. A change produces one local commit; nothing is pushed.
- **Implementation:** `pi-config/README.md` (install order, placeholders), `pi-config/install.py` (plan by default). Commits `522ca23`, `bfe3191`. **Evidence:** `pi-config/EXCLUDED.md`; `pi-config/MANIFEST.json`; gate check `portability` covers `pi-config`.

### D17-old — directory-rename replace — superseded by D17
- The first live run on the synced-drive mount left a partial directory, because a directory rename there is not atomic. Writes are now per-file atomic (temp file plus replace), and removals go through git.

### D18 — Single-user safety rule (2026-10-03)
- **Why:** the system has one user. The real risk is our own agents' accidents, not attackers, and every new guard adds friction.
- **Consequence:** prefer undo over prevention, e.g. `install.py --backup` moves existing files aside. Dispatch independent verifiers for numbers, reader-facing work and irreversible work. New friction for the owner needs the owner's yes.
- **Implementation:** `pi-config/templates/AGENTS.md.template` §Operating contract. **Evidence:** `pi-config/install.py`.

### D19 — Read-only MCP allowlist
- **Why:** a tool that the guards cannot see must not write.
- **Consequence:** an MCP tool runs only if it is listed. An `mcp__` entry is admitted only while its server declares `readOnlyHint=true`. The write list stays empty.
- **Implementation:** `pi-config/extensions/wos-mcp-gate.ts`, `pi-config/templates/mcp_allowlist.yaml`.

### D20 — Model-choice table
- **Why:** a dispatcher that picks an off-table model is an error, not a judgment call.
- **Consequence:** each role has one model in the table, and an off-table override is refused. The only allowed fallback is a provider policy refusal. Unavailability means retrying the same model later. Model questions are never routed to the owner.
- **Implementation:** `pi-config/templates/model_choices.yaml`, `pi-config/runtime/fleet/model_choices.py`.

### D21 — Figure registry keeps every version; the gallery shows only the latest (2026-10-03)
- **Why:** no human can review hundreds of version slides.
- **Consequence:** the registry stays the truth, with every version kept on disk. The gallery is a disposable view: one slide per figure, its image replaced in place when a newer version is registered, newest first. It holds only charts that carry the message.
- **Implementation:** private (owner's analysis tooling); only the contract is recorded here. **Evidence:** this entry.

### D21-old — every version in the gallery — superseded by D21
- The full-history gallery grew past four hundred slides and could not be reviewed.

### D22 — One maintained register (2026-08-22)
- **Why:** a decision log compounds only when changing the harness carries an obligation to update it. Otherwise it becomes another stale archive.
- **Consequence:** this file. Superseded and refuted rows are kept. When the weekly export changes `pi-config/` and this file has not changed since the previous `pi-config` change, the run logs a warning.
- **Implementation:** this file; `CLAUDE.md` §Before shipping. **Evidence:** the weekly sync's warning line.

### D23 — Neutral `AGENTS.md` template plus an owner example (2026-10-04)
- **Why:** mechanical sanitizing of the owner's contract left a template that was neither neutral nor readable. It
  kept "past-the owner", "the owner-owned", ruling dates and "he/his", and it still imposed the owner's
  philosophy and language rule on anyone who installed it.
- **Consequence:** every export writes two files. `templates/AGENTS.md.template` is neutral: the general
  operating contract and hard invariants, with `<<FILL>>` placeholders for purpose, philosophy, owner
  preferences and folder map, and no dates, pronouns or language rule. `examples/AGENTS.owner-example.md` is
  the owner's live contract with the artifacts repaired. The exporter refuses if any listed artifact remains.
- **Implementation:** `pi-config/templates/AGENTS.md.template`, `pi-config/examples/AGENTS.owner-example.md`.
  **Evidence:** `tests/pi-config.test.mjs` (artifact patterns, plus a negative control that must catch planted artifacts).

### D23-old — sanitized owner contract as the template — superseded by D23
- In use from 2026-10-03 to 2026-10-04 (commits `522ca23`–`39e59e9`).

### D24 — The publish audit covers what is published, with an external deny list (2026-10-04)
- **Why:** the audit scanned the package's `files` closure (65 of 102 tracked files), its company-term list
  was empty unless an environment variable was set, and it never looked at commit metadata. A gate that
  cannot go red is not a gate, and a committed deny list publishes the very terms it protects.
- **Consequence:** `scripts/portability-audit.mjs` scans every `git ls-files` path (a copy without `.git`
  is walked), prints skips, and fails on zero files. Company, people and project terms come only from an
  external source (`PORTABILITY_DENY_TERMS`, `WOSC_DENY_FILE`, or `~/.config/wisdom-os-core/deny.txt`); none
  resolving exits 2 with "deny list unavailable". Over the outgoing range every author and committer email
  must be the public noreply identity (allow-list) and every commit message is scanned. Request-id shapes
  are refused. `npm install` points `core.hooksPath` at `scripts/git-hooks`, whose `pre-push` runs the audit
  on the pushed range; `--no-verify` is the only, visible bypass. CI reads the list from the
  `WOSC_DENY_LIST` secret and fails loudly without it.
- **Implementation:** `scripts/portability-audit.mjs`, `scripts/git-hooks/pre-push`, `scripts/install-hooks.mjs`,
  `.github/workflows/ci.yml`. **Evidence:** gate check `portability`; mutations `private-path-leaks`,
  `request-id-leaks-outside-package-files`, `deny-term-leaks-into-archive`.

### D24-old — package-closure audit, optional deny list — superseded by D24
- In use until 2026-10-04.

### D25 — Employer internals and owner principles never ship; CJK is gated (2026-10-07)
- **Why:** after D24 the export still carried the employer's internal CLI surface (its command names, its Pi
  distribution path, an internal search tool), the owner's personal razors and design filters in the worked
  example, a quoted owner ruling, and short session ids. Each passed because the deny sources matched names,
  not tool shapes, id shapes or another language.
- **Consequence:** the exporter maps the employer CLI surface to neutral words (`internal-cli`, `pi-dist`,
  `web.browse`, ...), short session ids to `<session>`, and drops quoted owner rulings. The owner example keeps the *shape* of its purpose,
  razors and filters with `<placeholders>`, because the owner's principles are owner content in any language.
  The private publish gate adds three arms: employer and product names plus the CLI shapes, a shared literal
  list of owner, project and Case terms (Director labels and public model ids are exempt as product
  vocabulary), and CJK text. Two CJK exemptions are printed on every run: lines already in a published tree,
  and the bilingual detector vocabulary in `pi-config/extensions/wos-open-loop.ts`. The name and deny arms
  still apply to both. The never-pushed range was rewritten blob by blob with the same scrub; nothing
  published was rewritten.
- **Implementation:** the private exporter and publish gate (outside this repo); `tests/pi-config.test.mjs`.
  **Evidence:** the gate's self-test (nine content poisons RED), and 0 hits on the published range.

## How to update

When a change alters a lasting behavior, edit this file in the same commit:

- To add a decision, give it the next ID.
- To change a decision, mark the old row `superseded by Dxx` (or `refuted`), keep its entry, and add the new one.
- Every entry names its implementation path and its evidence.
