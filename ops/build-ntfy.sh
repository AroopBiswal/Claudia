#!/usr/bin/env bash
# Builds a self-hosted ntfy server binary from source for macOS arm64.
#
# Homebrew's `ntfy` is built with the `noserver` tag (client only), so the
# server (serve/user/token/access commands) has to be built from source with
# CGO enabled for the sqlite backend. This script is idempotent: it skips the
# Go toolchain download if the right version is already installed, and skips
# the ntfy build if the target binary already reports the right version and
# has the `serve` subcommand.
#
# Everything this script writes lives under ~/.claudia/tools (Go toolchain,
# GOPATH/GOCACHE/GOMODCACHE, source checkout) and ~/.claudia/ntfy/bin (the
# built binary), plus a $TMPDIR scratch directory for the download/build.
set -euo pipefail

NTFY_VERSION="${NTFY_VERSION:-2.28.0}"
CLAUDIA_TOOLS_DIR="${CLAUDIA_TOOLS_DIR:-$HOME/.claudia/tools}"
CLAUDIA_NTFY_BIN_DIR="${CLAUDIA_NTFY_BIN_DIR:-$HOME/.claudia/ntfy/bin}"
GO_DIR="$CLAUDIA_TOOLS_DIR/go"
GO_BIN="$GO_DIR/bin/go"
NTFY_BIN="$CLAUDIA_NTFY_BIN_DIR/ntfy"
GO_DL_JSON_URL="https://go.dev/dl/?mode=json"
NTFY_SRC_URL="https://github.com/binwiederhier/ntfy/archive/refs/tags/v${NTFY_VERSION}.tar.gz"

log() {
  echo "[build-ntfy] $*"
}

fail() {
  echo "[build-ntfy] ERROR: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' not found on PATH"
}

need_cmd curl
need_cmd tar
need_cmd shasum
need_cmd clang

# --- Step 1: ensure a Go toolchain at $GO_DIR -------------------------------

install_go() {
  log "fetching Go release index from go.dev"
  local index
  index="$(curl -fsSL --max-time 30 "$GO_DL_JSON_URL")" || fail "could not fetch $GO_DL_JSON_URL"

  # Pick the newest stable release with a darwin/arm64 archive, using a tiny
  # inline node script (Node is already a hard dependency of this repo) so we
  # don't need to hand-roll JSON parsing in bash.
  local filename sha256 version picked
  picked="$(node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const rel = data.find(r => r.stable && r.files.some(f => f.os === "darwin" && f.arch === "arm64" && f.kind === "archive"));
    if (!rel) { process.exit(1); }
    const file = rel.files.find(f => f.os === "darwin" && f.arch === "arm64" && f.kind === "archive");
    console.log(rel.version, file.filename, file.sha256);
  ' <<< "$index")" || fail "could not find a stable darwin/arm64 Go release in the go.dev index"
  read -r version filename sha256 <<< "$picked"
  [ -n "${version:-}" ] || fail "could not find a stable darwin/arm64 Go release in the go.dev index"

  log "latest stable Go release for darwin/arm64: $version ($filename)"

  if [ -x "$GO_BIN" ]; then
    local have_version
    have_version="$("$GO_BIN" version 2>/dev/null | awk '{print $3}')" || have_version=""
    if [ "$have_version" = "$version" ]; then
      log "Go toolchain already installed at $GO_DIR ($have_version), skipping download"
      return 0
    fi
    log "installed Go toolchain is $have_version, want $version; reinstalling"
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/claudia-go-XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local archive="$tmp_dir/$filename"
  log "downloading $filename"
  curl -fsSL --max-time 600 -o "$archive" "https://go.dev/dl/$filename" || fail "download of $filename failed"

  local got_sha256
  got_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
  [ "$got_sha256" = "$sha256" ] || fail "sha256 mismatch for $filename: expected $sha256, got $got_sha256"
  log "sha256 verified"

  mkdir -p "$CLAUDIA_TOOLS_DIR"
  rm -rf "$GO_DIR"
  tar -xzf "$archive" -C "$CLAUDIA_TOOLS_DIR"
  [ -x "$GO_BIN" ] || fail "extraction did not produce $GO_BIN"
  log "installed Go $version to $GO_DIR"
}

install_go

GO_VERSION_STR="$("$GO_BIN" version)"
log "using $GO_VERSION_STR"

# --- Step 2: skip the ntfy build if it's already in place -------------------

binary_is_current() {
  [ -x "$NTFY_BIN" ] || return 1
  local out
  out="$("$NTFY_BIN" --version 2>&1)" || return 1
  case "$out" in
    *"$NTFY_VERSION"*) ;;
    *) return 1 ;;
  esac
  "$NTFY_BIN" serve --help >/dev/null 2>&1 || return 1
  return 0
}

if binary_is_current; then
  log "ntfy $NTFY_VERSION already built with a working 'serve' command, skipping build"
  log "binary: $NTFY_BIN"
  "$NTFY_BIN" --version
  exit 0
fi

# --- Step 3: download ntfy source and build the server ----------------------

BUILD_TMP="$(mktemp -d "${TMPDIR:-/tmp}/claudia-ntfy-build-XXXXXX")"
cleanup_build_tmp() {
  rm -rf "$BUILD_TMP"
}
trap cleanup_build_tmp EXIT

log "downloading ntfy v$NTFY_VERSION source"
curl -fsSL --max-time 300 -o "$BUILD_TMP/ntfy.tar.gz" "$NTFY_SRC_URL" || fail "download of ntfy source failed"

tar -xzf "$BUILD_TMP/ntfy.tar.gz" -C "$BUILD_TMP"
SRC_DIR="$BUILD_TMP/ntfy-${NTFY_VERSION}"
[ -d "$SRC_DIR" ] || fail "expected source directory $SRC_DIR after extraction"

log "running static-sites placeholder step (server/docs, server/site)"
mkdir -p "$SRC_DIR/server/docs" "$SRC_DIR/server/site"
touch "$SRC_DIR/server/docs/index.html" "$SRC_DIR/server/site/app.html"

mkdir -p "$CLAUDIA_TOOLS_DIR/gopath" "$CLAUDIA_TOOLS_DIR/gocache" "$CLAUDIA_TOOLS_DIR/gomodcache"
mkdir -p "$CLAUDIA_NTFY_BIN_DIR"

log "building ntfy server (CGO_ENABLED=1, tags sqlite_omit_load_extension,osusergo,netgo)"
(
  cd "$SRC_DIR"
  export PATH="$GO_DIR/bin:$PATH"
  export GOPATH="$CLAUDIA_TOOLS_DIR/gopath"
  export GOCACHE="$CLAUDIA_TOOLS_DIR/gocache"
  export GOMODCACHE="$CLAUDIA_TOOLS_DIR/gomodcache"
  export CGO_ENABLED=1
  "$GO_BIN" build \
    -tags sqlite_omit_load_extension,osusergo,netgo \
    -ldflags "-X main.version=${NTFY_VERSION}" \
    -o "$NTFY_BIN" \
    .
) || fail "go build failed (check that Xcode command line tools / clang are installed for CGO)"

[ -x "$NTFY_BIN" ] || fail "build did not produce $NTFY_BIN"

binary_is_current || fail "built binary at $NTFY_BIN does not report version $NTFY_VERSION or is missing 'serve'"

log "build succeeded"
log "binary: $NTFY_BIN"
"$NTFY_BIN" --version
