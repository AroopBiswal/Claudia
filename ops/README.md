# Ops

## ntfy (self-hosted push notifications)

Claudia delivers reminders and follow-up nudges through a self-hosted
[ntfy](https://ntfy.sh) server on this Mac mini (see docs/DECISIONS.md B16 and
docs/KICKOFF.md M4/M8). ntfy forwards a hashed message ID to `ntfy.sh` so the
iPhone app can be woken up without a direct connection to this machine; the
message body and topic name never leave this Mac mini in plaintext.

### Why built from source

Homebrew's `ntfy` formula on macOS is built with the `noserver` build tag,
so it only has the client commands (`ntfy publish`, `ntfy subscribe`, ...) and
is missing `serve`, `user`, `access` and `token`. Running the server requires
building from the upstream source with CGO enabled (for the sqlite backend)
using the same flags as the ntfy Makefile's `cli-darwin-server` target.

### Scripts

- **`ops/build-ntfy.sh`** — idempotent. Downloads and verifies (by SHA-256) a
  Go toolchain into `~/.claudia/tools/go` if one isn't already installed at
  the required version, then downloads the `v2.28.0` ntfy source tarball and
  builds the server binary to `~/.claudia/ntfy/bin/ntfy` with
  `CGO_ENABLED=1` and `-tags sqlite_omit_load_extension,osusergo,netgo`. Skips
  work that's already done (matching Go version present; ntfy binary already
  reports `2.28.0` and has a working `serve` subcommand).
- **`ops/ntfy/server.yml.template`** — the server config template, with
  `{{NTFY_DIR}}`, `{{LISTEN}}` and `{{BASE_URL}}` placeholders.
- **`ops/ntfy-setup.sh`** — idempotent. Renders `server.yml.template` into
  `$NTFY_DIR/server.yml`, generates a topic name and a user password if they
  don't already exist, creates the `claudia` user (role `user`) with the
  password passed non-interactively via the `NTFY_PASSWORD` environment
  variable, grants that user `rw` access on the topic, and creates an access
  token (captured only to a file, never printed). Safe to re-run: every step
  is a no-op if its output already exists.
- **`ops/ntfy-selftest.sh`** — provisions a scratch ntfy instance under
  `$TMPDIR` on a temporary port, starts `ntfy serve` in the background,
  confirms an unauthenticated publish is rejected, publishes an authenticated
  JSON message with an `http` action, polls it back, then stops the server
  and deletes the scratch directory. Does not touch `~/.claudia` or launchd.
- **`ops/launchd/com.aroop.claudia.ntfy.plist.template`** — the launchd agent
  template (label `com.aroop.claudia.ntfy`) used by the later install step.
  Not installed or loaded by any script in this directory.

### Ports and hostnames

Per docs/DECISIONS.md B16: ntfy listens on `127.0.0.1:8790` (Claudia itself is
on `127.0.0.1:8787`). Both are loopback-only until the human go-live step
puts ntfy behind its own public hostname, `https://ntfy.aroopbiswal.com`.
`upstream-base-url` is `https://ntfy.sh`.

### Where things live

- Go toolchain and build scratch: `~/.claudia/tools/`
- ntfy binary: `~/.claudia/ntfy/bin/ntfy`
- ntfy state (config, user database, cache, topic name): `~/.claudia/ntfy/`
- Secrets (generated password, access token): `~/.claudia/secrets/` (mode
  `0700`; files inside mode `0600`). Never committed, never printed.
