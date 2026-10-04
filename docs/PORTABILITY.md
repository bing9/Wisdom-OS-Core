# Portability contract — public mechanism, private configuration

A proven local extension is not copied and sanitized forever. It is extracted once, **keeping the
production filename and command names** so provenance and future diffs stay mechanical:

```text
private production extension
  → identify mechanism / policy / data seams
  → port mechanism with golden fixtures
  → public extension becomes canonical
  → private harness imports/configures the public mechanism
```

## Classification

| Layer | Public | Private |
|---|---|---|
| Lifecycle mechanics, state machine, TUI components, gates | yes | import them |
| Absolute paths, identities, organization tools, stakeholder names | no | adapter/config |
| Personal voice and decision policy | optional separate package | default private |
| Recorded decisions, events, cases, artifacts | never | runtime state |

## Required provenance

Every ported extension keeps its production filename and names its production ancestor in the
header. Every retained behavior has a golden fixture. Tests import the public predicate or primitive;
they never copy its implementation. Environment differences belong in configuration—not sibling
names like `public-butler` / `private-butler`.

## Publication gate

Run:

```bash
node scripts/portability-audit.mjs
pi -e . --list-models
node --test tests/*.test.mjs
```

The audit enumerates every tracked file (`git ls-files`), not only the package's `files` closure, and
rejects private homes, request ids, live web entrypoints and every term of the external deny list
(employer, internal tools and hosts, people, private layout). The deny list is never committed: it is read
from `PORTABILITY_DENY_TERMS`, `WOSC_DENY_FILE` or `~/.config/wisdom-os-core/deny.txt`, and the audit exits 2
when none resolves. Over the outgoing range (`--range`, else `origin/main..HEAD`) it also requires the
public noreply identity on every commit and scans every commit message. It prints its file count, roots
and skips; a clean result without coverage is not a result. `npm install` installs the `pre-push` hook.

## Future rule

New reusable behavior lands in Wisdom-OS-Core first. The private harness consumes it and contributes
only configuration or a narrow organization adapter. A second full implementation is a defect.
