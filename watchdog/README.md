# Claudia watchdog

A small Cloudflare Worker that keeps an eye on the Claudia server from
outside the Mac mini. Since Claudia, the alert channel and everything else
in `docs/PLAN.md` runs on the mini itself, they can't tell you the mini is
down — this Worker runs on Cloudflare's network instead.

## What it does

- On a cron trigger every 5 minutes (`*/5 * * * *`), it sends a `GET` request
  (no credentials) to `HEALTH_URL` with a 10s timeout.
- A check is **healthy** when the response is HTTP 200 within the timeout and
  its JSON body has `status: "ok"` or `status: "degraded"`. Anything else
  (timeout, non-200, bad JSON, `status: "down"`, or any other value) counts
  as a **failure**.
- State is kept in a Workers KV namespace (binding `STATE`, key `state`):
  `{ consecutiveFailures, down, since, lastCheck, lastError }`.
- After **two consecutive failures**, if it isn't already marked down, it
  posts a high-priority "Claudia is down" alert and sets `down = true`. It
  does not alert again on further failures while still down.
- On the **first healthy check while down**, it posts a "Claudia is back"
  recovery alert (default priority) and resets the state.
- Alerts are plain HTTP POSTs to `ALERT_TOPIC_URL` (an ntfy.sh topic), with
  the message in the body and `Title` / `Priority` / `Tags` headers. A
  failure to deliver the alert itself is recorded but never throws or blocks
  the check.
- `fetch()` just returns a 200 with a static body, so hitting the Worker's
  own URL in a browser confirms it's deployed; all real work happens in
  `scheduled()`.

This Worker is **not deployed** as part of the repo — see "Go-live" below.

## Files

- `src/check.ts` — `runCheck()`, the pure(ish) check-and-alert logic, plus
  the small local types (`KVLike`, `WatchdogState`) it needs. No Cloudflare
  or Node dependency: everything is injected (`fetch`, `kv`, `now`,
  `healthUrl`, `alertTopicUrl`), so it's fully unit-testable with fakes.
- `src/index.ts` — the Worker entry point: `scheduled()` wires real `env` and
  `fetch` into `runCheck()` via `ctx.waitUntil()`, and a trivial `fetch()`
  handler.
- `wrangler.toml` — Worker config: name, cron trigger, the `HEALTH_URL` var,
  and the `STATE` KV namespace binding (placeholder id, filled in at
  go-live).

## Human go-live step

This Worker is intentionally left undeployed — deploying it means talking to
a real Cloudflare account, which is a human step per `CLAUDE.md`. To go
live:

1. **Create the KV namespace** (from the `watchdog/` directory):
   ```
   wrangler kv namespace create STATE
   ```
   This prints a namespace `id`.

2. **Put that id in `wrangler.toml`**, replacing `REPLACE_WITH_KV_NAMESPACE_ID`
   under `[[kv_namespaces]]`.

3. **Pick a private ntfy topic and set it as a secret** (never in git):
   ```
   wrangler secret put ALERT_TOPIC_URL
   ```
   When prompted, enter a hard-to-guess public ntfy.sh topic URL, e.g.
   `https://ntfy.sh/claudia-watch-<random-string>`. Anyone who knows the
   exact topic name can read it, so keep the random suffix private.

4. **Subscribe to that topic on your phone**: install the ntfy app, add a
   subscription for `claudia-watch-<random-string>` on server `ntfy.sh` (not
   the self-hosted instance — this alert channel needs to work even when the
   Mac mini, and therefore the self-hosted ntfy, is down).

5. **Deploy the Worker**:
   ```
   wrangler deploy
   ```

After that, Cloudflare's dashboard for the Worker will show cron run history
and any errors.
