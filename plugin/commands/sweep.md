---
description: Review this conversation for personal items Claudia missed and capture them.
---

Review the whole conversation so far for personal items that should have been saved to Claudia but weren't, following the `claudia` skill's save/don't-save rules exactly (tasks, reminders, deadlines, appointments, follow-ups, facts about people or the user; skip code, general knowledge, one-off lookups, transient states, and anything already saved or covered by a never-save rule).

For anything missed, call `capture` with `surface` set to the current surface and `source_words` drawn from the user's original message, one call for all the missed items. Check `recall` first if unsure whether something is already saved, to avoid duplicates.

Then reply with a single short line: either a compact list of what you saved (e.g. "Saved: dentist reminder Tue 9am; Alex follow-up.") or, if nothing was missed, exactly "Nothing new to save."
