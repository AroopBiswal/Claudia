# Claudia

Personal-assistant layer for Claude: an MCP server on this Mac mini, an Obsidian vault as the source of truth, and a Claude plugin. Before any work, read docs/KICKOFF.md (build brief and rules), docs/PLAN.md and docs/DECISIONS.md (Notion snapshots), and docs/ROADMAP.md (current progress).

## Roles
- Main session (Opus 5.5): plans, designs contracts, reviews every diff, integrates, commits and pushes.
- Subagents (Sonnet 5, in .claude/agents): implementer, test-engineer and researcher do the hands-on work. Spawn them with model claude-sonnet-5.

## Commands
- `npm run verify`: typecheck, lint, all tests, build. Must pass before every push (the pre-push hook enforces it).
- `npm run typecheck`: tsc --noEmit across src, tests, scripts, watchdog and plugin.
- `npm run lint`: eslint plus a prettier format check.
- `npm run format`: prettier --write on the whole repo.
- `npm run test`: run the full vitest suite.
- `npm run test:unit`: vitest run against tests/unit only.
- `npm run test:integration`: vitest run against tests/integration only.
- `npm run test:e2e`: vitest run against tests/e2e only.
- `npm run build`: compile src to dist with tsconfig.build.json.
- `npm run dev`: run src/cli.ts directly via Node's type stripping.
- Keep this section current as scripts are added.

## Hard rules
- The server never calls an AI API.
- The vault is the source of truth. Index, state and secrets live in ~/.claudia, never in iCloud or git.
- Never print or commit secrets. Never force-push or rewrite pushed history. Never push with a failing check.
- Never touch ~/.cloudflared, DNS or Cloudflare settings, or other services on this Mac. Go-live is a human step.
- Synthetic data only in tests; never write test data into the real vault.
- Anything that needs a human goes in docs/HUMAN_TODO.md; keep working around it.
