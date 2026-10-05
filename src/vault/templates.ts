export const GENERATED_HEADER =
  '---\nclaudia: generated\n---\n> Claudia rewrites this note. Edit the notes it links to instead.\n';

export function personNote(name: string): string {
  return `# ${name}\n\n`;
}

export function topicNote(topic: string): string {
  return `# ${topic}\n\n`;
}

export function logNote(date: string): string {
  return `# Log ${date}\n\n`;
}

export function doneNote(yyyyMm: string): string {
  return `# Done ${yyyyMm}\n\n`;
}

const SETTINGS_MD = [
  '---',
  'claudia: settings',
  '---',
  '# Settings',
  '',
  'Claudia reads this note. Change a value after the colon and save; delete a line to go back to the default.',
  '',
  '- Time zone: America/Los_Angeles',
  '- Brief time: 07:30',
  '- Nudge time: 09:00',
  '- Waiting-on nudge after: 5 days',
  '- Brief fallback after: 90 minutes',
  '',
].join('\n');

const RULES_MD = [
  '---',
  'claudia: rules',
  '---',
  '# Never-save rules',
  '',
  'Claudia refuses to save anything that matches one of these rules. Each rule ends with the keywords Claude chose for it, after 🚫. Edit the keywords or delete a line to change a rule.',
  '',
].join('\n');

const README_MD = [
  '---',
  'claudia: readme',
  '---',
  '# How this vault works',
  '',
  "Claudia is your assistant's memory: plain Markdown notes it reads and writes so you can",
  'see, search and edit everything it knows. Claudia writes this note once and never rewrites',
  "it, so it's safe to leave your own notes elsewhere in the vault.",
  '',
  '## Folders and notes',
  '',
  "- **Today.md** — today's brief, appointments, reminders, things due, overdue items,",
  "  follow-ups and stale facts. Rewritten through the day; don't edit it by hand.",
  '- **Recently captured.md** — the last 7 days of things Claudia saved, newest first. Also',
  '  rewritten, not for editing.',
  '- **Tasks/To do.md** — tasks and reminders.',
  "- **Tasks/Follow-ups.md** — things you're waiting on, or promised to someone.",
  '- **Tasks/Appointments.md** — appointments, mirrored to your Claudia Google calendar.',
  '- **Tasks/Done/YYYY-MM.md** — completed and cancelled items, archived by the month they',
  '  finished.',
  '- **People/<Name>.md** — one note per person, with facts saved about them.',
  "- **Memory/Profile.md** — core facts about you that aren't tied to one topic.",
  '- **Memory/Topics/<Topic>.md** — facts grouped by area of life, like Travel or Health.',
  '- **Log/YYYY-MM-DD.md** — one line per change Claudia makes. Logs are never edited or',
  '  trimmed.',
  '- **_claudia/** — this README, plus Settings.md and Rules.md below.',
  '',
  '## Reading a line',
  '',
  'A typical line looks like this:',
  '```',
  '- [ ] Call the dentist to reschedule ⏰ 2026-09-29 09:00 ^t9x2k',
  '```',
  '`[ ]` is open, `[x]` is done. The emoji fields carry the details:',
  '',
  '- ⏰ reminder time',
  '- 💤 snoozed until',
  '- 🗓️ appointment date and time',
  '- 🔁 how it repeats',
  '- 📅 due date',
  '- ✅ date completed',
  '- ➕ date created (facts carry the date and time Claudia saved them)',
  '- ⌛ when a fact expires',
  '- 🚫 keywords for a never-save rule (Rules.md only)',
  '',
  'The short code at the end, like `^t9x2k`, is a block ID. Claudia uses it to find and',
  'update that exact line later, so please leave it alone — editing the text around it is',
  "fine, deleting the ID isn't.",
  '',
  '## Adding a reminder by hand',
  '',
  "You don't need Claude for this. Add a line to **Tasks/To do.md** yourself:",
  '```',
  '- [ ] Water plants ⏰ 2026-10-01 18:00',
  '```',
  'Claudia notices it next time it scans the vault, sends you a push at that time, and adds',
  'a block ID to the line so it can keep track of it.',
  '',
  '## Settings and rules',
  '',
  '- **_claudia/Settings.md** holds your time zone, brief time, nudge time and a couple of',
  '  timing defaults. Change a value after the colon and save; delete a line to fall back',
  '  to the default.',
  "- **_claudia/Rules.md** holds things you've told Claudia never to save, each with the",
  '  keywords it matches on after 🚫. Edit the keywords or delete a line to change or',
  '  remove a rule.',
  '',
  '## A few promises',
  '',
  '- Claudia never deletes a note. It only deletes a line for a forget, an undo, an',
  '  archive move, or a sync-conflict merge.',
  "- Every change Claudia makes is written to today's Log note, so you can always see what",
  '  happened and when.',
  '- Today.md and Recently captured.md say up top that Claudia rewrites them; every other',
  '  note here is yours to edit, and Claudia only touches the specific lines it owns.',
  '',
].join('\n');

export const SEED_FOLDERS: readonly string[] = [
  'Tasks',
  'Tasks/Done',
  'People',
  'Memory',
  'Memory/Topics',
  'Log',
  '_claudia',
];

export const SEED_NOTES: ReadonlyArray<{ path: string; content: string }> = [
  { path: '_claudia/README.md', content: README_MD },
  { path: '_claudia/Settings.md', content: SETTINGS_MD },
  { path: '_claudia/Rules.md', content: RULES_MD },
  { path: 'Tasks/To do.md', content: '# To do\n\n' },
  { path: 'Tasks/Follow-ups.md', content: '# Follow-ups\n\n' },
  { path: 'Tasks/Appointments.md', content: '# Appointments\n\n' },
  { path: 'Memory/Profile.md', content: '# Profile\n\n' },
];
