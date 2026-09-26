# Roadmap

Scope: Phase 0 (everything doable locally) and Phase 1 (MVP), per docs/KICKOFF.md. Contracts: docs/vault-format.md (vault), docs/tools.md (MCP tools and HTTP endpoints). Status markers: ☐ todo, ◐ in progress, ☑ done (green and committed).

## Architecture

```
src/
  cli.ts                 serve | reindex | seed-vault | calendar-auth | smoke | --version
  config.ts              loadConfig(): CLAUDIA_HOME (default ~/.claudia), config.json, secrets dir
  clock.ts               Clock { now(): Date }, systemClock
  time/                  expressions.ts (time/date expressions), format.ts (display, receipts, DST-safe local<->instant)
  vault/                 line.ts, note.ts (lossless parse/serialize), items.ts (semantic items), ids.ts, layout.ts,
                         repeat.ts, settings.ts, rules.ts (rule matching + sensitive guard), templates.ts (seed notes)
  engine/                index.ts (SQLite + FTS5, rebuildable), state.ts (operational state), writer.ts (queued, quiet,
                         atomic, by block ID), watcher.ts, janitor.ts (conflict copies), idassign.ts, archive.ts, backup.ts
  services/              context.ts, capture.ts, recall.ts, agenda.ts, update.ts, notify.ts, log.ts, generated.ts
  scheduler/             scheduler.ts (reminders, catch-up, nudges, brief fallback, midnight and nightly jobs)
  notify/                ntfy.ts (publisher), links.ts (HMAC action links)
  calendar/              google.ts (REST client), auth.ts (one-time CLI consent), sync.ts (appointments <-> events)
  auth/                  access.ts (Cloudflare Access JWT), oauth.ts (authorization server), store.ts, consent.ts
  http/                  app.ts (express app), mcp.ts (tools + instructions), actions.ts (/a/<token>)
  main.ts                wires the service for `serve`
plugin/                  Claude plugin: skill, commands, connector reference
watchdog/                Cloudflare Worker (not deployed)
ops/                     install.sh, launchd plists, ntfy config, go-live runbook, cloudflared snippet (not applied)
tests/                   unit/, integration/, e2e/, eval/, fixtures/, helpers/
```

Rules for every module: dependencies are injected (clock, fetch, paths, stores), so tests use fake clocks, temp dirs and local servers only. The server never calls an AI API. No dev bypass or static token exists anywhere in product code.

## Milestones and tasks

### M0 Bootstrap ☑
- ☑ T1 Scaffold: TypeScript 6.0 strict on Node 24+, ESLint + Prettier, Vitest, `npm run verify`, CI (Node 24 and 26).
- ☑ T2 Notion snapshots (PLAN.md, DECISIONS.md), contracts (vault-format.md, tools.md), this roadmap, HUMAN_TODO.md.
- ☑ T3 Notion: project Status In Progress, GitHub Link set.
- Acceptance: verify green locally and in CI.

### Wave A (parallel, after M0) ☑
- ☑ **M8-A9 Self-hosted ntfy** (`ops/build-ntfy.sh`, `ops/ntfy-setup.sh`, self-test): server built from source (B17).
- ☑ **E2a Eval cases and scorer** (`tests/eval/cases.json`, `score.ts`).
- ☑ **M1-A1 Vault core** (`vault/line.ts`, `note.ts`, `items.ts`, `ids.ts`, `layout.ts`). Lossless line/note model, fields, tags, links, block IDs, canonical insertion, semantic items for every kind. Acceptance: byte-identical round trip on goldens in `tests/fixtures/vault/` (CRLF, BOM, no final newline, code fences, frontmatter, emoji variants, malformed lines); field edit tests show only the target bytes change; items extraction per note type.
- ☑ **M1-A2 Time and repeats** (`time/expressions.ts`, `time/format.ts`, `vault/repeat.ts`). Every form in docs/tools.md, DST gap and overlap, receipts, rrule text rules, next occurrence per vault-format section 7. Acceptance: table tests across the 2026-03-08 and 2026-11-01 transitions in America/Los_Angeles.
- ☑ **M6-A3 Settings, rules, templates** (`vault/settings.ts`, `vault/rules.ts`, `vault/templates.ts`). Acceptance: settings defaults and warnings; rule matching on whole words and phrases; sensitive guard catches passwords, PINs, card, account and ID-like numbers without flagging dates, times or phone-free text; templates match vault-format.md exactly.
- ☑ **M3-A4 OAuth and HTTP skeleton** (`auth/*`, `http/app.ts` with `/health`, well-known, `/oauth/*`, bearer middleware on `/mcp`). Acceptance: unit tests for DCR validation and redirect allowlist, PKCE S256, code single use and expiry, refresh rotation and reuse detection, Access JWT verification with locally generated keys (wrong audience, wrong issuer, wrong email, expired, bad signature), 401 with `WWW-Authenticate: Bearer resource_metadata=…`.
- ☑ **M4-A5 Action links and ntfy** (`notify/links.ts`, `notify/ntfy.ts`, `tests/helpers/fake-ntfy.ts`). Acceptance: tampered, expired, wrong-action and replayed links rejected; publish payload has Done, +1 hour, Tomorrow http actions and an obsidian:// click URL.
- ☑ **M5-A6 Google Calendar adapter** (`calendar/google.ts`, `calendar/auth.ts`). Scope `https://www.googleapis.com/auth/calendar.app.created` only; find-or-create the "Claudia" calendar; create, update, cancel; token refresh; fully mocked. Acceptance: request shapes asserted against a fake fetch.
- ☑ **M8-A7 Watchdog Worker** (`watchdog/`). Cron every 5 minutes, alert after two consecutive failures and once on recovery via a public ntfy.sh topic; KV state; not deployed. Acceptance: state machine tests.
- ☑ **M7-A8 Plugin and Claude setup docs** (`plugin/`, `scripts/pack-plugin.ts`, `npm run plugin:pack`, `docs/claude-setup.md`). Acceptance: structure test (manifest, frontmatter, connector URL), pack produces `dist/claudia-plugin.zip`.

### Wave B (after Wave A) ☑
- ☑ **QA-A Hardening**: edge cases for OAuth, Access JWTs, links, time, parser, rules; fixed approval replay, loopback redirect fragments, phone numbers near ID words.
- ☑ **M2-B1 Index and state** (`engine/index.ts`, `engine/state.ts`). SQLite index in `~/.claudia/index.db` with FTS5, rebuild from the vault, per-file reindex, queries for recall, agenda and scheduler; state in `~/.claudia/state.db`. Acceptance: rebuild equals incremental; search ranking; deleting index.db loses nothing.
- ☑ **M2-B2 Writer, watcher, janitor** (`engine/writer.ts`, `watcher.ts`, `janitor.ts`, `idassign.ts`, `archive.ts`). Acceptance: atomic replace, per-file serialization under concurrency, quiet-period wait with fake clock, edits located by block ID after the file shifted, conflict merge rules, ID assignment only where the contract allows.

### Wave C (after Wave B) ☑
- ☑ **M3-C1 Write services** (`services/context.ts`, `capture.ts`, `update.ts`, `log.ts`, `calendar/sync.ts`). Capture per docs/tools.md incl. rules and sensitive refusals, duplicates, people notes, follow-up links, appointments, receipts, Log lines, undo journal; every update action incl. repeat completion.
- ☑ **M6-C2 Read services and generated notes** (`recall.ts`, `agenda.ts`, `notify.ts`, `generated.ts`, `engine/backup.ts`).

### Wave D (after Wave C)
- ☐ **M3-D1 MCP layer and serve** (`http/mcp.ts`, `main.ts`, `cli.ts serve|reindex|seed-vault`). Integration test with the real MCP client over HTTP: 401 discovery, registration, PKCE, token, refresh rotation, then every tool.
- ☐ **M4-D2 Scheduler and action routes** (`scheduler/scheduler.ts`, `http/actions.ts`). Reminders, snooze, repeats, catch-up (last 2 hours individually, older bundled), nudges, brief fallback 90 minutes after the brief time, midnight Today refresh, nightly archive and backup.

### Wave E (after Wave D)
- ☐ **E1 End-to-end suite** (test-engineer): scratch vault + fake clock + fake ntfy: capture, file written, index updated, reminder fired, action link completes it, conflict copy merged; repeats and catch-up.
- ☐ **E2 Capture eval** (test-engineer): `tests/eval/` ~40 synthetic cases, runner using headless Claude Code against a scratch Claudia instance, report recall, precision, reminder-time accuracy.
- ☑ **M8-E3 Ops** (`ops/install.sh`, launchd plists, ntfy config and setup, `seed-vault`, `smoke`, `ops/go-live.md`, `ops/cloudflared-ingress.yml`).

### Finish
- ☐ Eval at target (recall ≥ 90%, precision ≥ 95%, reminder times 100%).
- ☐ Install on this Mac mini; smoke test through launchd, local ntfy and the signed Done link.
- ☐ HUMAN_TODO complete; push; CI green; Notion Build Tasks updated.

## Task brief template

Each task is dispatched with: goal, files owned, interfaces it must export, contracts to follow, acceptance tests, and these rules: work in the assigned worktree, run `npm ci --include=dev` first (this shell sets NODE_ENV=production), do not edit files owned by other tasks, do not add dependencies without saying why, commit on the worktree branch with conventional commits, and finish with `npm run verify` green.
