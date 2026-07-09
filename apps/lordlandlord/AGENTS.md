# Agent Handoff

Before starting work on this repo, check the reliability rewrite tracker:

- Monorepo GitHub tracker: https://github.com/jwcodes12/claude-sandbox/issues/10
- Previous standalone tracker: https://github.com/jwcodes12/lordlandlord/issues/9
- Local plan: `docs/plans/2026-07-02-progress-and-remaining.md`

Current task order:

1. `#11` Step 6b: WebSocket server and browser transport adapter.
2. `#12` Step 7: browser reconnect and resume UX.
3. `#13` Step 8: cleanup legacy singleton and PeerJS paths.

Completed work is summarized in tracker `#10`; previous standalone closed issues are `jwcodes12/lordlandlord#2` through `#5`.

When finishing a step:

- Update the relevant GitHub issue.
- Update `docs/plans/2026-07-02-progress-and-remaining.md`.
- Record verification commands and results.
- Do not treat `node_modules/.vite/vitest/results.json` as product work; it is generated test cache.

This app was imported from the standalone `/home/opc/lordlandlord` checkout into `apps/lordlandlord`.
