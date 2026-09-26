# Progress

## 2026-09-26
- M0 Bootstrap: Notion plan, decision log and build tasks read and snapshotted (docs/PLAN.md, docs/DECISIONS.md). Contracts written (docs/vault-format.md, docs/tools.md). Scaffold (TypeScript 6.0 strict, ESLint, Prettier, Vitest, CI on Node 24 and 26) with `npm run verify` green. Notion project set to In Progress with the GitHub link.
- Found that launchd jobs cannot read the iCloud vault without a Full Disk Access grant; installed the official, signed Node 24.21.0 runtime at `~/.claudia/runtime/bin/node` so the grant is stable (docs/DECISIONS.md B1, docs/HUMAN_TODO.md 1).
