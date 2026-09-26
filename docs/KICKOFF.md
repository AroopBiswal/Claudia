# Claudia MVP: build brief

You are building the MVP of Claudia, a personal-assistant layer for Claude. This brief is the process contract; the Notion plan is the product contract.

## Repo
This repo already exists at /Users/aroopbiswal/Code/Deployments/Claudia with a GitHub remote named origin. Inspect what's there before scaffolding and build on it rather than replacing it. Never delete existing files without recording why in docs/DECISIONS.md.

## Roles
- You (main session, Opus 5.5, xhigh effort): architect and orchestrator. Plan, design the contracts (vault format, tool schemas, module boundaries, data flow), split work into small tasks, review every diff, integrate, commit and push. Keep your context for design, review and decisions.
- Subagents (Sonnet 5, defined in .claude/agents): `implementer` writes code and its tests for one task; `test-engineer` builds test suites, fixtures, the end-to-end harness and the capture eval; `researcher` looks up APIs and docs and returns short cited answers. Delegate all hands-on implementation, test writing and doc lookups to them. Small integration fixes of a few lines are fine to do yourself.
- Always spawn subagents with model claude-sonnet-5. Run independent tasks in parallel with worktree isolation and merge them yourself; keep dependent tasks sequential.

## Sources of truth
Read these with the Notion connector before planning, then save snapshots to docs/PLAN.md and docs/DECISIONS.md so the plan survives compaction. If a snapshot and Notion disagree, Notion wins.
- Claudia project page: https://app.notion.com/p/3e7e7c7c7bb48158bd3bc16b0e590073
- Plan: https://app.notion.com/p/3e7e7c7c7bb481af8951e06ee97d9d79
- Decision Log: https://app.notion.com/p/3e7e7c7c7bb4813695e4f2c04cadbc43
- Build Tasks database: https://app.notion.com/p/1aed5182bfdc47b8ad16d057282cf2cc (data source collection://7a8c76ed-ab87-41f4-8579-e978fdcce9ab)

## Scope: Phase 0 (everything doable locally) and Phase 1 (MVP)
1. M0 Bootstrap: Notion snapshots; docs/ROADMAP.md with milestones, small tasks (aim for diffs under about 300 lines) and acceptance checks; scaffold on top of what exists (TypeScript strict on Node LTS, test runner, linter, `npm run verify` = typecheck + lint + all tests + build); GitHub Actions CI running verify; in Notion, set the Claudia project Status to In Progress and its GitHub Link to this repo's URL (gh repo view --json url -q .url).
2. M1 Vault format: docs/vault-format.md as the contract; parser and writer with byte-identical round-trip golden tests. Obsidian Tasks emoji format (📅 due, 🔁 repeat, ✅ done), Claudia's ⏰ reminder field, block IDs at line ends, people notes, memory notes, daily logs, generated notes with a "Claudia rewrites this note" header, _claudia/Settings.md and _claudia/Rules.md. Repeats accept Tasks-style phrases like "every week on Sunday".
3. M2 Engine: SQLite index with keyword search in ~/.claudia, rebuildable from the vault; file watcher; quiet-period, atomic, line-level writes located by block ID; iCloud conflict-copy janitor that merges by block ID and logs what it did.
4. M3 MCP server: official MCP TypeScript SDK, Streamable HTTP, stateless; five tools (capture, recall, agenda, update, notify) with clear descriptions, JSON schemas and annotations (recall and agenda read-only), plus server instructions; /health. OAuth authorization server to Claude's connector spec: dynamic client registration, PKCE S256, 401 with WWW-Authenticate Bearer resource_metadata, protected resource and authorization server metadata, form-urlencoded token endpoint, rotating refresh tokens, fast responses. /oauth/authorize requires a valid Cloudflare Access JWT (Cf-Access-Jwt-Assertion) for the owner email, verified against the Access team JWKS; tests use locally generated keys. Any dev bypass or static test token must be impossible to enable in the installed service.
5. M4 Reminders: scheduler (fake-clock testable) for reminders, repeats, snooze and downtime catch-up (last 2 hours sent individually, older ones bundled); follow-up nudges (waiting-on after 5 days, promised on the due date); ntfy adapter for a self-hosted ntfy with Done, +1 hour and Tomorrow actions as HMAC-signed single-purpose links that expire after 7 days; tapping the notification opens the task through an obsidian:// link.
6. M5 Calendar: Google Calendar adapter using only the calendar.app.created scope and a calendar named Claudia; appointments only; create, update, cancel; an auth CLI command I run once; fully mocked in tests.
7. M6 Notes and rules: Log, Recently captured and Today generation; never-save rules (capture refuses matches using keywords Claude supplies with each rule, and says why); settings (brief time default 07:30 America/Los_Angeles, editable in Settings.md); brief fallback 90 minutes after the brief time if no brief was published that day.
8. M7 Claude side: plugin/ with the claudia skill (capture rules from the plan: what to save and what to ignore, silent except timed-reminder receipts, recall triggers, the "Claudia, ..." trigger, sensitive-info rules, never-save rules, Pacific time), commands sweep, brief and undo, and a connector reference to https://claudia.aroopbiswal.com/mcp; `npm run plugin:pack` builds dist/claudia-plugin.zip. Also docs/claude-setup.md with the Claudia project instructions, the profile preferences line, and the Cowork scheduled task prompt for the 7:30am brief (push always, email only on heavy days, process the Gmail label "Claudia" and move handled items to "Claudia/Done").
9. M8 Ops: ops/install.sh that builds and installs Claudia as a launchd agent (label com.aroop.claudia) pointed at the real vault; seed the vault skeleton (README, Settings, Rules, folders) without touching anything else in it; self-hosted ntfy config and launchd agent (upstream-base-url https://ntfy.sh, deny-all default access, one user, credentials in ~/.claudia/secrets); nightly vault backup to ~/.claudia/backups kept 30 days; watchdog/ Cloudflare Worker (cron every 5 minutes, alert after two failures and on recovery via a public ntfy.sh topic) with tests but NOT deployed; ops/go-live.md runbook and a cloudflared ingress snippet, NOT applied.

## Working loop
1. Plan the next milestone in docs/ROADMAP.md with a brief per task: goal, files, interfaces, acceptance tests.
2. Dispatch each task to implementer. Parallelize independent tasks with worktree isolation.
3. Review the diff yourself for correctness, security and fit with the plan. Send fixes back to the subagent.
4. Have test-engineer add edge cases, then run `npm run verify`.
5. When green, commit: small conventional commits (feat, fix, test, chore, docs), one logical change each.
6. End of milestone: full verify, `git push` to origin (the pre-push hook runs verify), then check CI with `gh run watch` or `gh run list` and fix anything red before moving on. Update docs/ROADMAP.md, docs/PROGRESS.md and the Notion Build Tasks (In Progress when started, Done when finished).
7. After any context compaction, re-read CLAUDE.md, this brief and docs/ROADMAP.md before continuing.

## Testing bar
- Unit: round-trip goldens, repeats, time zones and daylight saving, conflict merges, never-save guard, signed links, OAuth.
- Integration: a real MCP client over HTTP covering the 401 discovery, registration, PKCE, refresh rotation and every tool.
- End to end, with a scratch vault and fake clock: capture, file written, index updated, reminder fired through ntfy, action link completes it, conflict copy merged.
- Capture eval in tests/eval: about 40 synthetic messages (personal, coding, learning, voice-style, things that must not be saved, things covered by a never-save rule). The runner uses headless Claude Code against a scratch Claudia instance, for example: claude -p "<message>" --model claude-sonnet-5 --permission-mode dontAsk --mcp-config tests/eval/mcp.json --allowedTools "mcp__claudia-eval__*" --append-system-prompt-file plugin/skills/claudia/SKILL.md. Report recall, precision and reminder-time accuracy. Targets: recall at least 90%, precision at least 95%, reminder times 100%. Full eval runs use my Claude plan, so run them sparingly and iterate on subsets.
- Never weaken, skip or delete a test to get green. Fix the code or the fixture.

## Human steps
Anything that needs my dashboards, phone, passwords, sudo or account consent: don't attempt it and don't block on it. Add it to docs/HUMAN_TODO.md with exact steps and values, stub or mock the dependency, and keep going. Expected entries: Mac mini power and iCloud settings (pmset, Optimize Mac Storage off); the Google Cloud OAuth client and running the calendar auth command; go-live (tunnel ingress, DNS routes, Access app and bypass paths, WAF skip rule, watchdog deploy); the ntfy iPhone app; adding the connector and setting Always allow; uploading the plugin and turning on code execution; the profile line; the Claudia project; the Cowork brief task; the Gmail filter and labels; opening the vault in Obsidian on my phone. For Notion Build Tasks that end up waiting on me, set Status to In Review and add a comment pointing to the HUMAN_TODO entry.

## Guardrails
- Work only in this repo, ~/.claudia, ~/Library/LaunchAgents/com.aroop.claudia*.plist, and the Claudia vault (only the skeleton seed, the installed service, and one clearly labeled smoke-test reminder that you remove afterwards with forget).
- Never modify ~/.cloudflared, DNS, Cloudflare settings, the existing Bull and Bear services, or the Claude Code and iMessage setup already running on this Mac.
- Never print secrets. Generate them straight into files under ~/.claudia/secrets with mode 600. Keep .env files out of git.
- Never force-push, never rewrite pushed history, never push with a failing check.
- Never send messages or email. Notion writes are limited to the Claudia project page and its Build Tasks. Use Gmail and Calendar read-only, if at all.
- Synthetic data only in tests and evals; never copy personal data into the repo.
- The server never calls an AI API, and no model SDKs go into server dependencies.
- If a product decision is truly open, choose what best fits the Plan and Decision Log, record it in docs/DECISIONS.md under "Build-time decisions", and continue.

## Finish
Your final turn must print fresh output of: `npm run verify`; the eval summary; the local smoke test (launchd service healthy; scripted MCP session captures a timed reminder, the vault line appears, the scheduler fires it through local ntfy, the signed Done link completes it, the smoke item is removed); `git status --short`; `git log --oneline -15`; the push result and CI status; and the contents of docs/HUMAN_TODO.md.
