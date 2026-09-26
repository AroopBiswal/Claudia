# Human to-do

Steps only you can do: dashboards, your phone, passwords, sudo and account consent. The build did not attempt any of them. Do them in order; each ends with a check.

Paths below assume the defaults: Claudia's home is `~/.claudia`, the vault is `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Claudia`, and the installed CLI is `~/.claudia/runtime/bin/node ~/.claudia/app/current/dist/cli.js`.

## 1. Let the Claudia service read the vault — done

You granted the Claudia runtime (`~/.claudia/runtime/bin/node`) access to the vault on 2026-09-26; `/health` reports `"status":"ok"` and `npm run smoke` passes against the installed service. If Claudia ever reports `"path_ok":false` again (for example after replacing that binary), open System Settings → Privacy & Security → Full Disk Access, make sure **node** at `~/.claudia/runtime/bin/node` is listed and on, then run `launchctl kickstart -k gui/$(id -u)/com.aroop.claudia`.

## 2. Keep the Mac mini awake, restarting and synced

1. In Terminal: `sudo pmset -a sleep 0 disksleep 0 autorestart 1 womp 1`
2. Check: `pmset -g | grep -E " sleep|autorestart|womp"` shows `sleep 0`, `autorestart 1`, `womp 1`.
3. System Settings → your name → iCloud → iCloud Drive → turn **off** "Optimize Mac Storage" (so vault files stay downloaded). It is currently on, and iCloud had already moved two vault notes to the cloud, which the background service cannot download on its own.
4. Stay logged in on the Mac mini. With FileVault on, after a power cut Claudia is down until you log in once (the watchdog in step 5 tells you).
5. Make sure Time Machine is on (System Settings → General → Time Machine). Claudia also keeps nightly vault snapshots in `~/.claudia/backups` for 30 days.
6. Optional: a small UPS for the Mac mini and router.

## 3. Go live on claudia.aroopbiswal.com

Follow `ops/go-live.md` sections 1 to 6. In short:
1. Merge `ops/cloudflared-ingress.yml` into your existing cloudflared config (above the catch-all) and restart cloudflared.
2. `cloudflared tunnel route dns <your tunnel> claudia.aroopbiswal.com` and `cloudflared tunnel route dns <your tunnel> ntfy.aroopbiswal.com`.
3. Cloudflare Zero Trust → Access: self-hosted app for `claudia.aroopbiswal.com`, one-time PIN, Allow only your email, 30-day sessions. Bypass for `/mcp`, `/.well-known/*`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`, `/health`, `/a/*`. Keep `/oauth/authorize` and `/oauth/approve` behind Access.
4. WAF custom rule: Skip bot protection for those machine paths on `claudia.aroopbiswal.com`.
5. Put the Access app's AUD tag, your team domain (`<team>.cloudflareaccess.com`) and your email into `~/.claudia/config.json` (`access.audience`, `access.teamDomain`, `ownerEmail`), then `launchctl kickstart -k gui/$(id -u)/com.aroop.claudia`.
6. Checks: `curl -s https://claudia.aroopbiswal.com/health` → `"status":"ok"`; `curl -si -X POST https://claudia.aroopbiswal.com/mcp | grep -i www-authenticate` → `Bearer resource_metadata=…`; opening `https://claudia.aroopbiswal.com/oauth/authorize` in a browser asks for the email code.

## 4. Deploy the watchdog

Follow `watchdog/README.md`: `wrangler kv namespace create STATE`, put the id in `watchdog/wrangler.toml`, `wrangler secret put ALERT_TOPIC_URL` with a random topic such as `https://ntfy.sh/claudia-watch-<random>`, subscribe to that topic in the ntfy iPhone app (server ntfy.sh), then `wrangler deploy` from `watchdog/`. Check: stop Claudia for 11 minutes (`launchctl bootout gui/$(id -u)/com.aroop.claudia`), you get "Claudia is down"; start it again (`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aroop.claudia.plist`), you get "Claudia is back".

## 5. ntfy on your iPhone

After step 3 (the ntfy hostname must be live):
1. Install **ntfy** from the App Store and allow notifications.
2. Settings → add server `https://ntfy.aroopbiswal.com` as a user login: username `claudia`, password from `cat ~/.claudia/secrets/ntfy-password` (run on the Mac mini; don't paste it anywhere else).
3. Subscribe to the topic in `cat ~/.claudia/ntfy/topic` on server `https://ntfy.aroopbiswal.com`.
4. Check: `curl -s -H "Authorization: Bearer $(cat ~/.claudia/secrets/ntfy-token)" -d "Claudia test" http://127.0.0.1:8790/$(cat ~/.claudia/ntfy/topic)` pops up on the phone.

## 6. Google Calendar (appointments)

1. console.cloud.google.com → create a project named `Claudia`.
2. APIs & Services → Library → enable **Google Calendar API**.
3. OAuth consent screen: External, app name `Claudia`, your email as support and developer contact; add the scope `https://www.googleapis.com/auth/calendar.app.created`; add yourself as a test user; then set Publishing status to **In production** (in Testing, Google expires refresh tokens after 7 days; you'll see an "unverified app" screen when you consent, which is expected for a personal app).
4. Credentials → Create credentials → OAuth client ID → Application type **Desktop app** → Download JSON.
5. Save it as `~/.claudia/secrets/google-oauth-client.json` and run `chmod 600 ~/.claudia/secrets/google-oauth-client.json`.
6. Run `~/.claudia/runtime/bin/node ~/.claudia/app/current/dist/cli.js calendar-auth`, approve in the browser that opens.
7. `launchctl kickstart -k gui/$(id -u)/com.aroop.claudia`
8. Check: `curl -s http://127.0.0.1:8787/health` shows `"calendar":{"configured":true}`; after your next appointment capture, a "Claudia" calendar with the event appears in Google Calendar.

## 7. Claude setup

Follow `docs/claude-setup.md` sections 1 to 8:
1. Add the custom connector `https://claudia.aroopbiswal.com/mcp` on web or desktop; sign in with the email code; click Approve.
2. Set all five Claudia tools to **Always allow**.
3. Check automatic tool loading in an unrelated chat; if Claudia doesn't load, switch it to **Always available**.
4. `npm run plugin:pack` and upload `dist/claudia-plugin.zip`; turn on **code execution**.
5. Claude Code: install the plugin from `plugin/` and add the connector (commands in the doc).
6. Add the profile preferences line from the doc.
7. Create the **Claudia** project with the instructions in the doc.
8. Create the **Claudia morning brief** Cowork scheduled task, daily 07:30 America/Los_Angeles, with the prompt in the doc.

## 8. Gmail label for the brief

Follow `docs/claude-setup.md` section 9: a filter for mail sent to your address with `+claudia` before the @ that applies the label **Claudia**, plus a second label **Claudia/Done**.

## 9. Obsidian on your iPhone

1. Install **Obsidian** and make sure iCloud Drive is on for it (Settings → your name → iCloud → iCloud Drive → Obsidian).
2. In Obsidian, open the existing vault **Claudia** from iCloud.
3. Check: `Tasks/To do.md` and `_claudia/README.md` are there.

## 10. Prove it end to end (Phase 0 and Phase 1 acceptance)

1. On web, desktop, iPhone, voice mode, a Cowork scheduled task and Claude Code, say "Claudia, ping me" → a push arrives (Phase 0 done-when).
2. Check the push buttons on the iPhone: Done completes the task in Obsidian, +1 hour and Tomorrow snooze it.
3. Use Claudia daily for two weeks without a missed reminder (Phase 1 done-when).
4. After any change to `plugin/skills/claudia/SKILL.md`, rerun the capture eval (`npm run eval`; see tests/eval/README.md). It uses your Claude plan.
