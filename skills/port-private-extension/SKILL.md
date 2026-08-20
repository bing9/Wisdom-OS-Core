---
name: port-private-extension
description: Extract a proven private Pi extension into a reusable public Pi package without copying private identity, paths, policy, or data. Use when publishing, open-sourcing, sanitizing, or reusing a local extension or TUI.
---

# Port a private Pi extension

The goal is not repeated sanitization. **Extract once, then make the public mechanism canonical.**
The private harness becomes configuration or a thin adapter over it.

## Process

1. Read the private source and its incident history. List behavior as `mechanism | policy | data`.
2. Preserve mechanism: lifecycle event, transition, TUI interaction, failure behavior, and receipt.
3. Keep the production filename and public command names. Move personal voice, identities, absolute
   paths, organization tools, and local authority into a private adapter/config. Never encode
   environment in sibling names or replace private policy with vague public defaults.
4. Put durable state behind one public store API. TUI components never write their own store.
5. Name the private ancestor in the public file header and create golden fixtures for retained behavior.
6. Run `node scripts/portability-audit.mjs`; add local identity terms through
   `PORTABILITY_DENY_TERMS=a,b,c` without committing them.
7. Test through Pi itself with `pi -e .`; a TypeScript file existing is not evidence it loads.
8. Change the private harness to consume/configure the public mechanism. If both full implementations
   remain, the port is incomplete.

## Gates

- No public package contains runtime data or private paths.
- No private extension managed by another tool is copied; integrate through its public lifecycle.
- No semantic policy is generalized from one person's preference.
- No public behavior loses its source incident, regression test, rollback, or negative control.
- A clean audit prints the package roots and file count.
