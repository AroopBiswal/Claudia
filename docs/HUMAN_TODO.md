# Human to-do

Steps only you can do (dashboards, phone, passwords, sudo, account consent). Nothing here has been attempted by the build. Do them in order; each says how to check it worked.

## 1. Let the Claudia service read the vault (blocks the installed service)

macOS blocks background (launchd) programs from iCloud Drive until you allow them. Claudia's service runs on its own Node binary so the permission sticks across upgrades.

1. Open System Settings → Privacy & Security → Full Disk Access.
2. Click **+**, enter your password, press ⌘⇧G, paste `~/.claudia/runtime/bin/node`, press Return, then **Open**.
3. Make sure the new **node** entry is switched on.
4. Restart the service: `launchctl kickstart -k gui/$(id -u)/com.aroop.claudia`
5. Check: `curl -s http://127.0.0.1:8787/health` shows `"status":"ok"` and `"path_ok":true`.
