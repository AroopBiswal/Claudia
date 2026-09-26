# Go-live runbook

This is a human runbook. Nothing here is run by any script in this repo —
it touches Cloudflare account settings, DNS and the existing cloudflared
service on this Mac mini, all of which are out of bounds for automation
(see CLAUDE.md's hard rules and docs/KICKOFF.md's guardrails). Do these
steps in order, on this Mac mini, after `ops/install.sh` has finished and
`curl -s http://127.0.0.1:8787/health` looks healthy locally.

## 1. Merge the ingress snippet and restart cloudflared

Claudia's existing tunnel already serves other hostnames (Bull, Bear); do
not disturb those entries or start a second tunnel.

1. Open the existing cloudflared config (wherever the running tunnel's
   `config.yml` lives on this machine — do not create a new one).
2. Merge `ops/cloudflared-ingress.yml` by hand: copy its two `hostname:`
   blocks into the existing `ingress:` list, above the catch-all rule
   (`- service: http_status:404` or similar), leaving every other hostname
   entry exactly as it is. See the comments in that file for the exact
   before/after shape.
3. Restart the existing cloudflared service so it picks up the new
   ingress rules, e.g. `sudo launchctl kickstart -k system/com.cloudflare.cloudflared`
   (use whatever command already restarts this Mac's cloudflared service —
   do not run `cloudflared tunnel run` by hand as a new process).
4. Check: `cloudflared tunnel ingress validate` (or equivalent) reports the
   config valid, and Bull/Bear are still reachable.

## 2. Route DNS for the two new hostnames

```
cloudflared tunnel route dns <tunnel> claudia.aroopbiswal.com
cloudflared tunnel route dns <tunnel> ntfy.aroopbiswal.com
```

Replace `<tunnel>` with the existing tunnel's name or ID (the same one
Bull/Bear already use). This only adds two new DNS records; it does not
touch any existing route.

## 3. Cloudflare Zero Trust Access application for claudia.aroopbiswal.com

1. In the Cloudflare Zero Trust dashboard, create a **Self-hosted**
   Access application for the hostname `claudia.aroopbiswal.com`.
2. Login method: **One-time PIN** (email code).
3. Policy: **Allow**, "Emails" = the owner's email address only (the same
   address that will go into `ownerEmail` below). No other identities.
4. Session duration: **30 days**.
5. Add **Bypass** policies (either on this same Access app, per path, or a
   second Access application scoped to these paths with a Bypass policy)
   for exactly these paths, so the MCP connector and the signed push
   actions never see an HTML login page:
   - `/mcp`
   - `/.well-known/*`
   - `/oauth/token`
   - `/oauth/register`
   - `/oauth/revoke`
   - `/health`
   - `/a/*`
6. Leave `/oauth/authorize` and `/oauth/approve` **behind** Access (no
   bypass) — the connector's approval page relies on Access's one-time-PIN
   login to prove who's approving it (docs/DECISIONS.md B9).
7. Copy the new application's **Audience (AUD) tag** and this Cloudflare
   account's **team domain** (`https://<team>.cloudflareaccess.com`).
8. Edit `~/.claudia/config.json` on this Mac mini and set:
   - `access.audience` = the AUD tag from step 7
   - `access.teamDomain` = the team domain from step 7
   - `ownerEmail` = the same email address used in the Allow policy
9. Restart Claudia so it picks up the new config:
   ```
   launchctl kickstart -k gui/$(id -u)/com.aroop.claudia
   ```

## 4. WAF: skip bot checks for the machine paths

Bot Fight Mode / Super Bot Fight Mode / managed challenges will otherwise
block the MCP connector and the signed push actions, which don't behave
like a browser. Add a WAF custom rule:

- **When**: hostname equals `claudia.aroopbiswal.com` AND URI path is one
  of `/mcp`, `/.well-known/*`, `/oauth/token`, `/oauth/register`,
  `/oauth/revoke`, `/health`, `/a/*`
- **Then**: **Skip** → Bot Fight Mode, Super Bot Fight Mode, and managed
  challenges (skip all of the bot-related checks for this rule's matches).

## 5. ntfy gets no Access app

`ntfy.aroopbiswal.com` is **not** put behind Cloudflare Access. ntfy has
its own login (the `claudia` user provisioned by `ops/ntfy-setup.sh`) and
its server config already defaults to deny-all access
(`auth-default-access: "deny-all"`), so an anonymous visitor gets nothing
without that user's credentials.

## 6. Checks

```
curl https://claudia.aroopbiswal.com/health
# -> 200, {"status":"ok", ...}

curl -i -X POST https://claudia.aroopbiswal.com/mcp
# -> 401, with a WWW-Authenticate: Bearer resource_metadata="..." header

curl https://claudia.aroopbiswal.com/.well-known/oauth-protected-resource/mcp
# -> 200, JSON metadata with "resource": "https://claudia.aroopbiswal.com/mcp"
```

Then, in a browser, visit `https://claudia.aroopbiswal.com/oauth/authorize`
(with any query string a client would send) and confirm it asks for the
owner's email one-time code before showing the connector approval page.

## 7. Deploy the watchdog

Follow `watchdog/README.md` to deploy the Cloudflare Worker that polls
`/health` every 5 minutes and alerts (via a public ntfy.sh topic) after two
consecutive failures, and on recovery.

## 8. Add the ntfy iPhone app

1. Install the ntfy app from the App Store.
2. Add server: `https://ntfy.aroopbiswal.com`
3. Username: `claudia`
4. Password: run `cat ~/.claudia/secrets/ntfy-password` **on this Mac
   mini** and type it into the phone by hand (or use another local,
   private transfer). Never paste it into a chat, ticket or file that
   leaves this machine.
5. Subscribe to the topic in `cat ~/.claudia/ntfy/topic` (again, read it
   locally on this Mac mini).

## 9. Claude-side setup

Once the connector is reachable and Access is configured, follow
`docs/claude-setup.md` (project instructions, profile preference line, the
Cowork scheduled brief task, uploading the plugin, and the Gmail filter).

## Rollback

To take Claudia back offline without losing any data:

1. Remove the two `hostname:` entries this runbook added from the
   cloudflared config, and restart cloudflared (step 1's restart command).
2. Delete the `claudia.aroopbiswal.com` and `ntfy.aroopbiswal.com` DNS
   routes (`cloudflared tunnel route dns` has no built-in "unroute"; delete
   the CNAME records for those hostnames in the Cloudflare DNS dashboard
   instead).
3. Delete (or disable) the Access application and its Bypass policies from
   step 3.
4. Delete the WAF custom rule from step 4.
5. Optionally stop the local services: `ops/uninstall.sh` (leaves
   `~/.claudia` and the vault untouched; nothing here deletes your data).

This only removes public exposure and Cloudflare-side config; the vault,
`~/.claudia` state and secrets are never touched by go-live or its
rollback.
