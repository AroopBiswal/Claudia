# Claudia

I built Claudia so the important things from my Claude chats get saved to Obsidian, where I can see them and Claude can look them up later. I just talk to Claude the way I normally do, and Claudia picks out what's worth keeping, like plans, reminders, appointments, people and facts about me, and writes them into my notes. When something's due, it sends a reminder to my phone.

## Set it up for yourself

Claudia is set up for my own Mac mini, so a few steps involve swapping in your own details.

### What you need

- A Mac that stays on (it runs the server)
- Obsidian, with a vault named **Claudia** saved in iCloud Drive
- A domain on Cloudflare (free plan is fine)
- A Claude plan that supports custom connectors and plugins
- The **ntfy** app on your phone

### 1. Get the code

```bash
git clone https://github.com/AroopBiswal/Claudia.git
cd Claudia
npm install
```

### 2. Swap in your own details

Replace my domain `aroopbiswal.com` with yours, and my name prefix `com.aroop` with your own, everywhere they appear:

```bash
git grep -l "aroopbiswal.com\|com.aroop"
```

### 3. Install it

```bash
OWNER_EMAIL=you@example.com bash ops/install.sh
```

This installs Claudia and the notification server as background services, and adds the starter folders and notes to your vault.

### 4. Let it read your vault

macOS blocks background apps from iCloud until you allow them. Open **System Settings → Privacy & Security → Full Disk Access**, click **+**, press ⌘⇧G, and add `~/.claudia/runtime/bin/node`. Then restart Claudia:

```bash
launchctl kickstart -k gui/$(id -u)/com.aroop.claudia
```

### 5. Put it online

```bash
bash ops/tunnel-setup.sh
```

Run the two DNS commands it prints. Then, in the Cloudflare dashboard, add an email sign-in (Cloudflare Access) in front of your Claudia address. The exact settings are in [ops/go-live.md](ops/go-live.md).

### 6. Get notifications on your phone

In the ntfy app, sign in to `https://ntfy.<your domain>` with username `claudia` and the password from `cat ~/.claudia/secrets/ntfy-password`. Then subscribe to the topic in `cat ~/.claudia/ntfy/topic`.

### 7. Connect Claude

1. In Claude, go to **Settings → Connectors → Add custom connector** and enter `https://claudia.<your domain>/mcp`.
2. Sign in, click **Approve**, and set Claudia's tools to **Always allow**.
3. Run `npm run plugin:pack` and upload `dist/claudia-plugin.zip` in Claude's plugin settings.

More detail is in [docs/claude-setup.md](docs/claude-setup.md).

### 8. Check that it works

```bash
npm run smoke
```

Then tell Claude "remind me to test Claudia in 5 minutes". You should see "Reminder set" and get a notification on your phone.

### Optional: Google Calendar

To have appointments show up on a Claudia calendar, follow step 6 in [docs/HUMAN_TODO.md](docs/HUMAN_TODO.md).

## License

MIT. Claudia is my own project and isn't affiliated with Anthropic.
