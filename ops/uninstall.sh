#!/usr/bin/env bash
# Stops and removes the two Claudia launchd agents installed by
# ops/install.sh. Leaves ~/.claudia (config, state, index, secrets, backups,
# releases, runtime, ntfy state) and the vault completely alone: this only
# undoes the launchd registration, never the data.
#
# Env vars:
#   LAUNCHD_DIR   where the plists were installed (default ~/Library/LaunchAgents)
set -euo pipefail

LAUNCHD_DIR="${LAUNCHD_DIR:-$HOME/Library/LaunchAgents}"
LABELS=("com.aroop.claudia" "com.aroop.claudia.ntfy")

log() {
  echo "[uninstall] $*"
}

uid="$(id -u)"

for label in "${LABELS[@]}"; do
  plist="$LAUNCHD_DIR/$label.plist"

  log "stopping $label (if loaded)"
  launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true

  if [ -f "$plist" ]; then
    log "removing $plist"
    rm -f "$plist"
  else
    log "$plist not present, nothing to remove"
  fi
done

log "done. ~/.claudia (config, state, index, secrets, backups, releases) and the vault were left untouched."
log "Re-run ops/install.sh to reinstall; your data and settings will still be there."
