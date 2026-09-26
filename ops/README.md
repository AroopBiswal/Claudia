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

## Install

**`ops/install.sh`** builds and installs Claudia as a launchd agent
(docs/DECISIONS.md B1/B11/B16). It is idempotent — safe to re-run any time —
and prints only progress lines, never a secret. Run it from a checkout of
this repo on the Mac mini:

```
ops/install.sh
```

Or see the plan without changing anything:

```
ops/install.sh --dry-run
```

What it does, in order:

1. **Preconditions**: confirms macOS and that it's running from this repo;
   installs the Node 24 runtime to `~/.claudia/runtime/bin/node` if missing
   (downloads the latest darwin-arm64 release from nodejs.org, verifies its
   sha256 against `SHASUMS256.txt` first — see docs/DECISIONS.md B1 for why
   this isn't Homebrew's node); builds the ntfy server binary via
   `ops/build-ntfy.sh` if missing.
2. **Build**: `npm ci --include=dev && npm run build` in this repo, then
   stages a release under `~/.claudia/app/releases/<version>-<shortsha>/`
   (dist, package.json, package-lock.json, `npm ci --omit=dev
   --ignore-scripts`), and atomically points `~/.claudia/app/current` at it.
   The 3 newest releases are kept.
3. **Config**: creates `~/.claudia/config.json` (mode 600) if missing, or
   fills in a missing `ntfy.topic` if it already exists. Override the
   default vault path with the `VAULT` env var and set `ownerEmail` with
   `OWNER_EMAIL` (both only apply the first time config.json is created).
4. **ntfy**: runs `ops/ntfy-setup.sh`, renders and bootstraps the
   `com.aroop.claudia.ntfy` launchd agent, and waits for its `/v1/health`
   to report healthy.
5. **Seed the vault**: runs `claudia seed-vault` from this terminal (which
   already has iCloud access, unlike the launchd service before its Full
   Disk Access grant) to lay down the vault skeleton (docs/vault-format.md
   section 1) without touching anything else already in the vault.
6. **Claudia agent**: renders and bootstraps the `com.aroop.claudia`
   launchd agent, waits up to 30s for `/health`, and prints it. If the
   vault isn't readable yet, this prints the Full Disk Access instructions
   from docs/HUMAN_TODO.md item 1 and exits 0 with a warning — the install
   itself still succeeded; the grant is a one-time human step.

**`ops/uninstall.sh`** stops and removes both launchd agents. It leaves
`~/.claudia` (config, state, index, secrets, backups, releases, runtime)
and the vault completely untouched — only the launchd registration goes
away, never the data:

```
ops/uninstall.sh
```

## Smoke test

**`scripts/smoke.ts`** (`npm run smoke`) is a local, end-to-end check
against the **installed** service (never the dev server): it reads
`~/.claudia/config.json`, opens a real MCP session over HTTP, captures a
clearly labeled timed reminder, confirms the vault line, waits for the
reminder to fire through the real local ntfy server, completes it with the
signed Done push action, then removes the item again with `update
{ action: "forget" }`. Each step prints `✔ step` or `✘ step: reason` and it
exits non-zero on the first failure; the token it mints and the ntfy
access token it reads are never printed. Run it after `ops/install.sh`:

```
npm run smoke
```

## Go-live

Putting Claudia on the public internet (`ops/cloudflared-ingress.yml`, DNS,
Cloudflare Access, the WAF skip rule, the watchdog, the ntfy iPhone app,
and the Claude-side setup) is a human runbook: see `ops/go-live.md`. Go-live
is deliberately not automated — see CLAUDE.md's hard rules on
`~/.cloudflared`, DNS and Cloudflare settings.
