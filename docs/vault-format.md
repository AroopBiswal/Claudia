# Vault format (contract)

This is the contract between the Obsidian vault, the Claudia server and Claude. Everything else builds on it. The vault is the only source of truth; the index and state in `~/.claudia` can be rebuilt or lost without losing data.

## 1. Files and folders

```
Claudia/
├── Today.md                  generated, rewritten through the day
├── Recently captured.md      generated, last 7 days of saves, newest first
├── Tasks/
│   ├── To do.md              tasks and reminders
│   ├── Follow-ups.md         waiting on / promised to
│   ├── Appointments.md       appointments (mirrored to the Claudia Google calendar)
│   └── Done/YYYY-MM.md       completed items, archived by completion month
├── People/<Name>.md          one note per person
├── Memory/
│   ├── Profile.md            core facts about the owner
│   └── Topics/<Topic>.md     facts by area of life
├── Log/YYYY-MM-DD.md         every change Claudia makes
└── _claudia/
    ├── README.md             how the notes work (seeded once, never rewritten)
    ├── Settings.md           settings (editable)
    └── Rules.md              never-save rules (editable)
```

Other files and folders (for example `Welcome.md`, `Inbox/`, `Notes/`, `Daily/`, `Attachments/`, `.obsidian/`) belong to the owner. Claudia indexes Markdown anywhere in the vault except `.obsidian/`, `.trash/` and dot-folders, but only writes to the files above, plus adding block IDs to open task lines that carry ⏰ (section 6).

Note names: `People/<Name>.md` and `Memory/Topics/<Topic>.md` use the display name with the characters `\ / : * ? " < > | # ^ [ ]` removed and whitespace collapsed. Links use the file's basename: `[[Alex]]`.

## 2. Encoding and round trip

- UTF-8. A leading BOM, the line ending style (LF or CRLF, per file) and the presence or absence of a final newline are preserved exactly.
- The parser is lossless: `serialize(parse(text)) === text` for every input, including malformed notes.
- Edits are line-level. Changing one field of one line leaves every other byte of the file unchanged.
- Lines inside fenced code blocks (``` or ~~~) and inside the frontmatter block are never parsed as items.

## 3. Frontmatter markers

A note may start with YAML frontmatter (`---` on the first line, closed by the next `---`). Claudia only reads one key:

| `claudia:` value | Meaning |
|---|---|
| `generated` | Claudia rewrites the whole note (Today, Recently captured). Never indexed for items. |
| `settings` | `_claudia/Settings.md` |
| `rules` | `_claudia/Rules.md` |
| `readme` | `_claudia/README.md`. Not indexed for items. |

Generated notes also start their body with the line
`> Claudia rewrites this note. Edit the notes it links to instead.`
and never contain block IDs.

## 4. Lines

### 4.1 List items

```
<indent><bullet> <content>
<indent><bullet> [<status>] <content>        (task)
```

- `indent`: spaces or tabs (kept as is). `bullet`: `-`, `*`, `+`, or `1.` / `1)`.
- `status` is exactly one character between the brackets. ` ` open, `x` or `X` done, `-` cancelled. Any other character (for example `/`, `>`, `!`) is preserved and treated as open.
- A list item without brackets is a **fact line** when it is in `People/`, `Memory/`, and a **rule line** in `_claudia/Rules.md`. Elsewhere, plain list items are indexed as text only.

### 4.2 Block IDs

- A block ID is ` ^<id>` at the very end of the line, where `<id>` matches `[A-Za-z0-9-]+`. Trailing whitespace after it is tolerated and preserved.
- Claudia generates IDs as one kind letter plus 4 characters from `[a-z0-9]`: `t` task or follow-up, `a` appointment, `f` fact, `r` rule. Example `^t9x2k`. IDs are unique across the vault (checked against the index, regenerated on collision).
- Every item Claudia creates has a block ID. Links, merges, action links and undo are keyed by block ID, never by line number.

### 4.3 Fields

A field is an emoji token preceded by whitespace (or line start of the content), followed by one space and a value. The value runs until the next recognized field emoji, a tag that follows a field, the block ID, or the end of the line. If a value does not parse, the token is treated as plain description text (and still round-trips unchanged).

| Emoji | Name | Value | Owner |
|---|---|---|---|
| ⏰ | reminder | `YYYY-MM-DD HH:mm` | Claudia |
| 💤 | snoozed until | `YYYY-MM-DD HH:mm` | Claudia |
| 🗓️ (or 🗓 without VS16) | appointment | `YYYY-MM-DD HH:mm` or `YYYY-MM-DD HH:mm-HH:mm` | Claudia |
| ⌛ | fact expires | `YYYY-MM-DD` | Claudia |
| 🚫 | rule keywords | comma-separated keywords or phrases | Claudia (Rules.md only) |
| 🔁 | repeat | rule text, e.g. `every week on Sunday` | Obsidian Tasks |
| ➕ | created | `YYYY-MM-DD`, or `YYYY-MM-DD HH:mm` on fact lines (the moment Claudia saved the fact) | Obsidian Tasks (tasks, follow-ups), Claudia (facts) |
| 🛫 | start | `YYYY-MM-DD` | Obsidian Tasks (preserved, unused) |
| ⏳ | scheduled | `YYYY-MM-DD` | Obsidian Tasks (preserved, unused) |
| 📅 | due | `YYYY-MM-DD` | Obsidian Tasks |
| ❌ | cancelled | `YYYY-MM-DD` | Obsidian Tasks |
| ✅ | done | `YYYY-MM-DD` | Obsidian Tasks |
| ⏫ 🔼 🔽 🔺 ⏬ | priority | none | Obsidian Tasks (preserved) |

- Tags are `#tag` tokens (letters, digits, `_`, `-`, `/`; not all digits) anywhere in the content. Claudia uses `#waiting`, `#promised` and `#appointment`; projects are tags like `#project/claudia`.
- Wiki links `[[Target]]`, `[[Target|alias]]`, `[[Target#^id|label]]` are indexed; a link whose target is a note in `People/` makes that person part of the item.
- The **description** is the content with the status box, fields, and block ID removed (tags and links stay in it).

### 4.4 Canonical order for lines Claudia writes

```
- [ ] <description> <#tags> ⏰ … 💤 … 🗓️ … 🔁 … ➕ … 📅 … ✅ … ^id
- <fact text> ⌛ … ➕ … ^id
- <rule text> 🚫 … ^id
```

Claudia's own fields come before the Obsidian Tasks fields so that the Tasks plugin reads them as part of the description and still parses its own trailing fields. When Claudia edits an existing line it changes the field value in place; a field that is added is inserted at its canonical position relative to the fields already present; a removed field takes its leading space with it.

## 5. Notes

### Tasks/To do.md
```
# To do

- [ ] Call the dentist to reschedule ⏰ 2026-09-29 09:00 ^t9x2k
- [ ] Laundry ⏰ 2026-09-27 19:00 🔁 every week on Sunday ^t2b7m
- [ ] Renew passport 📅 2026-11-01 ^t8c1d
```
New tasks are appended after the last list item of the note (or at the end of the note).

### Tasks/Follow-ups.md
```
# Follow-ups

- [ ] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-09-26 📅 2026-10-02 ^t4m1q
- [ ] Send [[Alex]] the referral link #promised ➕ 2026-09-26 📅 2026-09-30 ^t4m2w
```
Every follow-up links one person and carries `#waiting` or `#promised` and ➕. If the text Claude supplies already contains the person's name, the first occurrence becomes the link; otherwise waiting items are written `Waiting on [[Name]]: <text>` and promised items `<text> (for [[Name]])`. The person's note is created if missing.

### Tasks/Appointments.md
```
# Appointments

- [ ] Dentist cleaning at Main St Dental #appointment 🗓️ 2026-09-29 15:00-16:00 ^a3k9p
```
Mirrored to the Claudia Google calendar (section 8). Appointments do not produce ntfy pushes; Google Calendar alerts cover them.

### Tasks/Done/YYYY-MM.md
```
# Done 2026-09

- [x] Call the dentist to reschedule ⏰ 2026-09-29 09:00 ✅ 2026-09-29 ^t9x2k
```
The nightly archive moves completed and cancelled lines whose ✅ or ❌ date is before today, and appointments whose date is more than one day past (marked `[x]` with ✅ of the appointment date), from `Tasks/*.md` into the Done note for that month, verbatim. The block ID moves with the line.

### People/<Name>.md, Memory/Profile.md, Memory/Topics/<Topic>.md
```
# Alex

- Friend from college ➕ 2026-09-26 09:14 ^f1a9z
- Job hunting for PM roles (as of 2026-09) ➕ 2026-09-26 09:20 ^f7k2c
- Staying in Lisbon until mid October ⌛ 2026-10-15 ➕ 2026-09-26 09:31 ^f5r8e
```
Every fact Claudia saves carries ➕ with the local date and time it was saved. Facts written by hand may omit it.
Facts without a person or topic go to `Memory/Profile.md`. A fact whose ⌛ date has passed is **stale**: it stays in the note and is listed in the brief.

### Log/YYYY-MM-DD.md
```
# Log 2026-09-26

- 09:14 · iPhone chat · added [[To do#^t9x2k|Call the dentist to reschedule]] ⏰ Tue 9:00am · "remind me to call the dentist tuesday morning"
- 09:20 · push · completed [[To do#^t9x2k|Call the dentist to reschedule]]
- 11:02 · janitor · merged conflict copy "To do 2.md" into [[To do]] (1 line added, 2 kept from the newer copy)
```
One line per change: local time `HH:mm`, surface, verb, link to the item, optional details, optional quoted source words (newlines collapsed, `"` replaced by `'`, truncated to 200 characters). Verbs: `added`, `completed`, `reopened`, `snoozed`, `rescheduled`, `edited`, `forgot`, `undid`, `added rule`, `removed rule`, `changed setting`, `merged conflict copy`, `archived`, `nudged`. Log lines have no block IDs and are not items. Log notes are append-only.

### Today.md (generated)
```
---
claudia: generated
---
> Claudia rewrites this note. Edit the notes it links to instead.

# Today · Saturday, September 26

## Brief
<Claude's summary from the last notify with today_summary today, or "No brief yet today.">

## Appointments
- 15:00-16:00 [[Appointments#^a3k9p|Dentist cleaning at Main St Dental]]

## Reminders
- 09:00 [[To do#^t9x2k|Call the dentist to reschedule]]

## Due today
## Overdue
## Follow-ups
## Stale facts
```
Empty sections show `- Nothing.`. Rewritten when the index changes (debounced) and at local midnight.

### Recently captured.md (generated)
```
---
claudia: generated
---
> Claudia rewrites this note. Edit the notes it links to instead.

# Recently captured

## Saturday, September 26
- 09:14 · [[To do#^t9x2k|Call the dentist to reschedule]] ⏰ Tue 9:00am · iPhone chat
```
Built from the `added` lines of the last 7 days of Log notes, newest first.

### _claudia/Settings.md
```
---
claudia: settings
---
# Settings

Claudia reads this note. Change a value after the colon and save; delete a line to go back to the default.

- Time zone: America/Los_Angeles
- Brief time: 07:30
- Nudge time: 09:00
- Waiting-on nudge after: 5 days
- Brief fallback after: 90 minutes
```
Keys are matched case-insensitively. Invalid or missing values fall back to the defaults above and the problem is reported by `/health` and the brief.

### _claudia/Rules.md
```
---
claudia: rules
---
# Never-save rules

Claudia refuses to save anything that matches one of these rules. Each rule ends with the keywords Claude chose for it, after 🚫. Edit the keywords or delete a line to change a rule.

- Nothing about my therapy sessions 🚫 therapy, therapist, counseling ^r1a2b
```
A capture item matches a rule when any keyword (case-insensitive, whole words, multi-word phrases allowed) appears in its text, person, topic or title.

## 6. Block ID assignment

Claudia adds a block ID (after the quiet period) to:
- every list item in `Tasks/`, `People/`, `Memory/` and `_claudia/Rules.md` that lacks one;
- every open task line anywhere in the vault that has ⏰.

Nothing else in owner notes is modified.

## 7. Time

- Every date and time in the vault is wall-clock time in the Settings time zone (default America/Los_Angeles). No offsets are stored.
- A local time that does not exist (spring-forward gap) resolves to the first valid instant after the gap (02:30 becomes 03:30). An ambiguous local time (fall-back overlap) resolves to the earlier instant.
- ✅ and ❌ are local dates. ➕ is a local date, or a local date and time (`YYYY-MM-DD HH:mm`) on fact lines. Nudges use only the date part of ➕.

### Reminders
- An open task fires at its **effective reminder**: the later of ⏰ and 💤. Done, cancelled and generated lines never fire.
- A reminder fires once per (block ID, effective time). Editing ⏰ or 💤 in Obsidian reschedules it.

### Repeats
- 🔁 accepts the Obsidian Tasks phrases understood by rrule's text parser: `every day`, `every N days`, `every week`, `every N weeks`, `every week on Monday[, Thursday]`, `every weekday`, `every month`, `every month on the 15th`, `every year`, with an optional ` when done` suffix. An unrecognized rule is preserved and reported as "repeat not understood"; the task does not repeat.
- Completing a repeating task: the line gets `[x]`, `✅ <today>` and loses 💤; a new open line is inserted directly **above** it with the same description, tags and rule, a new block ID, and shifted dates. The anchor is 📅 if present, else the ⏰ date (with `when done`, the anchor is today). The next anchor is the first rule occurrence after the anchor that is not before today. ⏰, 📅, ⏳ and 🛫 all shift by the same number of days; ⏰ keeps its time of day. ➕ is not copied.

### Follow-up nudges
- `#waiting` or `#promised` with 📅: one nudge on that date at the nudge time.
- Without 📅: a nudge when ➕ plus "Waiting-on nudge after" days is reached, at the nudge time, then again every that many days while open.
- A follow-up with ⏰ uses the reminder instead of nudges.

## 8. Appointments and Google Calendar

- Each open appointment line is mirrored to one event on the Claudia calendar. The mapping (block ID to event ID and the last synced title and times) lives in state, not in the vault.
- Changing or deleting the line in Obsidian updates or cancels the event. Completing or archiving does not delete it.
- Default duration is 60 minutes when no end time is given.

## 9. iCloud conflict copies

A file `<name> <N>.md` next to `<name>.md` in the same folder, sharing at least one block ID with it, is a conflict copy. The janitor merges it into `<name>.md` by block ID:
- a line present in both: the done/cancelled version wins over open; otherwise the version from the file with the newer modification time wins;
- a line with a block ID only in the copy is inserted after its nearest preceding neighbor that exists in the original (or appended);
- a line without a block ID that is only in the copy is appended;
then deletes the copy and writes a `merged conflict copy` Log line.

## 10. Writes

- Writes go through one queue per file. Each write re-reads the file, locates lines by block ID, changes only those lines, and replaces the file atomically (temporary file in the same folder, then rename).
- If a file was modified by someone else within the quiet period (default 3 seconds), the write waits for it to go quiet (up to 10 seconds, then proceeds).
- Claudia never deletes owner notes. It deletes a line only for `forget`, `undo`, archive moves and conflict merges.
