# Decisions

## Decision Log (snapshot)

Snapshot of the Notion Decision Log (https://app.notion.com/p/3e7e7c7c7bb4813695e4f2c04cadbc43), decided 2026-09-26. If this file and Notion disagree, Notion wins.

| No. | Decision | Choice | Notes |
|---|---|---|---|
| 1 | Who it's for | Personal first; others run their own copy later | Aroop hosts his on the Mac mini. Others can host on their own computer or server, which is also better for privacy. |
| 2 | Claude's built-in memory | Keep as is, and also write to Claudia | The two don't sync. Claudia is the one you can see and edit. |
| 3 | What v1 tracks | Facts about you; tasks and reminders; people and follow-ups | Projects are tags only. No daily journal in v1. |
| 4 | How much Claude saves on its own | Automatic and silent, Apple-style | Exception: timed reminders get a one-line receipt. Everything is visible in Recently captured. |
| 5 | How Claude is made to use Claudia | Connector plus Claudia plugin now; session-end hooks later | Plugin: skill with capture rules, plus sweep, brief and undo commands. |
| 6 | When Claude checks Claudia | When the topic involves plans, people, schedules or commitments | Separation from coding and learning chats: content rules, a Claudia project, the "Claudia, …" name trigger and a per-chat off switch. |
| 7 | Capture outside Claude chats | iMessage via the Mac mini; Gmail and Calendar check | Forward to your Gmail with +claudia before the @ (labeled "Claudia"). No dedicated address. |
| 8 | Memory design | Markdown notes per subject, keyword search | New Obsidian vault named Claudia in iCloud Drive. |
| 9 | Task and reminder engine | Claudia's own | Optional Apple Reminders toggle for people who host on a Mac (phase 3). |
| 10 | How reminders reach you | Push via ntfy, Google Calendar for appointments, email for heavy-day briefs | Only appointments go on the calendar. |
| 11 | Proactive routines | Morning brief and follow-up nudges | Brief defaults to 7:30am daily; each user can pick their own time. |
| 12 | Where the thinking happens | Simple server, smart Claude | The server never calls an AI API. |
| 13 | Where you view and edit | Obsidian for the MVP; web dashboard in phase 2 | Dashboard sits behind Cloudflare Access with an email one-time code. |
| 14 | Hosting | Mac mini (TypeScript on Node), Cloudflare in front | Tunnel for the public URL, Access for sign-in, a Worker as watchdog. |
| 15 | Build or adopt | Build a thin custom server, borrowing ideas from OpenClaw | Keep everything on the Claude plan so users never pay for an API. |
| 16 | MVP scope | Connector, facts, tasks, people and follow-ups, push, plugin, morning brief | Obsidian is the MVP dashboard. |
| 17 | Vault sync to phone | iCloud Drive | Switch to Obsidian Sync if conflicts keep happening. |
| 18 | Never-save rules | Sensitive defaults plus rules you tell Claudia | Rules are stored in the vault so you can see and edit them. |
| 19 | Sign-in | Cloudflare Access with an email code; OAuth for the connector | The connector's approval page sits behind Access, so it's one sign-in system. |

### Defaults
- Every item keeps where it came from (time, surface, your words), with a change log and undo.
- Five broad tools rather than dozens.
- Recurring reminders and snooze from day one; times shown in Pacific.
- Facts can carry an expiry, and stale ones surface in the brief.
- Health and financial details are saved only on an explicit "remember this"; passwords, account numbers and ID numbers never.
- The whole vault is plain Markdown, so exporting is just copying the folder.

## Build-time decisions

Open product questions resolved during the build, choosing what best fits the Plan and Decision Log.

| No. | Topic | Choice | Why |
|---|---|---|---|
| B1 | Service runtime | The launchd service runs on an official, Developer ID signed Node.js 24 LTS binary copied to `~/.claudia/runtime/bin/node`, not Homebrew's node. | macOS privacy controls (TCC) block launchd jobs from reading iCloud Drive (`Operation not permitted`, verified on this Mac). A one-time Full Disk Access grant is needed; a stable path with a stable signature keeps that grant across upgrades, whereas Homebrew's ad-hoc signed node changes identity on every upgrade. |
| B2 | SQLite | Built-in `node:sqlite` (FTS5 included); no native modules. | No compile step, same engine in CI and on the Mac mini. |
| B3 | Running TypeScript | Source imports use `.ts` extensions and run directly with Node type stripping; `tsc` rewrites them for the installed build. | Fast dev and eval loops without a bundler. |
| B4 | Appointments in the vault | Appointments live in `Tasks/Appointments.md` as `- [ ] Title #appointment 🗓️ YYYY-MM-DD HH:mm-HH:mm ^aXXXX`, mirrored to the Claudia Google calendar. | The vault stays the source of truth and recall/agenda see appointments; the plan's tree is illustrative. |
| B5 | Snooze | Snooze writes `💤 YYYY-MM-DD HH:mm`; the reminder fires at the later of ⏰ and 💤. ⏰ keeps the scheduled time, so repeats never drift. Rescheduling rewrites ⏰ and clears 💤. | Visible in Obsidian and keeps repeating reminders on their original time. |
| B6 | Block IDs | New IDs are a kind letter (t task, a appointment, f fact, r rule) plus 4 random base36 characters; the parser accepts any Obsidian block ID. | Short like the plan's examples, with more room to avoid collisions. |
| B7 | Follow-up nudges | Follow-ups carry ➕ created. With 📅: nudge on that date at the nudge time. Without 📅: nudge 5 days after ➕ at the nudge time, then every 5 days while open. | Matches "waiting on after 5 days, promised on the due date" and keeps open loops visible. |
| B8 | Push actions | Done completes; +1 hour snoozes to now + 1 hour; Tomorrow snoozes to tomorrow at the reminder's time of day. | Predictable, one tap. |
| B9 | OAuth approval | `/oauth/authorize` (behind Access) verifies the Cloudflare Access JWT for the owner email and shows an Approve button; approval posts a signed, short-lived form. Redirect URIs are restricted to Claude's callbacks and loopback. | Stops a silently auto-approved code from leaking to a rogue registered client while the owner has a 30-day Access session. |
| B10 | No bypass | Product code has no dev bypass and no static tokens. Tests and the eval mint tokens through the real token store in-process. | A bypass that doesn't exist cannot be enabled in the installed service. |
| B11 | Backups | The nightly vault snapshot runs inside the Claudia service (which holds the vault permission), writing to `~/.claudia/backups`, kept 30 days. | A separate launchd shell job would need its own privacy grant. |
| B12 | Near-duplicates | A new item whose normalized words match an open item of the same kind at 0.8 or more (Jaccard) is not saved and is returned as a duplicate; 0.5 to 0.8 is saved and returned as similar. | Lets Claude update instead of adding, without extra calls in the common case. |
| B13 | Time expressions | `remind_at`, `start`, `until` accept `YYYY-MM-DD HH:mm` (local), ISO with offset, `today HH:mm`, `tomorrow HH:mm`, `<weekday> HH:mm` (next such day after today), and `+30m` / `+2h` / `+1d`. The server resolves them in the vault time zone and echoes the result. | Date arithmetic is deterministic on the server; reminder times must be 100% right. |
| B14 | Rules and Settings format | Rules are `- <rule> 🚫 kw1, kw2 ^rXXXX` in `_claudia/Rules.md`; Settings are `- Key: value` lines in `_claudia/Settings.md`. | Readable and editable on a phone without plugins. |
| B15 | Sensitive guard | Besides the user's rules, the server refuses passwords, PINs and long digit sequences that look like account, card or ID numbers. | The Decision Log's "never" list, enforced even if Claude slips. |
| B16 | Ports and hostnames | Claudia listens on 127.0.0.1:8787; ntfy on 127.0.0.1:8790. At go-live ntfy gets its own hostname (`ntfy.aroopbiswal.com`) because ntfy must be served at a root URL. | Local-only binding; nothing is exposed until the human go-live. |
| B17 | ntfy server binary | Homebrew's ntfy for macOS is client-only (built with `noserver`), so `ops/build-ntfy.sh` builds the v2.28.0 server from source with a Go toolchain kept in `~/.claudia/tools`; the binary lives at `~/.claudia/ntfy/bin/ntfy`. | ntfy upstream only ships server builds for Linux; the macOS server build works and is what the Makefile uses for development. |
| B18 | Client registration | Dynamic Client Registration only; Client ID Metadata Documents are not advertised. | The kickoff asks for DCR; Claude falls back to DCR whenever CIMD is not advertised (MCP spec 2026-07-28 deprecates DCR, so CIMD is a follow-up). |
| B19 | Bearer middleware | A small custom middleware instead of the SDK's `requireBearerAuth`, so a request without a token gets `WWW-Authenticate: Bearer resource_metadata=…` without an `error` parameter, and an invalid token adds `error="invalid_token"` (RFC 6750). | Exact header semantics Claude's discovery relies on. |
| B20 | MCP SDK line | `@modelcontextprotocol/sdk` 1.30.1 (v1) for the MCP server. | v2 moved auth helpers to a frozen legacy package; v1 is maintained and supports stateless Streamable HTTP. |
| B21 | Tunnel | Claudia has its own Cloudflare Tunnel (`claudia`, LaunchAgent `com.aroop.claudia.tunnel`, config in `~/.claudia/tunnel`) instead of sharing Bull and Bear's. Chosen by the owner at go-live, 2026-09-26. | Bull and Bear's `~/.cloudflared/config.yml` is generated by that project ("do not hand-edit") and its tunnel runs as a root LaunchDaemon, so sharing it would mean hand edits that get overwritten and sudo restarts that interrupt Bull and Bear. |
