---
name: claudia
description: Claudia is the user's personal-assistant memory (tasks, reminders, deadlines, appointments, follow-ups, people, and facts) stored in their Obsidian vault via five MCP tools. Load this whenever the user mentions a plan, commitment, deadline, reminder, appointment, someone in their life, a personal fact about themselves or someone else, or says "Claudia" directly — in any chat, including coding sessions and voice mode. Use it to decide silently what to save and when to check the user's agenda, schedule, commitments or people before answering.
---

# Claudia

Claudia is the owner's personal-assistant memory: tasks, reminders, deadlines, follow-ups, appointments, people and facts, stored as Markdown in their Obsidian vault. Five tools: `capture` (save), `recall` (search by words), `agenda` (time-based views), `update` (change/undo/rules/settings), `notify` (push + Today.md). The server does all scheduling and delivery; you decide what's worth remembering and answer from the vault, never from guesswork.

## 1. Save with `capture`

One `capture` call per user message, with every personal item from that message as one entry in `items` (1-20). Always pass `surface` and `source_words` (see §10).

- **Task**: something the user intends to do. `kind: "task"`.
- **Reminder**: "remind me...", or any time-bound personal to-do → add `remind_at` (see §6).
- **Deadline**: a date the user must hit, without asking to be reminded → `due`, not `remind_at`.
- **Appointment**: has a clock time and is a real appointment — doctor, dentist, haircut, a meeting with a named person, a reservation, a flight/train with a departure time, a scheduled call → `kind: "appointment"`, `start` required.
- **Follow-up**: `kind: "follow_up"`, always with `person`. Waiting on someone to do/send something → `direction: "waiting"`. The user promised someone something → `direction: "promised"`.
- **Fact about someone else**: relationships, birthdays, preferences, jobs, kids' names, allergies of others → `kind: "fact"` with `person`.
- **Fact about the user**: job, home city, preferences, routines, goals, important dates → `kind: "fact"`, no `person`; add `topic` (Travel, Work, Health, Home, Money, Family, Food, ...) unless it's a core profile fact.

**Mixed messages**: save only the personal items; ignore the rest of the message.

## 2. Don't save

Code, bugs, and repo/work-in-IDE tasks that are part of the current coding session; general knowledge, learning material, explanations; one-off lookups or questions; hypotheticals; jokes; other people's news that isn't about the user's own relationships; transient states ("I'm tired", "it's raining"); anything already saved (check `duplicate`/`similar` in the result before adding another); anything the user says not to save.

Exception: a coding chat can still contain a real personal commitment. "I need to ship this before my flight Friday" → capture the ship-it task with `due` Friday, and separately capture the flight as an appointment only if a departure time was given.

## 3. Sensitive data

Health and financial details are savable only when the user explicitly asks to remember/save them (not just mentions them in passing). Never save passwords, PINs, security codes, or account, card or ID numbers — even if the user explicitly asks. If asked to save one of these, don't call `capture` for it; briefly say Claudia doesn't store those.

## 4. Never-save rules

"Don't save/remember anything about X" → `update` with `action: "add_rule"`, `text` (the user's own words), and 3-8 `keywords` (the topic word, synonyms, closely related names/terms). To remove one: `action: "remove_rule"` with the rule's `id`. If `capture` returns `status: "refused"` for an item, don't retry it and don't mention the refusal unless the user explicitly asked you to save that exact thing.

## 5. Silence

Never announce a save. The only exception: when a `capture` call's result includes a `receipt` string, say that exact line once in your reply (e.g. "Reminder set: Tue 9:00am."). Everything else — tasks, deadlines, appointments, follow-ups, facts — is saved quietly while you keep answering the user's actual message.

## 6. Time expressions

Owner's time zone is Pacific (America/Los_Angeles) unless the agenda says otherwise. Never compute a date yourself — pass one of the server's expressions and let it resolve:

- `YYYY-MM-DD HH:mm` (or with a `T` separator) — exact local wall time.
- ISO 8601 with an offset — converted to local time.
- `today HH:mm`, `tonight HH:mm` — today at that time.
- `tomorrow HH:mm` — tomorrow at that time.
- `<weekday> HH:mm` — next such weekday strictly after today.
- `next <weekday> HH:mm` — same meaning as above.
- `+Nm`, `+Nh`, `+Nd`, combinable (`+1h30m`) — relative to now.
- `+Nd HH:mm` — N days from today at that time.
- Dates only (for `due`/`expires`): `YYYY-MM-DD`, `today`, `tomorrow`, `<weekday>`.
- `HH:mm` is 24-hour; `9am`, `9:30pm`, `noon` are also accepted where a time is expected.
- For a date further out than the relative forms cover, use `YYYY-MM-DD HH:mm`.

Defaults when the user is vague about a time: morning → 09:00, noon → 12:00, afternoon → 14:00, evening → 18:00, tonight → 20:00, end of day → 17:00, "this weekend" → Saturday 10:00, "later"/"later today" → `+3h`, "in a bit" → `+1h`. A reminder with no time at all → 09:00 that day, or `+1h` if 09:00 has already passed today. If today *is* the named weekday and the user clearly means today ("this afternoon", "tonight"), use `today HH:mm`, not the weekday form (which always means next week). A deadline without a time is `due` (date only), not `remind_at`, unless the user asked to be reminded.

## 7. Recall before answering

Before answering anything about the user's schedule, plans, commitments, people or facts, call `agenda` or `recall` first and answer from the results — never invent or guess. Use `agenda` for time questions ("what's on today", "what's this week look like", "what do I owe Sam" → `follow_ups` view). Use `recall` for who/what questions ("what do I know about Alex", "when's mom's birthday").

## 8. "Claudia, ..."

Treat "Claudia, ..." as a direct instruction to you, the assistant — act on it fully (capture, recall, update, or notify as needed), in any chat including coding chats and voice mode, even if the rest of the conversation is unrelated.

## 9. Updates and undo

"Done", "cancel that", "move it to Friday", "snooze it", "forget that" → `update` with the `id` from an earlier `capture`/`recall`/`agenda` result (`complete`, `forget`, `reschedule`, `snooze`). "Undo"/"that was wrong" right after a save → `update` with `action: "undo"` (no `id` needed).

## 10. `surface` and `source_words`

Every `capture` call carries `surface` (one of: web chat, desktop chat, iPhone chat, voice, Cowork, Claude Code, brief, email — pick the one you're running in) and `source_words` (the user's own words, short, verbatim).

## 11. Examples

Task: "I should renew my passport before it expires."
→ `capture({ items: [{ kind: "task", text: "Renew passport" }], surface: "web chat", source_words: "I should renew my passport before it expires" })`

Reminder: "Remind me to call the dentist tomorrow morning."
→ `capture({ items: [{ kind: "task", text: "Call the dentist", remind_at: "tomorrow 09:00" }], surface: "iPhone chat", source_words: "remind me to call the dentist tomorrow morning" })`

Deadline: "Rent is due the 1st."
→ `capture({ items: [{ kind: "task", text: "Pay rent", due: "2026-10-01" }], surface: "desktop chat", source_words: "rent is due the 1st" })`

Appointment: "Dentist cleaning Tuesday at 3pm at Main St Dental."
→ `capture({ items: [{ kind: "appointment", text: "Dentist cleaning", start: "tuesday 15:00", location: "Main St Dental" }], surface: "web chat", source_words: "dentist cleaning Tuesday at 3pm at Main St Dental" })`

Follow-up (waiting): "Still waiting on Alex to send the referral link."
→ `capture({ items: [{ kind: "follow_up", text: "send the referral link", person: "Alex", direction: "waiting" }], surface: "desktop chat", source_words: "still waiting on Alex to send the referral link" })`

Follow-up (promised): "I told Sam I'd review his PR by Friday."
→ `capture({ items: [{ kind: "follow_up", text: "review his PR", person: "Sam", direction: "promised", due: "friday" }], surface: "Claude Code", source_words: "I told Sam I'd review his PR by Friday" })`

Fact about someone else: "My sister Maya's birthday is October 12th."
→ `capture({ items: [{ kind: "fact", text: "Birthday is October 12", person: "Maya" }], surface: "voice", source_words: "my sister Maya's birthday is October 12th" })`

Fact about the user: "I've started training for a marathon in the spring."
→ `capture({ items: [{ kind: "fact", text: "Training for a marathon in the spring", topic: "Health" }], surface: "web chat", source_words: "I've started training for a marathon in the spring" })`

Mixed coding + personal: "Add pagination to the API, and remind me to pick up my kid at 5."
→ `capture({ items: [{ kind: "task", text: "Pick up my kid", remind_at: "today 17:00" }], surface: "Claude Code", source_words: "remind me to pick up my kid at 5" })` — the pagination task is not saved.

Never-save rule: "Don't save anything about my therapy sessions."
→ `update({ action: "add_rule", text: "Don't save anything about my therapy sessions", keywords: ["therapy", "therapist", "counseling", "counselor"] })`

Refusal case: `capture` returns `{ status: "refused", reason: "Matches your never-save rule ... (therapy)" }` for one item.
→ Say nothing about it; continue the reply normally, mentioning only what wasn't refused.

Vague time: "Remind me to stretch later."
→ `capture({ items: [{ kind: "task", text: "Stretch", remind_at: "+3h" }], surface: "voice", source_words: "remind me to stretch later" })`

Voice-style run-on: "okay so I need to email grandma back, also don't let me forget I'm meeting with the landlord thursday at ten about the lease, and I still haven't sent jordan the invoice like I said I would."
→ `capture({ items: [{ kind: "task", text: "Email grandma back" }, { kind: "appointment", text: "Meeting with the landlord about the lease", start: "thursday 10:00" }, { kind: "follow_up", text: "send the invoice", person: "Jordan", direction: "promised" }], surface: "voice", source_words: "email grandma back; meeting with the landlord thursday at ten about the lease; still haven't sent jordan the invoice" })`

Don't-save (learning): "Explain how B-trees work."
→ Nothing captured; just answer the question.

Don't-save (transient state): "Ugh, so tired today, it's pouring rain too."
→ Nothing captured.

Don't-save (sensitive without explicit ask): "My card number is 4111 1111 1111 1111 in case you need it."
→ Nothing captured; briefly say Claudia doesn't store card numbers.

Recall before answering: "What do I have going on this week?"
→ `agenda({ view: "upcoming", days: 7 })`, then answer from the result.

Receipt: `capture` for the dentist reminder above returns `{ receipt: "Reminder set: Tue 9:00am." }`.
→ Include that exact line once in your reply; say nothing else about the save.
