# Port plan — preserve the proven Pi harness, strip the private policy

## Correction

The first v0.2 spike (`extensions/wisdom-os.ts`) rebuilt lifecycle and TUI behavior from scratch.
That was the wrong abstraction boundary. The existing Pi extensions are already production prototypes
paid for by real incidents. The public package should **port their mechanisms**, not re-imagine them.

The only genuinely new code is the portable storage/kernel bridge in `src/store.mjs` and
`src/domain.mjs`. Everything users touch should descend from the running private extensions.

## Provenance map

| Private production source | Public descendant | Preserve | Strip / replace |
|---|---|---|---|
| `~/.pi/agent/extensions/wos-butler.ts` | `extensions/butler.ts` | first-turn handoff injection; stale-state banner; quiet status; `/butler` pattern; background handoff economics | `the private runtime directory`; the owner-specific authority; private cron assumptions; `/bg` launcher |
| `~/.pi/agent/extensions/wos-guards.ts` | `extensions/guards.ts` | `tool_result` gates; transient/no-match/partial-coverage shapes; recurring-class ledger; terminal-message safety; real-vs-synthetic evidence | personal incident prose; personal mirror; private authority index; personal verbosity threshold |
| `~/.pi/agent/extensions/wos-lane.ts` | `extensions/decision-ui.ts` | `DynamicBorder`/`SelectList` overlays; human reason capture; maker≠verifier flow; no transcript mutation; UI as view | private Case queue; the owner lane; Harness persona branding; Python commands; private citations |
| `~/.pi/agent/extensions/herdr-agent-state.ts` | **not copied** | — | Herdr owns and overwrites it; package integrates via ordinary Pi lifecycle only |
| new v0.2 spike `extensions/wisdom-os.ts` | `archive/spikes/wisdom-os-ground-up.ts` | source of store/tool experiments only | not shipped as the product extension |

## Public entrypoints

```text
extensions/
├── butler.ts       # derived from wos-butler.ts
├── guards.ts       # derived from wos-guards.ts
└── decision-ui.ts  # derived from wos-lane.ts
```

Shared public kernel:

```text
src/store.mjs   # private/shared local state, lock, atomic write, read-back
src/domain.mjs  # gates, handoff, precedents, correction→improvement
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
