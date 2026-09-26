#!/usr/bin/env bash
# Renders Claudia's ntfy server config and provisions the single "claudia"
# user, its topic, and an access token. Idempotent: safe to re-run.
#
# Env vars (all optional):
#   NTFY_DIR      state directory for the ntfy server (default ~/.claudia/ntfy)
#   SECRETS_DIR   directory for generated secrets (default ~/.claudia/secrets)
#   TOPIC         topic name to use; generated as claudia-<16 hex> if unset
#                 and not already recorded in $NTFY_DIR/topic
#   LISTEN        listen address (default 127.0.0.1:8790, per docs/DECISIONS.md B16)
#   BASE_URL      externally visible base URL (default https://ntfy.aroopbiswal.com)
#   NTFY_BIN      path to the built ntfy binary (default ~/.claudia/ntfy/bin/ntfy)
#
# Does not touch launchd. Does not print secrets: the generated password and
# access token are written to files under $SECRETS_DIR with mode 600 and are
# never echoed to stdout/stderr.
set -euo pipefail

NTFY_DIR="${NTFY_DIR:-$HOME/.claudia/ntfy}"
SECRETS_DIR="${SECRETS_DIR:-$HOME/.claudia/secrets}"
LISTEN="${LISTEN:-127.0.0.1:8790}"
BASE_URL="${BASE_URL:-https://ntfy.aroopbiswal.com}"
NTFY_BIN="${NTFY_BIN:-$HOME/.claudia/ntfy/bin/ntfy}"
TOPIC="${TOPIC:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/ntfy/server.yml.template"

log() {
  echo "[ntfy-setup] $*"
}

fail() {
  echo "[ntfy-setup] ERROR: $*" >&2
  exit 1
}

[ -x "$NTFY_BIN" ] || fail "ntfy binary not found or not executable at $NTFY_BIN (run ops/build-ntfy.sh first)"
[ -f "$TEMPLATE" ] || fail "template not found at $TEMPLATE"

mkdir -p "$NTFY_DIR"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

CONFIG_FILE="$NTFY_DIR/server.yml"
TOPIC_FILE="$NTFY_DIR/topic"
PASSWORD_FILE="$SECRETS_DIR/ntfy-password"
TOKEN_FILE="$SECRETS_DIR/ntfy-token"

# --- Render server.yml -------------------------------------------------------

log "rendering server config to $CONFIG_FILE"
sed \
  -e "s#{{NTFY_DIR}}#${NTFY_DIR}#g" \
  -e "s#{{LISTEN}}#${LISTEN}#g" \
  -e "s#{{BASE_URL}}#${BASE_URL}#g" \
  "$TEMPLATE" > "$CONFIG_FILE.tmp"
mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

# --- Topic -------------------------------------------------------------------

if [ -n "$TOPIC" ]; then
  log "using topic from environment: $TOPIC"
  echo "$TOPIC" > "$TOPIC_FILE"
elif [ -f "$TOPIC_FILE" ]; then
  TOPIC="$(cat "$TOPIC_FILE")"
  log "using existing topic: $TOPIC"
else
  TOPIC="claudia-$(openssl rand -hex 8)"
  echo "$TOPIC" > "$TOPIC_FILE"
  log "generated new topic: $TOPIC"
fi

# --- Password ------------------------------------------------------------

if [ -f "$PASSWORD_FILE" ]; then
  log "password file already exists at $PASSWORD_FILE, reusing it"
else
  log "generating a new password into $PASSWORD_FILE"
  openssl rand -base64 30 > "$PASSWORD_FILE"
  chmod 600 "$PASSWORD_FILE"
fi
chmod 600 "$PASSWORD_FILE"

# --- User ----------------------------------------------------------------

# The 'ntfy user/access/token' CLI commands refuse to open the auth-file
# unless it already exists ("please start the server at least once to create
# it"), even though the underlying sqlite driver is happy to create/migrate
# an empty file. Rather than starting and stopping the server here, just
# touch the file first so the CLI's existence check passes; NewSQLiteManager
# runs its own migrations against it on first use.
AUTH_FILE="$NTFY_DIR/user.db"
[ -f "$AUTH_FILE" ] || touch "$AUTH_FILE"

# All 'ntfy user/access/token' subcommands take --config on the PARENT
# command (e.g. `ntfy user --config FILE add ...`), not on the subcommand
# itself. NTFY_CONFIG_FILE is the equivalent env var for --config/-c, and
# works uniformly across user/access/token, so we use that instead of
# juggling flag placement.
export NTFY_CONFIG_FILE="$CONFIG_FILE"

log "ensuring user 'claudia' exists (role user)"
NTFY_PASSWORD="$(cat "$PASSWORD_FILE")" "$NTFY_BIN" user add \
  --role=user \
  --ignore-exists \
  claudia >/dev/null

# --- Access ----------------------------------------------------------------

log "granting rw access on topic '$TOPIC' to user 'claudia'"
"$NTFY_BIN" access claudia "$TOPIC" rw >/dev/null

# --- Token -------------------------------------------------------------------

if [ -f "$TOKEN_FILE" ]; then
  log "access token already exists at $TOKEN_FILE, reusing it"
else
  log "creating a new access token into $TOKEN_FILE"
  token_output="$("$NTFY_BIN" token add --label claudia claudia)"
  token_value="$(echo "$token_output" | awk '{print $2}')"
  case "$token_value" in
    tk_*) ;;
    *) fail "could not parse an access token (tk_...) out of 'ntfy token add' output" ;;
  esac
  printf '%s\n' "$token_value" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  unset token_output token_value
fi

log "setup complete"
log "config:      $CONFIG_FILE"
log "topic:       $TOPIC"
log "password:    $PASSWORD_FILE (not printed)"
log "token:       $TOKEN_FILE (not printed)"
