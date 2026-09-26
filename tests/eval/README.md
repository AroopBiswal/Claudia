# Capture eval

A test set, scorer and runner for Claudia's capture skill: does the `claudia` plugin skill call
`capture` (and `update`/`recall`/`agenda`) correctly on realistic chat messages, and does it
correctly *not* call it on messages that aren't assistant material? The runner drives headless
Claude Code against its own scratch Claudia instance per case; nothing here ever touches the real
vault or the real `~/.claudia`.

## Files

- `cases.json` — ~40-45 synthetic `EvalCase` records (see `types.ts`).
- `types.ts` — shared types: `EvalCase`, `ExpectedItem`, `SavedItem`, `CaseRun`.
- `score.ts` — pure scoring functions: `scoreCase`, `scoreAll`, `formatReport`.
- `instance.ts` — `startEvalInstance(evalCase)`: a temp `CLAUDIA_HOME` + temp seeded vault, a real
  HTTP `startService` on an OS-assigned port, an MCP access token minted through the real OAuth
  store (`src/auth/store.ts`, no bypass), and `savedItems()`/`rulesAdded()` to read back what a
  case saved.
- `run.ts` — the CLI (`npm run eval`): for each selected case, starts an instance, writes a
  per-case `--mcp-config` file, runs headless Claude Code against it, scores the result, and
  prints/writes a report. See "Running the eval" below.
- `tests/unit/eval/score.test.ts` — unit tests for the scorer and structural validation of
  `cases.json`.
- `tests/unit/eval/instance.test.ts`, `tests/unit/eval/run.test.ts` — unit tests for the instance
  wiring (via a real local MCP client, no Claude Code) and for `run.ts`'s CLI parsing, MCP config
  shape/redaction and resolver wiring. No network beyond loopback, no AI API calls.

`cases.json` and `score.ts` are excluded from `vitest`'s normal include path when run as an eval
(see `vitest.config.ts`'s `tests/eval/**` exclude) but are `import`ed directly by the unit tests
above, which vitest does run. `run.ts` and `instance.ts` are only ever invoked directly (`npm run
eval`, or imported by their unit tests) — never by the vitest suite itself, since a real run costs
real model calls.

## How the runner works

Each `EvalCase` runs against its own scratch Claudia instance (temp vault, temp `CLAUDIA_HOME`,
the real clock, no ntfy, no calendar):

1. Seed the scratch vault (`seedVault`) and write `case.setup.rules` (if any) straight into
   `_claudia/Rules.md`, in the exact format `update`'s `add_rule` action produces
   (`- <text> 🚫 kw1, kw2 ^rXXXX`), *before* the service starts, so never-save rules are already in
   effect when the message is sent.
2. Run headless Claude Code with the plugin skill loaded and only the Claudia MCP tools allowed
   (the exact command `run.ts` uses, from docs/KICKOFF.md):
   ```
   claude -p "<message>" --model claude-sonnet-5 --permission-mode dontAsk \
     --strict-mcp-config --mcp-config <per-case mcp.json> --allowedTools "mcp__claudia-eval__*" \
     --append-system-prompt-file plugin/skills/claudia/SKILL.md \
     --append-system-prompt "Surface: Claude Code. Today is <weekday>, <date> and the time is \
     <HH:mm> in America/Los_Angeles." \
     --disable-slash-commands --no-session-persistence --output-format json
   ```
   The message is passed verbatim; the surface/date/time line is a *separate*
   `--append-system-prompt` (confirmed combinable with `--append-system-prompt-file` in the same
   invocation), since `--disable-slash-commands` means Claude Code never adds its own dynamic
   date/cwd system-prompt sections. `cwd` is a fresh empty temp directory, so no project CLAUDE.md
   applies. The process is killed after 180s if it hasn't exited.
3. Read back everything the case's `capture`/`update` calls actually wrote, straight from the
   scratch vault's index, into a `CaseRun`: the saved items (`SavedItem[]`), how many rules were
   added, and `startedAt` (the real `now` the case started against). A missing/erroring `claude`
   binary, a non-zero exit, or a timeout becomes `CaseRun.error` instead of a crash or a hang.
4. Feed `cases.json` and the `CaseRun[]` to `scoreAll` from `score.ts`, with a `ScoreOptions` whose
   `resolveTime`/`resolveDate` are the *real* `src/time/expressions.ts` resolvers, so the eval
   checks the skill against the same time math the server uses. Print `formatReport(report)` and
   write `report.json`/`report.txt` to `tests/eval/results/<runId>/`.

## Scoring definitions

- **Matching**: saved items are greedily matched one-to-one to a case's expected items, by kind.
  A `task` never matches a `follow_up` expectation or vice versa, even if the text matches —
  that confusion is scored as a mismatch (a missing expected item plus an extra, unmatched save),
  not a match. A `fact` expectation matches a saved fact if either its `person` matches or its
  `match` words are found in the saved text.
- **Matched but not correct**: a matched saved item must also satisfy every attribute the
  expected item names (`person`, `direction`, `due`, `appointmentStart`, `repeat`) to count toward
  precision. A matched item with a wrong attribute (e.g. `promised` saved as `waiting`) is
  reported as a problem and does not count as a correct save, but it does still count toward
  recall (it *was* found).
- **Reminder time is scored separately.** A matched item with the wrong `⏰` still counts as a
  correct save for precision purposes; the reminder itself is tracked in `reminderExpected` /
  `reminderCorrect` and rolled into `reminderAccuracy`, over matched items that expected a
  `remind` only. A matched item that expected a reminder but has none at all (`reminderLocal:
  null`) counts as `reminderExpected` but not `reminderCorrect`, and is called out in `problems`
  as a missing reminder, distinct from a merely wrong one.
- **Tolerance**: absolute reminder forms (`tuesday 09:00`, `tomorrow 18:00`, …) must match exactly
  (0 minutes) unless the case overrides `remindToleranceMin`. Relative forms (`+20m`, `+2h`)
  default to a 3-minute tolerance, since a real run has dispatch latency between "now" and the
  `capture` call.
- **Forbidden words**: `forbid` lists words that must never appear in *any* saved item's text,
  person, or people for that case (checked case-insensitively), independent of matching — this
  catches sensitive-data or never-save-rule leaks even when nothing was expected to be saved at
  all.
- **Recall** = matched / expected, summed over every case (`totals.matched / totals.expected`).
- **Precision** = correct / saved, summed over every case (`totals.correctSaves / totals.saved`);
  defined as 1 when nothing was saved anywhere, so an eval run with zero false positives and zero
  expected saves doesn't get penalized.
- **Reminder accuracy** = correct / expected reminders, over matched items only
  (`totals.reminderCorrect / totals.reminderExpected`); defined as 1 when no case expected a
  reminder.
- **Case errors**: if `CaseRun.error` is set (the harness itself failed — MCP timeout, crashed
  session, etc.), every expected item in that case counts as missed for recall. Any items it did
  manage to save are still scored for precision and forbidden words, since a broken harness run
  that also leaked something sensitive is still worth reporting.
- **Targets** (from docs/KICKOFF.md and docs/PLAN.md): recall ≥ 90%, precision ≥ 95%, reminder
  accuracy exactly 100%. `Report.passed` also requires zero forbidden-word violations across the
  whole run — a leaked rule or sensitive value fails the eval even if the recall/precision/
  reminder numbers are otherwise green.

## Time expressions and avoiding flaky cases

Every `remind` / `due` / `appointmentStart` in `cases.json` is a time or date expression from
docs/tools.md, resolved **relative to `now` at the moment the case starts** (`CaseRun.startedAt`),
not a fixed calendar date baked into the file. That makes most forms safe to run at any time of
day: `<weekday> HH:mm` always means "the next such weekday strictly after today" by spec, so it's
deterministic no matter when the eval runs, including on that weekday itself (it rolls to next
week, not today).

The one genuinely flaky shape is a *vague* time-of-day phrase (the skill's own defaults: morning
09:00, afternoon 14:00, evening 18:00, tonight 20:00, end of day 17:00) anchored to **today**.
"Remind me this evening" run at 9pm has almost certainly already passed 18:00, so a reasonable
skill implementation might reasonably resolve it to tomorrow evening instead, or Claude might
just say the time doesn't make sense — either way, a case that hard-codes `remind: "today
18:00"` would flip between passing and failing depending on the wall-clock time the eval happens
to run at, with no bug involved. Every vague-time case in `cases.json` sidesteps this by phrasing
the message as "tomorrow morning" / "tomorrow afternoon" / "tomorrow evening" / "by end of day
tomorrow", so the expected time is always at least several hours in the future no matter when the
case runs, even a minute before midnight. Do the same for any new vague-time case: anchor it to
`tomorrow`, not `today`.

## Running the eval

```
npm run eval -- --ids personal-01,appt-01           # a couple of specific cases
npm run eval -- --category rule                     # every case in one category
npm run eval -- --limit 5                            # the first 5 selected cases
npm run eval -- --concurrency 2 --model claude-sonnet-5   # override defaults (3, claude-sonnet-5)
npm run eval                                          # the full set -- see the cost note below
```

`--ids` takes priority over `--category` if both are given; `--limit` applies after either filter.
Each run writes `tests/eval/results/<runId>/` (gitignored): a redacted `.log` and a structured
`.json` per case (saved items, exit code, the parsed `claude --output-format json` result), plus
`report.json`/`report.txt`. The per-case `--mcp-config` file is written with the bearer token and
mode `0600`, and deleted again once that case finishes; the token is never written to a `.log` or
`.json` file (see `redactToken` in `run.ts`). Exit code is 0 when the report's own recall/
precision/reminder-accuracy/forbidden-word numbers pass, 1 otherwise — a subset run passes or
fails on its own numbers, independent of the full set.

Without running `claude` at all, sanity-check the scorer, the instance wiring and the CLI itself
with:

```
npm run test:unit -- tests/unit/eval
```

## Cost note

Full eval runs (docs/KICKOFF.md, "Testing bar") drive headless Claude Code once per case on the
owner's Claude plan — that's ~40-45 real model calls per run. Run the full set sparingly (after a
skill change, before a milestone is called done), and iterate on a small subset (`--ids`,
`--category`, `--limit`) while developing.
