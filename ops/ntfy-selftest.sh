#!/usr/bin/env bash
# End-to-end self-test for the self-hosted ntfy setup, without touching
# launchd or any real Claudia state. Runs entirely inside a scratch directory
# under $TMPDIR:
#
#   1. runs ops/ntfy-setup.sh against a scratch NTFY_DIR/SECRETS_DIR and a
#      temporary loopback port,
#   2. starts `ntfy serve` against that config in the background,
#   3. confirms an unauthenticated publish to the topic is rejected,
#   4. publishes a JSON message with an http action, authenticated with the
#      generated access token,
#   5. polls the topic's JSON feed and confirms the message and its action
#      show up,
#   6. stops the server and deletes the scratch directory.
#
# Never prints the password or token; only non-secret status lines (and the
# topic name, which is not a secret) go to stdout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELFTEST_PORT="${SELFTEST_PORT:-18790}"
SELFTEST_LISTEN="127.0.0.1:${SELFTEST_PORT}"

log() {
  echo "[ntfy-selftest] $*"
}

fail() {
  echo "[ntfy-selftest] FAIL: $*" >&2
  exit 1
}

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/claudia-ntfy-selftest-XXXXXX")"
NTFY_DIR="$TMP_ROOT/ntfy"
SECRETS_DIR="$TMP_ROOT/secrets"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    log "stopping ntfy server (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  log "removing scratch directory $TMP_ROOT"
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

NTFY_BIN="${NTFY_BIN:-$HOME/.claudia/ntfy/bin/ntfy}"
[ -x "$NTFY_BIN" ] || fail "ntfy binary not found at $NTFY_BIN (run ops/build-ntfy.sh first)"

log "provisioning scratch ntfy config in $TMP_ROOT"
NTFY_DIR="$NTFY_DIR" SECRETS_DIR="$SECRETS_DIR" LISTEN="$SELFTEST_LISTEN" NTFY_BIN="$NTFY_BIN" \
  bash "$SCRIPT_DIR/ntfy-setup.sh"

TOPIC="$(cat "$NTFY_DIR/topic")"
TOKEN_FILE="$SECRETS_DIR/ntfy-token"
[ -f "$TOKEN_FILE" ] || fail "expected token file at $TOKEN_FILE"
log "topic: $TOPIC"

log "starting ntfy serve on $SELFTEST_LISTEN"
"$NTFY_BIN" serve --config "$NTFY_DIR/server.yml" >"$TMP_ROOT/ntfy.log" 2>&1 &
SERVER_PID=$!

log "waiting for ntfy to accept connections"
ready=0
for _ in $(seq 1 50); do
  if curl -fsS --max-time 2 "http://${SELFTEST_LISTEN}/v1/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || fail "ntfy server exited early; see $TMP_ROOT/ntfy.log"
  sleep 0.2
done
[ "$ready" = "1" ] || fail "ntfy server did not become ready on $SELFTEST_LISTEN"
log "server is up (pid $SERVER_PID)"

# --- Unauthenticated publish must be rejected -------------------------------

log "confirming unauthenticated publish is rejected"
unauth_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
  -H 'Content-Type: application/json' \
  -d "{\"topic\":\"${TOPIC}\",\"message\":\"should be rejected\"}" \
  "http://${SELFTEST_LISTEN}/")"
case "$unauth_status" in
  401 | 403) log "unauthenticated publish correctly rejected (HTTP $unauth_status)" ;;
  *) fail "expected 401/403 for unauthenticated publish, got HTTP $unauth_status" ;;
esac

# --- Authenticated publish with an http action ------------------------------

log "publishing an authenticated message with an http action"
publish_payload=$(cat <<JSON
{
  "topic": "${TOPIC}",
  "title": "Claudia selftest",
  "message": "ntfy selftest message",
  "actions": [
    {
      "action": "http",
      "label": "Done",
      "url": "https://example.invalid/claudia/selftest/done",
      "method": "POST"
    }
  ]
}
JSON
)
publish_status="$(curl -sS -o "$TMP_ROOT/publish-response.json" -w '%{http_code}' --max-time 5 \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  -H 'Content-Type: application/json' \
  -d "$publish_payload" \
  "http://${SELFTEST_LISTEN}/")"
[ "$publish_status" = "200" ] || fail "expected HTTP 200 publishing with a valid token, got $publish_status"
log "publish accepted (HTTP $publish_status)"

# --- Poll the topic and confirm the message and its action are there -------

log "polling GET /${TOPIC}/json?poll=1"
poll_output="$(curl -fsS --max-time 5 \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  "http://${SELFTEST_LISTEN}/${TOPIC}/json?poll=1")" || fail "poll request failed"

echo "$poll_output" | grep -q '"message":"ntfy selftest message"' \
  || fail "polled message did not contain the expected message text"
echo "$poll_output" | grep -q '"action":"http"' \
  || fail "polled message did not contain the expected http action"
echo "$poll_output" | grep -q 'https://example.invalid/claudia/selftest/done' \
  || fail "polled message did not contain the expected action URL"

log "poll confirmed message and action"
log "SELFTEST PASSED"
