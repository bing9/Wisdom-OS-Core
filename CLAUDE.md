# Wisdom OS Core Operating Contract

This repository is a **Pi package**. Pi's TUI is the primary interface; do not rebuild or restore the
browser cockpit as the product surface. The v0.1 web implementation is archived under
`archive/web-v0.1/` for provenance only.

Shared work state lives outside the model session:

- default: private project-keyed state under `~/.wisdom-os/projects/`
- explicit shared mode: `<project>/.wisdom-os/state.json`
- override: `WISDOM_OS_STATE=/absolute/path/state.json`

Before work:

1. Read the context injected by `extensions/wisdom-os.ts` or run `node cli.mjs butler`.
2. Inspect the relevant task/decision and its generated handoff.
3. Retrieve active, amended, and refuted precedents before a consequential decision.

During work:

- Record material feedback and requirement changes through the `wisdom_os` tool.
- Record every human correction or verifier rejection as a typed process signal. Repeated classes become harness-improvement work automatically.
- Record commands, results, and artifact evidence.
- Keep maker and verifier independent for consequential work.
- Keep the TUI a view; `src/store.mjs` is the write path.

Hard gates:

- Never bank a decision on the human's behalf.
- Never mark a task done without explicit human acceptance.
- Never change case law without an observed outcome and explicit human action.
- Never ship a harness control without a regression test, rollback, quality auto-disable, canary result, and independent verifier. Semantic controls also require human approval.
- Never bypass a failed transition gate by editing JSON directly.
- Surface at most three items needing human judgment.

Priority: the outcome→case→future-decision loop matters more than UI polish or agent count.
