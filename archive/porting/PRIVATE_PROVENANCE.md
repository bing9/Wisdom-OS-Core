# Port plan — preserve the proven Pi harness, strip the private policy

> **Correction, 2026-08-22 (A53).** This plan named its public descendants `extensions/butler.ts`,
> `extensions/guards.ts` and `extensions/decision-ui.ts`. Those filenames never shipped. The port
> kept the production names instead — `wos-butler.ts`, `wos-guards.ts`, `wos-lane.ts` — which is what
> `PORTABILITY.md` requires and what the package manifest has always declared. The table and tree
> below are corrected in place; this note records what they used to say so the history is not lost.
> A fourth private extension, `wos-return.ts`, appeared after this plan was written and is
> adjudicated in `docs/HARNESS_SYNC_2026-08-22.md`, not here.

## Correction

The first v0.2 spike (`extensions/wisdom-os.ts`) rebuilt lifecycle and TUI behavior from scratch.
That was the wrong abstraction boundary. The existing Pi extensions are already production prototypes
paid for by real incidents. The public package should **port their mechanisms**, not re-imagine them.

The only genuinely new code is the portable storage/kernel bridge in `src/store.mjs` and
`src/domain.mjs`. Everything users touch should descend from the running private extensions.

## Provenance map

| Private production source | Public descendant | Preserve | Strip / replace |
|---|---|---|---|
| `~/.pi/agent/extensions/wos-butler.ts` | `extensions/wos-butler.ts` | first-turn handoff injection; stale-state banner; quiet status; `/butler` pattern; fail-open + one-file kill switch | `the private runtime directory`; owner-specific authority; private cron assumptions; background launcher |
| `~/.pi/agent/extensions/wos-guards.ts` | `extensions/wos-guards.ts` | `tool_result` gates; transient/no-match/partial-coverage shapes; recurring-class ledger; terminal-message safety predicate; gate manifest and real-vs-synthetic evidence | personal incident prose; personal mirror; private authority index; personal verbosity threshold |
| `~/.pi/agent/extensions/wos-lane.ts` | `extensions/wos-lane.ts` | `DynamicBorder`/`SelectList` overlays; human reason capture; maker≠verifier flow; no transcript mutation; UI as view | private Case queue; owner lane; private branding; Python commands; private citations |
| `~/.pi/agent/extensions/wos-return.ts` | `src/return-envelope.mjs` (contract only) | envelope completeness; exact-session binding; exactly-once delivery; idle ≠ completion; named awaiter and independent verifier | the transport: private dispatch process, private receipt ledger, organization-specific recovery |
| `~/.pi/agent/extensions/herdr-agent-state.ts` | **not copied** | — | Herdr owns and overwrites it; package integrates via ordinary Pi lifecycle only |
| new v0.2 spike `extensions/wisdom-os.ts` | `archive/spikes/wisdom-os-ground-up.ts` | source of store/tool experiments only | not shipped as the product extension |

## Public entrypoints

```text
extensions/
├── wos-butler.ts   # derived from wos-butler.ts, production name kept
├── wos-guards.ts   # derived from wos-guards.ts, production name kept
└── wos-lane.ts     # derived from wos-lane.ts, production name kept
```

Shared public kernel:

```text
src/store.mjs            # private/shared local state, lock, atomic write, read-back
src/domain.mjs           # gates, handoff, precedents, correction→improvement
src/safety.mjs           # terminal-message predicate, append-don't-replace, kill switch, fail-open
src/gatelog.mjs          # gate manifest, gate telemetry, real-vs-synthetic coverage
src/guard-predicates.mjs # the shipped result-time predicates, importable by tests
src/return-envelope.mjs  # the delegation return transaction contract
```

## Private policy becomes configuration

The public package exposes generic settings; it does not ship one person's answers:

```json
{
  "stateMode": "private | shared | read-only",
  "maxHumanFindings": 3,
  "recurrenceThreshold": 2,
  "reservedTransitions": ["bank", "done", "learn", "semantic-improvement"],
  "voicePrompt": null,
  "externalActionPolicy": "human"
}
```

A private package may layer Harness persona voice, organization tools, private paths, and local authority
over the public package. Public updates then improve the private harness instead of forking it.

## Acceptance

- Each public extension names its private ancestor in its file header.
- A behavior table maps every retained mechanism to a test.
- No private token/path/person survives the public package audit.
- A golden replay proves the public extension reproduces the private extension's behavior on
  portable fixtures.
- `extensions/wisdom-os.ts` is not in the package manifest.
