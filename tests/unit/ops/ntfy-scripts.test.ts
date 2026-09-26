import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// These are light static checks on the ntfy ops scripts and templates
// (shape, safety flags, placeholders), not a run of the scripts themselves:
// building the real Go toolchain and ntfy binary is exercised manually via
// ops/build-ntfy.sh and ops/ntfy-selftest.sh, not in the fast unit suite.

function opsPath(relative: string): string {
  return fileURLToPath(new URL(`../../../ops/${relative}`, import.meta.url));
}

function readOps(relative: string): string {
  return readFileSync(opsPath(relative), 'utf8');
}

describe('ops/build-ntfy.sh', () => {
  const script = readOps('build-ntfy.sh');

  it('is executable', () => {
    const mode = statSync(opsPath('build-ntfy.sh')).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it('fails fast on errors and unset variables', () => {
    expect(script).toContain('set -euo pipefail');
  });

  it('targets the pinned ntfy version and required build tags', () => {
    expect(script).toContain('NTFY_VERSION="${NTFY_VERSION:-2.28.0}"');
    expect(script).toContain('sqlite_omit_load_extension,osusergo,netgo');
    expect(script).toContain('CGO_ENABLED=1');
  });

  it('keeps the Go toolchain and ntfy binary under ~/.claudia, not ~/go', () => {
    expect(script).toContain('CLAUDIA_TOOLS_DIR="${CLAUDIA_TOOLS_DIR:-$HOME/.claudia/tools}"');
    expect(script).toContain(
      'CLAUDIA_NTFY_BIN_DIR="${CLAUDIA_NTFY_BIN_DIR:-$HOME/.claudia/ntfy/bin}"',
    );
    expect(script).toContain('GOPATH="$CLAUDIA_TOOLS_DIR/gopath"');
  });

  it('verifies the downloaded Go archive against its published sha256', () => {
    expect(script).toContain('shasum -a 256');
    expect(script).toContain('sha256 mismatch');
  });

  it('runs the static-sites placeholder step before building', () => {
    expect(script).toContain('server/docs');
    expect(script).toContain('server/site');
    expect(script).toContain('touch');
  });
});

describe('ops/ntfy/server.yml.template', () => {
  const template = readOps('ntfy/server.yml.template');

  it('has the three required placeholders', () => {
    expect(template).toContain('{{NTFY_DIR}}');
    expect(template).toContain('{{LISTEN}}');
    expect(template).toContain('{{BASE_URL}}');
  });

  it('binds to the given listen address and forwards upstream to ntfy.sh', () => {
    expect(template).toMatch(/listen-http:\s*"\{\{LISTEN\}\}"/);
    expect(template).toContain('upstream-base-url: "https://ntfy.sh"');
  });

  it('denies access by default and disables self-service accounts', () => {
    expect(template).toContain('auth-default-access: "deny-all"');
    expect(template).toContain('enable-login: false');
    expect(template).toContain('enable-signup: false');
  });

  it('does not set an attachment-cache-dir config line', () => {
    expect(template).not.toMatch(/^attachment-cache-dir:/m);
  });
});

describe('ops/ntfy-setup.sh', () => {
  const script = readOps('ntfy-setup.sh');

  it('is executable and fails fast', () => {
    const mode = statSync(opsPath('ntfy-setup.sh')).mode;
    expect(mode & 0o111).not.toBe(0);
    expect(script).toContain('set -euo pipefail');
  });

  it('defaults to the documented directories and port', () => {
    expect(script).toContain('NTFY_DIR="${NTFY_DIR:-$HOME/.claudia/ntfy}"');
    expect(script).toContain('SECRETS_DIR="${SECRETS_DIR:-$HOME/.claudia/secrets}"');
    expect(script).toContain('LISTEN="${LISTEN:-127.0.0.1:8790}"');
  });

  it('locks down the secrets directory and generated secret files', () => {
    expect(script).toContain('chmod 700 "$SECRETS_DIR"');
    expect(script).toContain('chmod 600 "$PASSWORD_FILE"');
    expect(script).toContain('chmod 600 "$TOKEN_FILE"');
  });

  it('passes the password non-interactively via NTFY_PASSWORD', () => {
    expect(script).toContain('NTFY_PASSWORD="$(cat "$PASSWORD_FILE")"');
  });

  it('never echoes the password or token to stdout', () => {
    expect(script).not.toMatch(/echo.*PASSWORD_FILE/);
    expect(script).not.toMatch(/cat\s+"\$PASSWORD_FILE"\s*$/m);
    expect(script).not.toMatch(/cat\s+"\$TOKEN_FILE"\s*$/m);
  });

  it('generates a topic named claudia-<16 hex chars> when none is given', () => {
    expect(script).toMatch(/claudia-\$\(openssl rand -hex 8\)/);
  });
});

describe('ops/ntfy-selftest.sh', () => {
  const script = readOps('ntfy-selftest.sh');

  it('is executable and fails fast', () => {
    const mode = statSync(opsPath('ntfy-selftest.sh')).mode;
    expect(mode & 0o111).not.toBe(0);
    expect(script).toContain('set -euo pipefail');
  });

  it('runs entirely under a scratch directory and cleans it up', () => {
    expect(script).toMatch(/mktemp -d "\$\{TMPDIR:-\/tmp\}/);
    expect(script).toContain('rm -rf "$TMP_ROOT"');
    expect(script).toContain('trap cleanup EXIT');
  });

  it('checks for both the auth rejection and the http action round-trip', () => {
    expect(script).toContain('401 | 403');
    expect(script).toContain('"action": "http"');
    expect(script).toContain('poll=1');
  });
});

describe('ops/launchd/com.aroop.claudia.ntfy.plist.template', () => {
  const plist = readOps('launchd/com.aroop.claudia.ntfy.plist.template');

  it('declares the expected label and program arguments', () => {
    expect(plist).toContain('<string>com.aroop.claudia.ntfy</string>');
    expect(plist).toContain('<string>{{NTFY_BIN}}</string>');
    expect(plist).toContain('<string>serve</string>');
    expect(plist).toContain('<string>--config</string>');
    expect(plist).toContain('{{NTFY_DIR}}/server.yml');
  });

  it('restarts on failure with a throttle and logs to the given directory', () => {
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    expect(plist).toContain('{{LOG_DIR}}/ntfy.log');
  });
});
