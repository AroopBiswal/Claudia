# Capture eval

A test set and scorer for Claudia's capture skill: does the `claudia` plugin skill call `capture`
(and `update`/`recall`/`agenda`) correctly on realistic chat messages, and does it correctly
*not* call it on messages that aren't assistant material? This directory owns the test set and
the scorer. The runner that drives headless Claude Code against a scratch Claudia instance is
built later, once the MCP server exists (see docs/ROADMAP.md, task E2).

## Files

- `cases.json` — ~40-45 synthetic `EvalCase` records (see `types.ts`).
- `types.ts` — shared types: `EvalCase`, `ExpectedItem`, `SavedItem`, `CaseRun`.
- `score.ts` — pure scoring functions: `scoreCase`, `scoreAll`, `formatReport`.
- `tests/unit/eval/score.test.ts` — unit tests for the scorer and structural validation of
  `cases.json` (owned by test-engineer alongside this directory).

Nothing in this directory calls a network or an AI API; `score.ts` is pure functions over data
you hand it. `cases.json` and `score.ts` are excluded from `vitest`'s normal include path when run
as an eval (see `vitest.config.ts`'s `tests/eval/**` exclude) but are `import`ed directly by
`tests/unit/eval/score.test.ts`, which vitest does run.

## How the eventual runner will work

Each `EvalCase` runs against its own scratch Claudia instance (temp vault, temp `~/.claudia`,
fake clock pinned to a known `now`, local ntfy stub, no calendar):

1. Seed the scratch vault. Apply `case.setup.rules` (if any) via `update` with `action: "add_rule"`
   so never-save rules are in effect before the message is sent.
2. Run headless Claude Code with the plugin skill loaded and only the Claudia MCP tools allowed,
   for example (from docs/KICKOFF.md):
   ```
   claude -p "<message>" --model claude-sonnet-5 --permission-mode dontAsk \
     --mcp-config tests/eval/mcp.json --allowedTools "mcp__claudia-eval__*" \
     --append-system-prompt-file plugin/skills/claudia/SKILL.md
   ```
3. Read back everything the case's `capture`/`update` calls actually wrote (via `recall`/`agenda`,
   or directly from the scratch vault) into a `CaseRun`: the saved items (`SavedItem[]`), how many
   rules were added, and `startedAt` (the fake `now` the case ran against). A thrown exception,
   timeout, or MCP-level error becomes `CaseRun.error` instead of a crash.
4. Feed `cases.json` and the `CaseRun[]` to `scoreAll` from `score.ts`, with a `ScoreOptions` whose
   `resolveTime`/`resolveDate` are the *real* `src/time/expressions.ts` resolvers (once they
   exist), so the eval checks the skill against the same time math the server uses. Print
   `formatReport(report)`.

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

## Running subsets

Once the runner exists, prefer iterating on a handful of cases while developing the skill rather
than a full run — see the cost note below. A runner should support filtering `cases.json` by
`id` or `category` (e.g. only `category: "rule"` cases while debugging never-save rules) and
re-scoring just that subset with `scoreAll`.

Today, without the runner, you can sanity-check the scorer itself and validate `cases.json`'s
structure with:

```
npm run test:unit -- tests/unit/eval/score.test.ts
```

## Cost note

Full eval runs (docs/KICKOFF.md, "Testing bar") drive headless Claude Code once per case on the
owner's Claude plan — that's ~40-45 real model calls per run. Run the full set sparingly (after a
skill change, before a milestone is called done), and iterate on a small subset while developing.
