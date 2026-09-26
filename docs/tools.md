# MCP tools (contract)

Five tools on `POST /mcp` (Streamable HTTP, stateless, JSON responses, OAuth bearer required). Every tool returns `structuredContent` (the JSON below) and one short text block summarizing it. Every result includes `now`: the current local time in the vault time zone, formatted `YYYY-MM-DD HH:mm Ddd` (for example `2026-09-26 11:20 Sat`).

Tool errors that Claude should see (validation problems, unknown IDs) come back as normal results with `isError: true` and a one-line explanation, never as protocol errors.

## Time expressions

Used by `remind_at`, `start`, `end`, `until` and (date forms only) `due` / `expires`. Resolved by the server in the vault time zone (Settings, default America/Los_Angeles):

| Form | Example | Meaning |
|---|---|---|
| `YYYY-MM-DD HH:mm` (or `T` separator) | `2026-09-29 09:00` | local wall time |
| ISO 8601 with offset | `2026-09-29T16:00:00Z` | converted to local |
| `today HH:mm`, `tonight HH:mm` | `today 15:00` | today at that time |
| `tomorrow HH:mm` | `tomorrow 09:00` | |
| `<weekday> HH:mm` | `tuesday 09:00` | next such weekday strictly after today |
| `next <weekday> HH:mm` | `next friday 18:00` | same as above |
| `+Nm`, `+Nh`, `+Nd` (combinable: `+1h30m`) | `+2h` | relative to now; `+1d` keeps the current time |
| `+Nd HH:mm` | `+3d 09:00` | N days from today at that time |
| dates: `YYYY-MM-DD`, `today`, `tomorrow`, `<weekday>` | `friday` | for `due` and `expires` |

`HH:mm` is 24-hour. `9am`, `9:30pm`, `noon` are also accepted in place of `HH:mm`. Anything else is rejected with `isError` and the accepted forms.

## capture

Save facts, tasks and reminders, follow-ups and appointments; several at once.

Input:
```json
{
  "items": [ CaptureItem, ... ],          // 1 to 20
  "surface": "iPhone chat",               // optional: where the user said it (web chat, desktop chat, iPhone chat, voice, Cowork, Claude Code, brief, email)
  "source_words": "remind me to call the dentist tuesday morning"   // optional: the user's words, verbatim, short
}
```
CaptureItem (flat object; which fields apply depends on `kind`):
| Field | Type | Kinds | Notes |
|---|---|---|---|
| `kind` | `task` \| `follow_up` \| `appointment` \| `fact` | all | required |
| `text` | string | all | task/follow-up/fact text, or appointment title. Required. |
| `remind_at` | time expression | task, follow_up | makes it a timed reminder |
| `due` | date expression | task, follow_up | 📅 |
| `repeat` | string | task | Tasks-style rule, e.g. `every week on Sunday` |
| `person` | string | follow_up (required), fact | person's name as the user says it |
| `direction` | `waiting` \| `promised` | follow_up (required) | |
| `topic` | string | fact | area of life, e.g. `Travel`, `Health`, `Work`. Omit for core profile facts. |
| `expires` | date expression | fact | ⌛ |
| `start` | time expression | appointment (required) | |
| `end` | time expression | appointment | same day; default start + 60 min |
| `location` | string | appointment | appended to the title as `at <location>` |
| `tags` | string[] | task, follow_up | without `#` |

Output:
```json
{
  "now": "2026-09-26 11:20 Sat",
  "results": [
    {
      "index": 0,
      "status": "saved",                 // saved | duplicate | refused | invalid
      "kind": "task",
      "id": "t9x2k",
      "note": "Tasks/To do.md",
      "line": "- [ ] Call the dentist ⏰ 2026-09-29 09:00 ^t9x2k",
      "reminder": { "local": "2026-09-29 09:00", "display": "Tue 9:00am" },
      "calendar": "created",             // appointments only: created | pending | not_configured
      "similar": [ { "id": "t1a2b", "text": "...", "note": "..." } ],
      "reason": "..."                    // for duplicate / refused / invalid
    }
  ],
  "receipt": "Reminder set: Tue 9:00am."  // present only when a timed reminder was saved
}
```
- `refused`: matched a never-save rule or the sensitive-data guard; `reason` names the rule and keyword, e.g. `Matches your never-save rule "Nothing about my therapy sessions" (therapy).` Nothing is written.
- `duplicate`: an open item of the same kind is nearly identical; `similar[0]` is the existing item. Nothing is written. Use `update` to change it.
- Receipt display: today → `today 3:00pm`; within the next 6 days → `Tue 9:00am`; later → `Mon Oct 12, 9:00am`. Several reminders → `Reminders set: Tue 9:00am; Sun 7:00pm.`
- Side effects: vault line, Log line, index update, calendar event for appointments.

Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`.

## recall

Search facts, people, tasks, follow-ups, appointments and rules by words. Read-only.

Input:
```json
{ "query": "dentist", "kinds": ["task", "appointment"], "person": "Alex", "include_done": false, "limit": 10 }
```
All but `query` optional. `kinds` ⊆ `task, follow_up, appointment, fact, rule`. `limit` 1 to 50, default 10. An empty `query` with `person` lists everything about that person.

Output:
```json
{
  "now": "…",
  "total": 1,
  "results": [
    {
      "id": "t9x2k", "kind": "task", "status": "open",
      "text": "Call the dentist to reschedule",
      "note": "Tasks/To do.md",
      "reminder": "2026-09-29 09:00", "snoozed_until": null, "due": null, "appointment": null,
      "repeat": null, "expires": null, "stale": false,
      "tags": [], "people": [],
      "link": "obsidian://open?vault=Claudia&file=Tasks%2FTo%20do.md%23%5Et9x2k"
    }
  ]
}
```
Annotations: `readOnlyHint: true`, `openWorldHint: false`.

## agenda

Time-based views. Read-only.

Input: `{ "view": "today" | "overdue" | "upcoming" | "follow_ups" | "recent" | "brief", "days": 7 }` (`days` for upcoming and recent, default 7, max 60).

Output: `{ now, timezone, view, …sections }` where items use the recall result shape:
- `today`: `appointments`, `reminders`, `due` (all for today, sorted by time).
- `overdue`: `reminders` (effective reminder in the past, still open), `due` (📅 before today, still open).
- `upcoming`: `appointments`, `reminders`, `due` for the next `days` days, excluding today.
- `follow_ups`: `waiting`, `promised`, `nudges_due` (follow-ups whose nudge time has passed).
- `recent`: `captures` (Log `added` entries of the last `days` days, newest first: time, surface, id, text, note).
- `brief`: everything the morning brief needs: `today`, `overdue`, `upcoming` (7 days), `follow_ups`, `stale_facts`, `recent` (last 24 hours), `counts` (numbers per section), `brief_published_today` (bool), `settings` (time zone, brief time), `warnings` (settings problems, repeats not understood).

The text block renders the view as a short list.

Annotations: `readOnlyHint: true`, `openWorldHint: false`.

## update

Change existing items, undo, and manage rules and settings.

Input:
```json
{
  "action": "complete" | "reopen" | "snooze" | "reschedule" | "edit" | "forget" | "undo" | "add_rule" | "remove_rule" | "set_setting",
  "id": "t9x2k",               // item or rule block ID (with or without ^); required except undo, add_rule, set_setting
  "until": "+1h",              // snooze
  "remind_at": "friday 10:00", // reschedule (task / follow-up); "" removes the reminder
  "due": "2026-10-03",         // reschedule; "" removes
  "start": "…", "end": "…",    // reschedule an appointment
  "repeat": "every day",       // edit; "" removes
  "text": "…",                 // edit: new description (tags/links kept if Claude includes them); add_rule: the rule in the user's words
  "keywords": ["therapy", "therapist"],   // add_rule: 1 to 20 keywords or short phrases
  "setting": "Brief time", "value": "08:00",   // set_setting
  "surface": "…", "source_words": "…"
}
```
Behaviour:
- `complete`: `[x]` plus `✅ today`; repeating tasks get their next occurrence (vault-format section 7). Appointments: `[x]` only.
- `reopen`: `[ ]`, removes ✅.
- `snooze`: sets 💤; rejected if `until` is not after the current ⏰ (use `reschedule`).
- `reschedule`: sets ⏰ / 📅 / 🗓️ and clears 💤.
- `edit`: replaces the description, keeping fields and block ID.
- `forget`: deletes the line (and cancels the calendar event for appointments).
- `undo`: removes every line the most recent `capture` call added (if still present) and logs it; a second undo undoes the capture before that.
- `add_rule` / `remove_rule`: edit `_claudia/Rules.md`.
- `set_setting`: edit `_claudia/Settings.md` after validating the value.

Output: `{ now, status: "ok" | "not_found" | "invalid", id?, message, item? }` where `item` is the updated item in recall shape.

Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: false`.

## notify

Send a push to the owner's phone and optionally write Claude's summary into Today.

Input:
```json
{
  "message": "3 things today; dentist at 3pm.",
  "title": "Morning brief",          // optional
  "priority": "low" | "default" | "high",
  "kind": "message" | "brief",       // brief marks today's brief as published (stops the server fallback)
  "today_summary": "…markdown…",     // optional: replaces the Brief section of Today.md
  "open_id": "t9x2k"                 // optional: tapping the push opens this item in Obsidian
}
```
Output: `{ now, status: "sent" | "failed", today_updated: boolean, reason? }`.

Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`.

## Server instructions

Sent in the MCP `initialize` result:

> Claudia is the owner's personal assistant memory: tasks, reminders, follow-ups, appointments, people and facts, stored in their Obsidian vault. Save personal commitments, dates, appointments, people and lasting facts with `capture`, silently, except for one-line reminder receipts. Do not save code, general knowledge, learning material or one-off lookups. Check `agenda` or `recall` before answering questions about plans, people, schedules or commitments. Times are in the owner's time zone (Pacific unless Settings say otherwise); prefer relative time expressions such as `tomorrow 09:00`, `tuesday 15:00` or `+2h` and let the server resolve them. Never save passwords, account numbers or ID numbers.

## HTTP endpoints (besides /mcp)

| Path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | `{ status: "ok" \| "degraded", version, vault: {path_ok, writable}, index: {items, last_rebuild}, scheduler: {last_tick}, ntfy: {configured}, calendar: {configured}, settings_warnings: [] }` (no secrets, no personal content) |
| `GET /.well-known/oauth-protected-resource`, `…/mcp` | none | RFC 9728 metadata; `resource` = `<publicUrl>/mcp` |
| `GET /.well-known/oauth-authorization-server` | none | RFC 8414 metadata |
| `POST /oauth/register` | none | RFC 7591 dynamic client registration (JSON) |
| `GET /oauth/authorize` | Cloudflare Access | Access JWT check, then the approval page |
| `POST /oauth/approve` | Cloudflare Access | approval form target; redirects with the code |
| `POST /oauth/token` | client (public, PKCE) | form-urlencoded; `authorization_code` and `refresh_token` grants |
| `POST /oauth/revoke` | client | RFC 7009 |
| `GET/POST /a/<token>` | signed link | push actions; GET shows a confirm button, POST performs the action |
