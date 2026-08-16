# Claude Code Operating Contract

This repository uses `data/board.json` as shared work state. Do not keep unique context only in chat.

Before work:

1. Run `node cli.mjs butler`.
2. Run `node cli.mjs list task` and inspect the relevant handoff.
3. Move only the selected task to the appropriate stage.

During work:

- Record material feedback and requirement changes with `node cli.mjs feedback ...`.
- Record commands, results, and artifact evidence with `node cli.mjs run ...`.
- Keep the maker and verifier independent for consequential work.

Hard gates:

- Never bank a decision on the human's behalf.
- Never mark a task done without explicit human acceptance.
- Never bypass a failed transition gate by editing JSON directly.
- Surface at most three items needing human judgment.

Priority:

The compounding context/decision ledger matters more than orchestration sophistication or UI polish. Validate one real workflow before adding architecture.
