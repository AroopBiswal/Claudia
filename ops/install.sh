#!/usr/bin/env bash
# Builds and installs Claudia as a launchd agent (docs/KICKOFF.md M8,
# docs/DECISIONS.md B1/B11/B16). Idempotent: safe to re-run; each step skips
# work that's already done. Prints progress to stdout; never a secret (no
# tokens, passwords, JWTs, or config values that could contain them).
#
# Usage:
#   ops/install.sh             installs/updates Claudia for real
#   ops/install.sh --dry-run   prints the plan only: makes no filesystem
#                              changes, no network calls, and never invokes
#                              launchctl, npm, node, curl or ops/*.sh for real
#
# Steps (docs/KICKOFF.md M8 / this task's brief):
#   a. preconditions: macOS, run from the repo, Node 24 runtime, ntfy binary
#   b. build the repo and stage a release under ~/.claudia/app/releases
#   c. write or update ~/.claudia/config.json
#   d. provision and start the ntfy launchd agent
#   e. seed the vault skeleton from the terminal (has iCloud access already)
#   f. render, start and health-check the Claudia launchd agent
#
# Env vars (all optional; same conventions as the other ops/*.sh scripts and
# src/config.ts):
#   CLAUDIA_HOME   Claudia's home directory (default ~/.claudia)
#   REPO_DIR       the Claudia repo to build from (default: this script's
#                  parent directory)
#   LAUNCHD_DIR    where to render/bootstrap the launchd agents
#                  (default ~/Library/LaunchAgents)
#   VAULT          overrides the default vault path; only used the first
#                  time config.json is created
#   OWNER_EMAIL    written into a newly created config.json's ownerEmail
#                  (default null, filled in later at go-live)
#   NODE_MAJOR     Node major version line to install (default 24, per
#                  docs/DECISIONS.md B1)
set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h | --help)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    *)
      echo "[install] ERROR: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

log() {
  echo "[install] $*"
}

plan() {
  echo "[install] [dry-run] would $*"
}

fail() {
  echo "[install] ERROR: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' not found on PATH"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CLAUDIA_HOME="${CLAUDIA_HOME:-$HOME/.claudia}"
LAUNCHD_DIR="${LAUNCHD_DIR:-$HOME/Library/LaunchAgents}"
NODE_MAJOR="${NODE_MAJOR:-24}"

RUNTIME_DIR="$CLAUDIA_HOME/runtime"
NODE_BIN="$RUNTIME_DIR/bin/node"
NTFY_DIR="$CLAUDIA_HOME/ntfy"
NTFY_BIN="$NTFY_DIR/bin/ntfy"
APP_DIR="$CLAUDIA_HOME/app"
RELEASES_DIR="$APP_DIR/releases"
CURRENT_LINK="$APP_DIR/current"
CONFIG_FILE="$CLAUDIA_HOME/config.json"
LOGS_DIR="$CLAUDIA_HOME/logs"
KEEP_RELEASES=3
DEFAULT_VAULT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Claudia"

# --- Step a: preconditions ---------------------------------------------------

check_preconditions() {
  [ "$(uname -s)" = "Darwin" ] || fail "this installer only supports macOS"

  [ -f "$REPO_DIR/package.json" ] || fail "REPO_DIR ($REPO_DIR) doesn't look like the Claudia repo (no package.json)"
  if ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"claudia"' "$REPO_DIR/package.json"; then
    fail "REPO_DIR ($REPO_DIR) doesn't look like the Claudia repo (package.json name != claudia)"
  fi

  ensure_node_runtime
  ensure_ntfy_binary
}

node_version_ok() {
  [ -x "$NODE_BIN" ] || return 1
  local v
  v="$("$NODE_BIN" --version 2>/dev/null)" || return 1
  case "$v" in
    v"$NODE_MAJOR".*) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_node_runtime() {
  if node_version_ok; then
    log "node runtime present: $("$NODE_BIN" --version)"
    return
  fi

  if $DRY_RUN; then
    plan "download the latest Node.js $NODE_MAJOR darwin-arm64 release, verify its sha256 and install it to $NODE_BIN"
    return
  fi

  need_cmd curl
  need_cmd tar
  need_cmd shasum

  log "installing the Node.js $NODE_MAJOR runtime to $RUNTIME_DIR"
  local index_url shasums tarball_line tarball_sha tarball_name version tmp_dir extracted_dir
  index_url="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/"

  shasums="$(curl -fsSL --max-time 30 "${index_url}SHASUMS256.txt")" ||
    fail "could not fetch ${index_url}SHASUMS256.txt"
  tarball_line="$(echo "$shasums" | grep 'darwin-arm64\.tar\.gz$' || true)"
  [ -n "$tarball_line" ] || fail "could not find a darwin-arm64 tarball in $index_url SHASUMS256.txt"
  tarball_sha="$(echo "$tarball_line" | awk '{print $1}')"
  tarball_name="$(echo "$tarball_line" | awk '{print $2}')"
  version="$(echo "$tarball_name" | sed -E 's/^node-(v[0-9.]+)-darwin-arm64\.tar\.gz$/\1/')"
  [ -n "$version" ] || fail "could not parse a version out of $tarball_name"

  log "latest Node $NODE_MAJOR release for darwin-arm64: $version ($tarball_name)"

  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/claudia-node-XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  curl -fsSL --max-time 300 -o "$tmp_dir/$tarball_name" "${index_url}${tarball_name}" ||
    fail "download of $tarball_name failed"

  local got_sha
  got_sha="$(shasum -a 256 "$tmp_dir/$tarball_name" | awk '{print $1}')"
  [ "$got_sha" = "$tarball_sha" ] || fail "sha256 mismatch for $tarball_name: expected $tarball_sha, got $got_sha"
  log "sha256 verified"

  tar -xzf "$tmp_dir/$tarball_name" -C "$tmp_dir"
  extracted_dir="$tmp_dir/${tarball_name%.tar.gz}"
  [ -x "$extracted_dir/bin/node" ] || fail "extraction did not produce $extracted_dir/bin/node"

  mkdir -p "$RUNTIME_DIR/bin"
  cp "$extracted_dir/bin/node" "$NODE_BIN"
  chmod +x "$NODE_BIN"
  echo "$version" >"$RUNTIME_DIR/VERSION"

  node_version_ok || fail "installed node at $NODE_BIN does not report a v$NODE_MAJOR version"
  log "installed node $version to $NODE_BIN"
}

ensure_ntfy_binary() {
  if [ -x "$NTFY_BIN" ]; then
    log "ntfy binary present: $NTFY_BIN"
    return
  fi

  if $DRY_RUN; then
    plan "run ops/build-ntfy.sh to build the ntfy server binary at $NTFY_BIN"
    return
  fi

  log "building the ntfy server binary"
  CLAUDIA_NTFY_BIN_DIR="$NTFY_DIR/bin" "$SCRIPT_DIR/build-ntfy.sh"
  [ -x "$NTFY_BIN" ] || fail "ops/build-ntfy.sh did not produce $NTFY_BIN"
}

# --- Step b: build and stage a release --------------------------------------

build_release() {
  if $DRY_RUN; then
    plan "run 'npm ci --include=dev && npm run build' in $REPO_DIR"
    plan "stage a release under $RELEASES_DIR, run 'npm ci --omit=dev --ignore-scripts' in it, and atomically point $CURRENT_LINK at it"
    plan "keep the $KEEP_RELEASES newest releases"
    return
  fi

  need_cmd npm
  need_cmd node
  need_cmd git

  log "building Claudia in $REPO_DIR"
  (cd "$REPO_DIR" && npm ci --include=dev && npm run build)

  local version shortsha release_name release_dir tmp_link
  version="$(node -p "require('$REPO_DIR/package.json').version")"
  shortsha="$(cd "$REPO_DIR" && git rev-parse --short HEAD 2>/dev/null || echo nogit)"
  release_name="${version}-${shortsha}"
  release_dir="$RELEASES_DIR/$release_name"

  log "staging release $release_name"
  rm -rf "$release_dir"
  mkdir -p "$release_dir"
  cp -R "$REPO_DIR/dist" "$release_dir/dist"
  cp "$REPO_DIR/package.json" "$release_dir/package.json"
  cp "$REPO_DIR/package-lock.json" "$release_dir/package-lock.json"

  log "installing production dependencies into the release (pure JS, no scripts)"
  (cd "$release_dir" && npm ci --omit=dev --ignore-scripts)

  log "pointing $CURRENT_LINK at $release_dir"
  mkdir -p "$APP_DIR"
  tmp_link="$APP_DIR/.current.tmp.$$"
  ln -sfn "$release_dir" "$tmp_link"
  # rename(2) replaces the symlink itself atomically; plain `mv` would follow it into the old release.
  "$NODE_BIN" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$tmp_link" "$CURRENT_LINK"

  prune_old_releases
}

prune_old_releases() {
  [ -d "$RELEASES_DIR" ] || return
  local current_target
  current_target="$(cd "$RELEASES_DIR" && readlink "$CURRENT_LINK" 2>/dev/null || true)"

  local count=0
  local release
  while IFS= read -r release; do
    [ -n "$release" ] || continue
    count=$((count + 1))
    if [ "$count" -gt "$KEEP_RELEASES" ]; then
      if [ "$RELEASES_DIR/$release" = "$current_target" ]; then
        continue
      fi
      log "pruning old release $release"
      rm -rf "${RELEASES_DIR:?}/${release:?}"
    fi
  done < <(cd "$RELEASES_DIR" && ls -1t)
}

# --- Step c: config.json -----------------------------------------------------

# Idempotent: creates config.json if missing (with the ntfy topic if one is
# already on disk); if it exists, only ever fills in a missing ntfy.topic.
# Called both right after this step and again after ntfy-setup.sh in step d,
# so a single install run ends with the topic recorded even though ntfy is
# provisioned after config.json is first written.
sync_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    if $DRY_RUN; then
      plan "create $CONFIG_FILE (mode 600) with vaultPath ${VAULT:-$DEFAULT_VAULT}"
      return
    fi
    create_config
  else
    if $DRY_RUN; then
      plan "fill in a missing ntfy.topic in $CONFIG_FILE, if any"
      return
    fi
    fill_missing_ntfy_topic
  fi
}

create_config() {
  local vault_path topic owner_email
  vault_path="${VAULT:-$DEFAULT_VAULT}"
  topic=""
  [ -f "$NTFY_DIR/topic" ] && topic="$(cat "$NTFY_DIR/topic")"
  owner_email="${OWNER_EMAIL:-}"

  log "creating $CONFIG_FILE"
  mkdir -p "$CLAUDIA_HOME"
  CONFIG_FILE="$CONFIG_FILE" VAULT_PATH="$vault_path" TOPIC="$topic" OWNER_EMAIL_VALUE="$owner_email" "$NODE_BIN" -e '
    const fs = require("node:fs");
    const vaultPath = process.env.VAULT_PATH;
    const topic = process.env.TOPIC || null;
    const ownerEmail = process.env.OWNER_EMAIL_VALUE || null;
    const config = {
      vaultPath,
      vaultName: "Claudia",
      host: "127.0.0.1",
      port: 8787,
      publicUrl: "https://claudia.aroopbiswal.com",
      ownerEmail,
      ntfy: { baseUrl: "http://127.0.0.1:8790", topic },
    };
    fs.writeFileSync(process.env.CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  '
  chmod 600 "$CONFIG_FILE"
}

fill_missing_ntfy_topic() {
  local topic
  topic=""
  [ -f "$NTFY_DIR/topic" ] && topic="$(cat "$NTFY_DIR/topic")"
  [ -n "$topic" ] || return 0

  CONFIG_FILE="$CONFIG_FILE" TOPIC="$topic" "$NODE_BIN" -e '
    const fs = require("node:fs");
    const file = process.env.CONFIG_FILE;
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.ntfy = config.ntfy || {};
    if (!config.ntfy.topic) {
      config.ntfy.topic = process.env.TOPIC;
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
      console.log("[install] filled in ntfy.topic in " + file);
    }
  '
}

# --- Step d: ntfy launchd agent ----------------------------------------------

setup_ntfy_agent() {
  local plist_template plist_dest
  plist_template="$SCRIPT_DIR/launchd/com.aroop.claudia.ntfy.plist.template"
  plist_dest="$LAUNCHD_DIR/com.aroop.claudia.ntfy.plist"

  if $DRY_RUN; then
    plan "run ops/ntfy-setup.sh"
    plan "render $plist_template to $plist_dest"
    plan "launchctl bootout the ntfy agent (ignoring errors), then bootstrap it from $plist_dest"
    plan "wait for http://127.0.0.1:8790/v1/health to report healthy"
    return
  fi

  need_cmd launchctl
  need_cmd curl

  log "running ops/ntfy-setup.sh"
  NTFY_DIR="$NTFY_DIR" SECRETS_DIR="$CLAUDIA_HOME/secrets" NTFY_BIN="$NTFY_BIN" \
    "$SCRIPT_DIR/ntfy-setup.sh"

  sync_config

  log "rendering ntfy launchd plist to $plist_dest"
  mkdir -p "$LAUNCHD_DIR" "$LOGS_DIR"
  sed \
    -e "s#{{NTFY_BIN}}#${NTFY_BIN}#g" \
    -e "s#{{NTFY_DIR}}#${NTFY_DIR}#g" \
    -e "s#{{LOG_DIR}}#${LOGS_DIR}#g" \
    "$plist_template" >"$plist_dest.tmp"
  mv "$plist_dest.tmp" "$plist_dest"

  local uid
  uid="$(id -u)"
  launchctl bootout "gui/$uid/com.aroop.claudia.ntfy" >/dev/null 2>&1 || true
  # Wait until launchd has really unloaded it (a process held by macOS can take a moment to exit).
  for _ in $(seq 1 40); do launchctl print "gui/$uid/com.aroop.claudia.ntfy" >/dev/null 2>&1 || break; sleep 0.5; done
  launchctl bootstrap "gui/$uid" "$plist_dest"

  log "waiting for ntfy to become healthy"
  local i health
  health=""
  for i in $(seq 1 30); do
    if health="$(curl -fsS --max-time 2 "http://127.0.0.1:8790/v1/health" 2>/dev/null)"; then
      break
    fi
    sleep 1
  done
  case "$health" in
    *'"healthy":true'*)
      log "ntfy is healthy"
      ;;
    *)
      fail "ntfy did not report healthy within 30s (last response: ${health:-<none>})"
      ;;
  esac
}

# --- Step e: seed the vault ---------------------------------------------------

seed_vault_step() {
  if $DRY_RUN; then
    plan "run '$NODE_BIN $CURRENT_LINK/dist/cli.js seed-vault' from this terminal"
    return
  fi

  log "seeding the vault skeleton"
  "$NODE_BIN" "$CURRENT_LINK/dist/cli.js" seed-vault
}

# --- Step f: Claudia launchd agent -------------------------------------------

setup_claudia_agent() {
  local plist_template plist_dest
  plist_template="$SCRIPT_DIR/launchd/com.aroop.claudia.plist.template"
  plist_dest="$LAUNCHD_DIR/com.aroop.claudia.plist"

  if $DRY_RUN; then
    plan "render $plist_template to $plist_dest"
    plan "launchctl bootout the claudia agent (ignoring errors), then bootstrap it from $plist_dest"
    plan "wait up to 60s for http://127.0.0.1:8787/health and print it"
    return
  fi

  need_cmd launchctl
  need_cmd curl

  log "rendering Claudia launchd plist to $plist_dest"
  mkdir -p "$LAUNCHD_DIR" "$LOGS_DIR"
  sed \
    -e "s#{{NODE}}#${NODE_BIN}#g" \
    -e "s#{{APP}}#${CURRENT_LINK}#g" \
    -e "s#{{HOME_DIR}}#${CLAUDIA_HOME}#g" \
    "$plist_template" >"$plist_dest.tmp"
  mv "$plist_dest.tmp" "$plist_dest"

  local uid
  uid="$(id -u)"
  launchctl bootout "gui/$uid/com.aroop.claudia" >/dev/null 2>&1 || true
  # Wait until launchd has really unloaded it (a process held by macOS can take a moment to exit).
  for _ in $(seq 1 40); do launchctl print "gui/$uid/com.aroop.claudia" >/dev/null 2>&1 || break; sleep 0.5; done
  launchctl bootstrap "gui/$uid" "$plist_dest"

  log "waiting for Claudia to come up"
  local i health
  health=""
  for i in $(seq 1 60); do
    if health="$(curl -fsS --max-time 6 "http://127.0.0.1:8787/health" 2>/dev/null)"; then
      break
    fi
    sleep 1
  done

  if [ -z "$health" ]; then
    fail "Claudia did not respond on http://127.0.0.1:8787/health within 60s"
  fi

  log "health: $health"

  case "$health" in
    *'"path_ok":false'*)
      log "WARNING: the vault is not readable by the Claudia service."
      log "This is expected the first time: grant Full Disk Access to the runtime node binary."
      log "See docs/HUMAN_TODO.md item 1 for exact steps. Install itself succeeded."
      ;;
    *)
      log "vault is readable; install succeeded"
      ;;
  esac
}

main() {
  if $DRY_RUN; then
    log "dry run: printing the plan, changing nothing"
  fi

  log "step a: preconditions"
  check_preconditions

  log "step b: build and stage a release"
  build_release

  log "step c: config"
  sync_config

  log "step d: ntfy"
  setup_ntfy_agent

  log "step e: seed the vault"
  seed_vault_step

  log "step f: claudia agent"
  setup_claudia_agent

  log "done"
}

main
