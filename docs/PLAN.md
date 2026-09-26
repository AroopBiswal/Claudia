# Plan (snapshot)

Snapshot of the Notion Plan page (https://app.notion.com/p/3e7e7c7c7bb481af8951e06ee97d9d79), taken 2026-09-26. If this file and Notion disagree, Notion wins.

> **Claudia turns Claude into a personal assistant.** You talk to Claude the way you already do (web, desktop, phone, voice mode, Cowork) and Claude quietly saves the personal things that matter: commitments, dates, appointments, people and facts about your life. They land as Markdown notes in an Obsidian vault you can read and edit anywhere. A small server on the Mac mini sends reminders and follow-up nudges to your phone, puts appointments on Google Calendar, and a morning brief tells you what's ahead. All the thinking runs on your Claude plan, so the server never calls an AI API.

## Principles
- **Automatic and silent, Apple-style.** Claudia only speaks up when a mistake would cost you, which means reminder times.
- **Your notes are the source of truth.** Everything else (index, caches) can be rebuilt from the vault.
- **Simple server, smart Claude.** The server stores, schedules and delivers; Claude does the understanding. No API bills for you or anyone who runs their own copy.
- **Private by default.** Data lives on the Mac mini and your own devices. Other people run their own copy on their own computer or server.
- **Spine first.** The vault format is the contract everything else builds on.

## How it fits together
```
You
 |  talk to Claude anywhere: web, desktop, iPhone, voice, Cowork, Claude Code
 v
Claude + Claudia plugin (skill decides what to save and when to look things up)
 |  MCP over HTTPS, OAuth with your email sign-in
 v
Cloudflare: Tunnel (public URL) + Access (email sign-in) + Watchdog Worker
 |
 v
Mac mini: Claudia server (TypeScript)
  vault engine  ->  Obsidian vault "Claudia" in iCloud  ->  Obsidian on iPhone and Mac
  scheduler     ->  ntfy (self-hosted)                  ->  push with Done / +1 hour / Tomorrow
                ->  Google Calendar                     ->  "Claudia" calendar for appointments

Cowork scheduled task (cloud, 7:30am default) -> morning brief via Claudia, Google Calendar, Gmail
```

## Core flows
1. **Capture.** You mention something in any chat. The skill decides it's assistant material and calls `capture`. The server appends a line to the right note and a line to today's log. Claude says nothing about it, except for timed reminders, which get one line: "Reminder set: Tue 9:00am."
2. **Reminders.** The scheduler sees a reminder come due and sends a push with Done, +1 hour and Tomorrow buttons. Tapping the notification opens the task in Obsidian; the buttons hit a signed link and the server edits the line in your vault.
3. **Appointments.** "Dentist Tuesday at 3" becomes an event on a Claudia calendar in Google Calendar. Only appointments go on the calendar. Those alerts come from Google, so they fire even if the Mac mini is down.
4. **Recall.** When a chat touches plans, people, schedules or commitments, Claude checks `recall` or `agenda` before answering.
5. **Morning brief.** A Cowork scheduled task runs at 7:30am by default, and each user can pick their own time. It reads your agenda from Claudia, today's events from Google Calendar, and anything forwarded to your +claudia address. It saves what's new, sends a short push, and emails the full brief only on days that need it (a deadline, travel, something needing prep, or a long list). If no brief has arrived 90 minutes after the scheduled time, the server sends a basic one itself.
6. **Follow-up nudges.** Things you're waiting on with no date nudge you after 5 days; things you promised nudge you on their due date. Both also appear in the brief.
7. **Edits in Obsidian.** Check a box or change a time on your phone, iCloud syncs it, and the server re-reads the note and reschedules. Tasks you type yourself count too: add ⏰ and a time and you'll get a push.
8. **Never-save rules.** Tell Claudia "don't save anything about X" and it's stored as a rule you can see in the vault. Claude turns each rule into keywords, and the server refuses matching saves and says why.

## The vault
A new Obsidian vault named **Claudia** in iCloud Drive, open on the Mac mini, iPhone and Mac.
```
Claudia/
├── Today.md                  written each morning, refreshed through the day
├── Recently captured.md      last 7 days of saves, newest first
├── Tasks/
│   ├── To do.md              tasks and reminders
│   ├── Follow-ups.md         waiting on / promised to, linked to people
│   └── Done/2026-09.md       completed items, archived monthly
├── People/Alex.md            one note per person
├── Memory/
│   ├── Profile.md            core facts about you
│   └── Topics/Travel.md      facts by area of life
├── Log/2026-09-26.md         every change: time, surface, your words
└── _claudia/
    ├── README.md             how the notes work
    ├── Settings.md           brief time, time zone, nudge timing (editable)
    └── Rules.md              things you've told Claudia never to save
```
```
Tasks/To do.md
- [ ] Call the dentist to reschedule ⏰ 2026-09-29 09:00 ^t9x2
- [ ] Laundry ⏰ 2026-09-27 19:00 🔁 every week on Sunday ^t2b7

Tasks/Follow-ups.md
- [ ] Waiting on [[Alex]]: resume draft #waiting 📅 2026-10-02 ^t4m1
- [ ] Send [[Alex]] the referral link #promised 📅 2026-09-30 ^t4m2

People/Alex.md
- Friend from college ^f1a9
- Job hunting for PM roles (as of 2026-09) ^f7k2

Log/2026-09-26.md
- 09:14 · iPhone chat · added [[To do#^t9x2|Call the dentist]] ⏰ Tue 9:00 · "remind me to call the dentist tuesday morning"
```
- Checklist lines use the Obsidian Tasks format (📅 due, 🔁 repeat, ✅ done) plus Claudia's own ⏰ for reminder times, so notes read cleanly on your phone with no plugins required.
- Every item ends with a short block ID, which makes links, merges and undo exact.
- Claudia handles repeats itself: complete a weekly task and the next one appears.
- Generated notes (Today, Recently captured) say at the top that Claudia rewrites them.

## Claude side
### Tools
Five tools, kept broad so Claude reliably picks the right one.

| Tool | What it does |
|---|---|
| `capture` | Save facts, tasks and reminders, follow-ups, and appointments, several at once. Returns near-duplicates so Claude can update instead of adding. Refuses saves that match a never-save rule. |
| `recall` | Search facts, people and tasks by words, with links to the notes. Read-only. |
| `agenda` | Time-based views: today, overdue, upcoming, follow-ups, recently captured, and the full brief payload. Read-only. |
| `update` | Complete, reopen, snooze, reschedule, edit, forget, undo the last save, and manage rules and settings. |
| `notify` | Send a push to your phone and optionally write Claude's summary into Today. Used by the brief and requests like "send this to my phone." |

### Claudia plugin
- **Skill** `claudia` with the rules: save commitments, dates, appointments, people, follow-ups and lasting facts about your life; ignore code, general knowledge, learning material and one-off lookups; save silently except for reminder times; check Claudia when plans, people or schedules come up; treat "Claudia, …" as full assistant mode; save health or financial details only when you explicitly say to remember them, and never passwords, account or ID numbers; respect your never-save rules; times in Pacific.
- **Commands:** `/claudia:sweep` (save anything missed in this chat), `/claudia:brief` (what's on my plate), `/claudia:undo`.
- **Connector reference**, so installing the plugin wires up Claudia too.

### Keeping Claudia separate from coding, learning and general chats
- **Content decides, not location.** The skill saves only assistant material, so a coding chat stays clean, but "I need to ship this before my flight Friday" still becomes a reminder.
- **A Claudia project** in Claude is the home for assistant chats: full assistant mode, and it checks the agenda at the start. Built-in memory is separate per project, while Claudia's memory spans everything.
- **Say the name.** "Claudia, …" forces assistant mode anywhere, which is handy in voice mode.
- **Off switch.** Turn the connector off for a single chat, or leave the plugin out of Claude Code.

### One-time setup in Claude
- Add the connector on web or desktop. Installing connectors on mobile is still beta; once added, it works on your phone and in voice mode.
- Set Claudia's tools to **Always allow**, otherwise every save asks for approval and nothing is silent.
- Upload the plugin and make sure code execution is on, since skills need it.
- Check that Claudia loads in unrelated chats. If Claude's automatic tool loading misses it, switch tool access to **Always available**.
- Add one line to your profile preferences as a backstop.
- Create the **Claudia** project.
- Create the **morning brief** Cowork scheduled task (7:30am daily by default).
- Leave Claude's built-in memory exactly as it is. The skill also writes to Claudia; the two don't sync, and Claudia is the one you can see and edit.

### Gmail
A Gmail filter labels anything sent to your address with +claudia added before the @ as "Claudia." The brief saves what's in it and moves it to "Claudia/Done."

## Server
- **Stack:** TypeScript on Node, the official MCP TypeScript SDK (Streamable HTTP, stateless), SQLite for the index, a file watcher, rrule for repeats, Luxon for time zones, and the Google Calendar API with the narrow scope that only lets Claudia touch calendars it created.
- **Modules:** MCP tools, OAuth, vault engine (parse, write, watch, merge), index, scheduler, notifiers (ntfy, calendar), signed action links, health check, brief fallback.
- **Storage:** the vault is the only source of truth. The search index and operational state (sent notifications, calendar links, OAuth clients and tokens) live in SQLite under `~/.claudia`, outside iCloud, and the index can be rebuilt from the vault at any time.
- **Writing safely:** small line-level edits located by block ID, written atomically. If you've just edited a note, Claudia waits for it to go quiet before touching it.
- **Sync conflicts:** when you and Claudia edit the same note at once, iCloud makes a copy like `To do 2.md`. A janitor merges the two by block ID (keeping completed or newest state), removes the copy and logs it.
- **After downtime:** reminders missed in the last 2 hours are sent individually; older ones are bundled into one "while I was offline" push.
- **Settings:** brief time, time zone and nudge timing live in `_claudia/Settings.md` so you can see and edit them; secrets stay in `~/.claudia`.

## Security and privacy
- **One address**, `claudia.aroopbiswal.com`, through the existing Cloudflare Tunnel. A Cloudflare Access app covers it with an email one-time code, only your address, and 30-day sessions.
- **Machine paths skip Access**, because Claude's servers can't sign in: `/mcp`, `/.well-known/*`, `/oauth/token`, `/oauth/register`, `/health`, and the signed action links.
- **Connecting Claude still uses your email sign-in.** The OAuth approval page stays behind Access, so when you add the connector you sign in with your email code, and Claudia checks Access's verified identity before issuing tokens. One sign-in system for everything.
- **A firewall rule** skips bot protection on the machine paths, since Cloudflare's bot protection can block Claude's requests.
- **OAuth to Claude's spec:** dynamic client registration, PKCE, a 401 pointing to the resource metadata, and rotating refresh tokens.
- **Action links** in notifications are signed, single-purpose and expire after 7 days.
- **ntfy runs on the Mac mini** with its own login. For iPhone delivery, only a message ID passes through ntfy.sh; the message itself stays on your Mac.
- **The vault is never exposed.** FileVault protects the Mac mini, and Advanced Data Protection end-to-end encrypts iCloud Drive.

## Running on the Mac mini
- Never sleep, start automatically after a power failure, keep iCloud files downloaded (turn off Optimize Mac Storage), and stay logged in, since iCloud and Messages need a user session.
- **FileVault catch:** after a power cut the Mac waits at the unlock screen, so Claudia is down until you log in. The watchdog tells you, calendar alerts keep working, and a small UPS for the Mac mini and router rides out short outages.
- Claudia, ntfy and cloudflared run as launchd services that restart on failure.
- The **watchdog** (a free Cloudflare Worker) checks `/health` every 5 minutes and pushes an alert after two failures, plus a recovery notice.
- **Backups:** Time Machine plus a nightly vault snapshot kept for 30 days, since iCloud syncs but isn't a backup.

## Phases
### Phase 0: Foundations (about 1 weekend)
Prep the Mac mini, create the vault, set up the tunnel, Access and firewall rule, self-host ntfy, and ship a hello-world MCP server with the full OAuth flow. Prove it on web, desktop, iPhone, voice mode, a Cowork scheduled task and Claude Code, and check the Always allow setting, automatic tool loading and ntfy buttons.
**Done when:** "Claudia, ping me" in voice mode on your phone produces a push.

### Phase 1: MVP (about 3 weekends)
- Vault format, engine and index; the five tools.
- Reminders with buttons, repeats and snooze.
- Appointments on the Claudia Google calendar.
- People, follow-ups and nudges; never-save rules.
- Log, Recently captured and Today notes.
- The plugin, the Claudia project and the Claude settings.
- Morning brief with the +claudia label, heavy-day emails and the server fallback.
- Watchdog, conflict janitor and backups.
- The capture test set.
**Done when:** the capture targets below are met and you've used it daily for two weeks without a missed reminder.

### Phase 2: Two-way and views (about 2 to 3 weekends)
- Two-way iMessage through the Mac mini's Claude Code session, starting with a spike on how the iMessage plugin treats messages Claudia sends to your own thread.
- Web dashboard behind Access: Today, tasks with actions, people, search, and Recently captured with undo.
- A commitments sweep of sent Gmail and your calendar inside the brief.
- An interactive Claudia panel inside Claude chats (MCP App).

### Phase 3: As needed
- Session-end sweeps using hooks in Cowork and Claude Code, running Claude headless on your plan.
- Apple Reminders toggle for people who host on a Mac.
- Semantic search with a local embedding model (still no API).
- A backup reminder relay on Cloudflare for Mac mini outages.

### Phase 4: If others want it
- An installer and setup guide for a Mac or a server.
- A settings screen.
- A check of Anthropic's naming rules before anything goes public.

## Testing and quality bar
- Unit tests for the Markdown round trip (reading then writing a note changes nothing), repeats, time zones and daylight saving, and conflict merges.
- MCP Inspector and Claude Code against a test vault for fast iteration.
- A capture test set of about 40 realistic messages (personal, coding, learning, voice-style) with expected results. Targets: at least 90% of real items saved, at least 95% of saves correct, every reminder time right. Rerun after every skill change.
- A surface checklist (web, desktop, iPhone, voice, Cowork, Claude Code) and failure drills: stop the server, cut the power, force an iCloud conflict.

## Risks
- **Claude doesn't call Claudia when it should.** The skill, Always allow, the tool loading check, the project, the name trigger and the test set; hooks later.
- **A silent save is wrong.** Receipts for times, the log, Recently captured and one-word undo.
- **The Mac mini goes down.** Watchdog, calendar alerts, UPS, and the relay in phase 3.
- **iCloud conflicts or lag.** Block IDs, small writes and the janitor; switch to Obsidian Sync if conflicts keep happening.
- **Cloudflare blocks Claude or OAuth misbehaves.** The firewall rule plus the full surface test in phase 0.
- **Preview features change.** Channels only appear in phase 2, and push stays the fallback.

## References
- Custom connectors using remote MCP: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Authentication for connectors: https://claude.com/docs/connectors/building/authentication
- What to build (MCP, plugin, or both): https://claude.com/docs/connectors/building/what-to-build
- Use plugins in Claude: https://support.claude.com/en/articles/13837440-use-plugins-in-claude
- Use skills in Claude: https://support.claude.com/en/articles/12512180-use-skills-in-claude
- Manage Claude's tool access: https://support.claude.com/en/articles/13730515-manage-claude-s-tool-access
- Use connectors (permissions, mobile): https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities
- Use voice mode: https://support.claude.com/en/articles/11101966-use-voice-mode
- Scheduled tasks in Cowork: https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork
- Interactive connectors (MCP Apps): https://support.claude.com/en/articles/13454812-use-interactive-connectors-in-claude
- Claude Code channels: https://code.claude.com/docs/en/channels
- ntfy self-hosted iOS delivery: https://docs.ntfy.sh/config/
- ntfy action buttons: https://docs.ntfy.sh/publish/
- Google Calendar API scopes: https://developers.google.com/workspace/calendar/api/auth
- Cloudflare Access Managed OAuth issue with claude.ai: https://github.com/anthropics/claude-ai-mcp/issues/410
- Claude.ai behind Cloudflare Zero Trust (WAF rules): https://github.com/homeassistant-ai/ha-mcp/discussions/1674
- OpenClaw memory architecture: https://docs.openclaw.ai/concepts/memory-architecture
- Cloudflare, the next generation of MCP: https://blog.cloudflare.com/mcp-v2/

## Build Tasks (Notion database snapshot, Phase 0 and 1)
| Phase | Task | Area | Priority |
|---|---|---|---|
| 0 | Prep the Mac mini (no sleep, auto-start after power failure, iCloud files kept local, stay logged in) | Infra | High |
| 0 | Create the Claudia vault in iCloud with folders, README, Settings and Rules notes | Vault | High |
| 0 | Add claudia.aroopbiswal.com to the Cloudflare Tunnel | Infra | High |
| 0 | Cloudflare Access app (email code, only my address) with bypass paths and WAF skip rule | Infra | High |
| 0 | Self-host ntfy on the Mac mini with iOS upstream and login | Infra | Medium |
| 0 | Hello-world MCP server with full OAuth (DCR, PKCE, 401 metadata, Access-verified approval page) | Backend | High |
| 0 | Prove the connector on web, desktop, iPhone, voice mode, Cowork and Claude Code | Claude | High |
| 0 | Check Always allow, automatic tool loading and ntfy buttons on iPhone | Claude | Medium |
| 1 | Vault format spec plus parser and writer with round-trip tests | Vault | High |
| 1 | SQLite index with keyword search, rebuildable from the vault | Backend | High |
| 1 | File watcher, quiet-period writes and iCloud conflict merge | Vault | High |
| 1 | MCP tools: capture, recall, agenda, update, notify | Backend | High |
| 1 | Scheduler: reminders, repeats, snooze and downtime catch-up | Backend | High |
| 1 | ntfy pushes with Done, +1 hour and Tomorrow signed action links | Backend | High |
| 1 | Claudia calendar in Google Calendar for appointments (app-created scope) | Backend | Medium |
| 1 | People notes, follow-ups and nudges | Backend | Medium |
| 1 | Never-save rules (Rules note plus keyword guard) | Backend | Medium |
| 1 | Log, Recently captured and Today notes | Vault | Medium |
| 1 | Claudia plugin: skill, sweep, brief and undo commands, connector reference | Claude | High |
| 1 | Claude setup: Always allow, tool loading, profile line, Claudia project | Claude | Medium |
| 1 | Morning brief Cowork task (+claudia label, heavy-day email) and server fallback | Claude | High |
| 1 | Watchdog Worker on Cloudflare | Infra | Medium |
| 1 | Backups: Time Machine and nightly vault snapshots | Infra | Low |
| 1 | Capture test set (about 40 messages) and runner | Quality | High |
| 1 | Two weeks of daily use without a missed reminder | Quality | High |
