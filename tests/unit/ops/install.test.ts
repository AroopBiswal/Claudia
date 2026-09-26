import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Static checks mirror the style of tests/unit/ops/ntfy-scripts.test.ts.
// The --dry-run executions below actually run ops/install.sh, but always
// pointed at a scratch CLAUDIA_HOME/REPO_DIR/LAUNCHD_DIR: --dry-run itself
// never touches disk, the network, or launchctl (only "would ..." plan
// lines), so this is safe to run in CI and in this sandbox alike.

function opsPath(relative: string): string {
  return fileURLToPath(new URL(`../../../ops/${relative}`, import.meta.url));
}

function readOps(relative: string): string {
  return readFileSync(opsPath(relative), 'utf8');
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeFakeRepo(): string {
  const repo = makeTempDir('claudia-install-repo-');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'claudia', version: '0.1.0' }));
  mkdirSync(join(repo, 'ops'), { recursive: true });
  // Only install.sh (plus what it directly reads: the launchd templates and
  // build-ntfy.sh/ntfy-setup.sh, which --dry-run never actually invokes) is
  // needed for a --dry-run pass.
  for (const name of [
    'install.sh',
    'build-ntfy.sh',
    'ntfy-setup.sh',
    'launchd/com.aroop.claudia.plist.template',
    'launchd/com.aroop.claudia.ntfy.plist.template',
  ]) {
    const dest = join(repo, 'ops', name);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, readOps(name));
    chmodSync(dest, 0o755);
  }
  return repo;
}

function runInstall(
  args: string[],
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(join(env.REPO_DIR ?? '', 'ops/install.sh'), args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('ops/install.sh (static)', () => {
  const script = readOps('install.sh');

  it('is executable and fails fast', () => {
    const mode = statSync(opsPath('install.sh')).mode;
    expect(mode & 0o111).not.toBe(0);
    expect(script).toContain('set -euo pipefail');
  });

  it('supports --dry-run and rejects unknown arguments', () => {
    expect(script).toContain('--dry-run');
    expect(script).toContain('unknown argument');
  });

  it('defaults to the documented directories', () => {
    expect(script).toContain('CLAUDIA_HOME="${CLAUDIA_HOME:-$HOME/.claudia}"');
    expect(script).toContain('LAUNCHD_DIR="${LAUNCHD_DIR:-$HOME/Library/LaunchAgents}"');
  });

  it('checks for macOS and that it is run from the Claudia repo', () => {
    expect(script).toMatch(/uname -s.*Darwin/);
    expect(script).toMatch(/"name".*claudia/);
  });

  it('verifies the downloaded Node tarball against SHASUMS256.txt before installing it', () => {
    expect(script).toContain('SHASUMS256.txt');
    expect(script).toContain('sha256 mismatch');
    expect(script).toContain('darwin-arm64');
  });

  it('never writes NODE_ENV or other secrets to stdout, and never prints a raw token or password', () => {
    expect(script).not.toMatch(/echo.*token/i);
    expect(script).not.toMatch(/echo.*password/i);
  });

  it('builds with dev deps and then installs prod deps only in the staged release', () => {
    expect(script).toContain('npm ci --include=dev');
    expect(script).toContain('npm run build');
    expect(script).toContain('npm ci --omit=dev --ignore-scripts');
  });

  it('keeps the 3 newest releases', () => {
    expect(script).toContain('KEEP_RELEASES=3');
  });

  it('never writes secret values into config.json', () => {
    expect(script).not.toMatch(/PASSWORD_FILE|NTFY_PASSWORD/);
    expect(script).not.toMatch(/secret.*config\.json/i);
  });

  it('runs ntfy-setup.sh and bootstraps both launchd agents, tolerating bootout failures', () => {
    expect(script).toContain('ntfy-setup.sh');
    expect(script).toContain('launchctl bootout');
    expect(script).toContain('launchctl bootstrap');
    expect(script).toMatch(/bootout[^\n]*\|\|\s*true/);
  });

  it('seeds the vault via the CLI, not by writing vault files itself', () => {
    expect(script).toContain('seed-vault');
  });

  it('warns but exits 0 when the vault is not readable, instead of failing the install', () => {
    expect(script).toContain('path_ok');
    expect(script).toContain('HUMAN_TODO.md');
  });
});

describe('ops/install.sh --dry-run (executed against a scratch environment)', () => {
  it('prints a full plan and exits 0 without creating anything, on a fresh install', () => {
    const repo = makeFakeRepo();
    const home = makeTempDir('claudia-install-home-');
    const launchd = makeTempDir('claudia-install-launchd-');

    const { status, stdout } = runInstall(['--dry-run'], {
      REPO_DIR: repo,
      CLAUDIA_HOME: home,
      LAUNCHD_DIR: launchd,
      VAULT: join(home, 'vault'),
      OWNER_EMAIL: 'owner@example.com',
    });

    expect(status).toBe(0);
    expect(stdout).toContain('dry run');
    expect(stdout).toContain('would download the latest Node.js 24 darwin-arm64 release');
    expect(stdout).toContain('would run ops/build-ntfy.sh');
    expect(stdout).toContain("would run 'npm ci --include=dev && npm run build'");
    expect(stdout).toContain('would create');
    expect(stdout).toContain('config.json');
    expect(stdout).toContain('would run ops/ntfy-setup.sh');
    expect(stdout).toContain('seed-vault');
    expect(stdout).toContain('would render');
    expect(stdout).toContain('com.aroop.claudia.plist');
    expect(stdout).toContain('would wait up to 30s for http://127.0.0.1:8787/health');
    expect(stdout).toContain('done');

    // Nothing was actually created.
    expect(() => statSync(join(home, 'config.json'))).toThrow();
    expect(() => statSync(join(home, 'runtime'))).toThrow();
    expect(() => statSync(join(launchd, 'com.aroop.claudia.plist'))).toThrow();
  });

  it('reports node/ntfy already present and only offers to fill a missing ntfy topic when config.json exists', () => {
    const repo = makeFakeRepo();
    const home = makeTempDir('claudia-install-home2-');
    const launchd = makeTempDir('claudia-install-launchd2-');

    mkdirSync(join(home, 'runtime', 'bin'), { recursive: true });
    writeFileSync(
      join(home, 'runtime', 'bin', 'node'),
      '#!/usr/bin/env bash\n[ "$1" = "--version" ] && echo v24.9.0\n',
    );
    chmodSync(join(home, 'runtime', 'bin', 'node'), 0o755);

    mkdirSync(join(home, 'ntfy', 'bin'), { recursive: true });
    writeFileSync(join(home, 'ntfy', 'bin', 'ntfy'), '#!/usr/bin/env bash\necho "ntfy 2.28.0"\n');
    chmodSync(join(home, 'ntfy', 'bin', 'ntfy'), 0o755);

    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ vaultPath: '/v', ntfy: { baseUrl: 'http://127.0.0.1:8790', topic: null } }),
    );

    const { status, stdout } = runInstall(['--dry-run'], {
      REPO_DIR: repo,
      CLAUDIA_HOME: home,
      LAUNCHD_DIR: launchd,
    });

    expect(status).toBe(0);
    expect(stdout).toContain('node runtime present: v24.9.0');
    expect(stdout).toContain('ntfy binary present:');
    expect(stdout).not.toContain('would download the latest Node.js');
    expect(stdout).not.toContain('would run ops/build-ntfy.sh');
    expect(stdout).toContain('would fill in a missing ntfy.topic');

    // Still untouched: dry-run never writes, even when the file already exists.
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toContain('"topic":null');
  });

  it('rejects an unknown flag with a non-zero exit', () => {
    const repo = makeFakeRepo();
    const { status, stderr } = runInstall(['--not-a-real-flag'], { REPO_DIR: repo });
    expect(status).not.toBe(0);
    expect(stderr).toContain('unknown argument');
  });

  it('refuses to run against a directory that is not the Claudia repo', () => {
    const notRepo = makeTempDir('claudia-not-a-repo-');
    writeFileSync(join(notRepo, 'package.json'), JSON.stringify({ name: 'something-else' }));
    mkdirSync(join(notRepo, 'ops'), { recursive: true });
    writeFileSync(join(notRepo, 'ops', 'install.sh'), readOps('install.sh'));
    chmodSync(join(notRepo, 'ops', 'install.sh'), 0o755);

    const { status, stderr } = runInstall(['--dry-run'], { REPO_DIR: notRepo });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/doesn't look like the Claudia repo/);
  });
});

describe('ops/uninstall.sh (static)', () => {
  const script = readOps('uninstall.sh');

  it('is executable and fails fast', () => {
    const mode = statSync(opsPath('uninstall.sh')).mode;
    expect(mode & 0o111).not.toBe(0);
    expect(script).toContain('set -euo pipefail');
  });

  it('boots out and removes both agents, tolerating a missing/unloaded agent', () => {
    expect(script).toContain('com.aroop.claudia');
    expect(script).toContain('com.aroop.claudia.ntfy');
    expect(script).toContain('launchctl bootout');
    expect(script).toMatch(/bootout[^\n]*\|\|\s*true/);
  });

  it('never deletes ~/.claudia data or mentions removing the vault', () => {
    expect(script).not.toMatch(/rm -rf.*\.claudia"?\s*$/m);
    expect(script).not.toMatch(/rm -rf.*[Vv]ault/);
  });
});

describe('ops/launchd/com.aroop.claudia.plist.template', () => {
  const plist = readOps('launchd/com.aroop.claudia.plist.template');

  it('declares the expected label and program arguments', () => {
    expect(plist).toContain('<string>com.aroop.claudia</string>');
    expect(plist).toContain('<string>{{NODE}}</string>');
    expect(plist).toContain('<string>{{APP}}/dist/cli.js</string>');
    expect(plist).toContain('<string>serve</string>');
  });

  it('sets CLAUDIA_HOME and NODE_ENV=production via EnvironmentVariables', () => {
    expect(plist).toMatch(/<key>CLAUDIA_HOME<\/key>\s*<string>\{\{HOME_DIR\}\}<\/string>/);
    expect(plist).toMatch(/<key>NODE_ENV<\/key>\s*<string>production<\/string>/);
  });

  it('sets the working directory and restarts on failure with a throttle', () => {
    expect(plist).toMatch(/<key>WorkingDirectory<\/key>\s*<string>\{\{HOME_DIR\}\}<\/string>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  });

  it('logs stdout and stderr to logs/claudia.log under HOME_DIR', () => {
    expect(plist).toContain('{{HOME_DIR}}/logs/claudia.log');
  });
});

describe('ops/cloudflared-ingress.yml', () => {
  const snippet = readOps('cloudflared-ingress.yml');

  it('is explicitly a snippet, not applied automatically', () => {
    expect(snippet).toMatch(/not.*applied/i);
    expect(snippet).toMatch(/by hand/i);
  });

  it('routes claudia and ntfy hostnames to their loopback ports', () => {
    expect(snippet).toContain('hostname: claudia.aroopbiswal.com');
    expect(snippet).toContain('service: http://127.0.0.1:8787');
    expect(snippet).toContain('hostname: ntfy.aroopbiswal.com');
    expect(snippet).toContain('service: http://127.0.0.1:8790');
  });

  it('says the new rules must come before the catch-all', () => {
    expect(snippet).toMatch(/catch-all/i);
  });

  it('warns not to disturb the other existing hostnames', () => {
    expect(snippet).toMatch(/Bull/);
    expect(snippet).toMatch(/Bear/);
  });
});

describe('ops/go-live.md', () => {
  const runbook = readFileSync(
    fileURLToPath(new URL('../../../ops/go-live.md', import.meta.url)),
    'utf8',
  );

  it('covers the ingress merge, DNS routes, and Access application with a bypass list', () => {
    expect(runbook).toMatch(/cloudflared-ingress\.yml/);
    expect(runbook).toContain('cloudflared tunnel route dns');
    expect(runbook).toContain('claudia.aroopbiswal.com');
    expect(runbook).toContain('ntfy.aroopbiswal.com');
    expect(runbook).toMatch(/one-time PIN/i);
    for (const path of [
      '/mcp',
      '/.well-known/*',
      '/oauth/token',
      '/oauth/register',
      '/oauth/revoke',
      '/health',
      '/a/*',
    ]) {
      expect(runbook).toContain(path);
    }
    expect(runbook).toMatch(/\/oauth\/authorize.*behind/i);
  });

  it('has the owner set access.audience, access.teamDomain and ownerEmail then kickstart the service', () => {
    expect(runbook).toContain('access.audience');
    expect(runbook).toContain('access.teamDomain');
    expect(runbook).toContain('ownerEmail');
    expect(runbook).toContain('launchctl kickstart -k gui/$(id -u)/com.aroop.claudia');
  });

  it('has a WAF skip rule for bot checks on the machine paths', () => {
    expect(runbook).toMatch(/WAF/);
    expect(runbook).toMatch(/Bot Fight Mode/);
  });

  it('keeps ntfy off Cloudflare Access and covers the iPhone app setup by reading secrets locally', () => {
    expect(runbook).toMatch(/no Access|not.*put behind Cloudflare Access/i);
    expect(runbook).toContain('cat ~/.claudia/secrets/ntfy-password');
    expect(runbook).toContain('cat ~/.claudia/ntfy/topic');
  });

  it('points to the watchdog and claude-setup docs', () => {
    expect(runbook).toContain('watchdog/README.md');
    expect(runbook).toContain('docs/claude-setup.md');
  });

  it('has a rollback section', () => {
    expect(runbook).toMatch(/## Rollback/);
  });
});
