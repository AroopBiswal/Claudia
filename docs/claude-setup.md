# Setting up Claudia in Claude

Human steps to wire Claudia into Claude on web/desktop/mobile and into Claude Code. Do these once the server is live at `https://claudia.aroopbiswal.com`. Nothing here is done automatically by the build.

## 1. Add the custom connector

1. Go to **Settings → Connectors → Add custom connector**.
2. Name: `Claudia`. URL: `https://claudia.aroopbiswal.com/mcp`.
3. Click **Add**, then **Connect**. You'll be sent to sign in — enter the one-time code Cloudflare Access emails you.
4. On the approval page, click **Approve**.

## 2. Set Claudia's tools to Always allow

1. Open the Claudia connector's settings (Settings → Connectors → Claudia).
2. For each of the five tools (`capture`, `recall`, `agenda`, `update`, `notify`), set permission to **Always allow**. Claudia is meant to save and check things silently mid-conversation; per-call approval prompts defeat that.

## 3. Check automatic tool loading

1. Start a new chat about something unrelated to personal assistant duties (e.g. ask a general question) and mention something personal in passing ("remind me to call the dentist tomorrow").
2. If Claudia doesn't load (no capture happens, no "Reminder set" line), go to **Settings → Connectors → Claudia** and switch tool access from **Automatic** to **Always available**.

## 4. Upload the plugin

1. Build it locally: `npm run plugin:pack`. This writes `dist/claudia-plugin.zip`.
2. In Claude, go to **Settings → Capabilities** (or wherever plugin upload lives for your account) and upload `dist/claudia-plugin.zip`.
3. Turn on **code execution** — skills require it to load.

## 5. Claude Code install

From a local checkout of this repo:

```
claude plugin install ./plugin
```

or, to run it in place without installing:

```
claude --plugin-dir ./plugin
```

Add the MCP connector to Claude Code directly (in addition to, or instead of, the bundled `.mcp.json` reference):

```
claude mcp add --transport http claudia https://claudia.aroopbiswal.com/mcp
```

Complete the OAuth sign-in the same way as step 1 when prompted.

## 6. Profile preferences line

Add this sentence to your Claude profile preferences (Settings → Profile):

> I use Claudia as my personal assistant: save my commitments, reminders, appointments, people and personal facts to Claudia silently, and check Claudia when my plans, people or schedule come up.

## 7. Create the Claudia project

Create a project named **Claudia**. Set its project instructions to:

> This is assistant mode. At the start of every chat in this project, call Claudia's `agenda` tool with `view: "today"` (or `"brief"` first thing in the morning) before responding, and mention anything time-sensitive. Follow the `claudia` skill's capture rules: silently save tasks, reminders, deadlines, appointments, follow-ups, and facts about me or people in my life; don't save code, general knowledge, one-off lookups, or anything covered by a never-save rule; never save passwords, PINs, or account/card/ID numbers. Give a one-line receipt only when Claudia returns one for a timed reminder. My time zone is Pacific (America/Los_Angeles) unless Claudia's settings say otherwise.

Leave Claude's built-in memory as-is for this project; it doesn't sync with Claudia.

## 8. Cowork scheduled task — morning brief

Create a Cowork scheduled task:

- **Name**: `Claudia morning brief`
- **Schedule**: daily, `07:30`, time zone `America/Los_Angeles`
- **Prompt**:

> Call Claudia's `agenda` tool with `view: "brief"`. Read today's events from Google Calendar. Read Gmail messages labeled "Claudia" (sent to my `+claudia` address); for anything assistant-worthy in them, call Claudia's `capture` tool with `surface: "email"`, then move each handled message from "Claudia" to the "Claudia/Done" label. Write a 2-4 line summary of the day. Call Claudia's `notify` tool with `kind: "brief"`, `priority: "default"`, and `today_summary` set to a fuller Markdown brief (today's appointments and reminders, overdue items, follow-ups needing a nudge, stale facts). Decide whether today is heavy: a deadline due today or tomorrow, travel, something that needs preparation, or more than 8 items on the agenda. Only on a heavy day, also send the full brief by email to my own address with subject "Claudia brief – <date>". Never email anyone else.

## 9. Gmail filter

1. In Gmail, open **Settings → Filters and Blocked Addresses → Create a new filter**.
2. **Matches**: `to:(<your Gmail address with +claudia before the @>)` — for example, if your address is `<your Gmail address>`, use `<name>+claudia@<domain>`.
3. Create the filter with **Apply the label: Claudia** (create the label if it doesn't exist). Optionally check **Skip the Inbox (Archive it)**.
4. Create a second label named **Claudia/Done** (Settings → Labels → Create new label). The morning brief task moves handled messages here after processing.
