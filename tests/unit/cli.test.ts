import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

function runCli(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('cli', () => {
  it('prints the version and exits 0 for --version', () => {
    const result = runCli(['--version']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints the version and exits 0 for -v', () => {
    const result = runCli(['-v']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints usage and exits 0 for --help', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: claudia');
    expect(result.stdout).toContain('serve');
    expect(result.stdout).toContain('reindex');
    expect(result.stdout).toContain('seed-vault');
    expect(result.stdout).toContain('calendar-auth');
  });

  it('prints usage and exits 2 for an unknown command', () => {
    const result = runCli(['not-a-real-command']);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Usage: claudia');
  });

  it('prints usage and exits 2 with no arguments', () => {
    const result = runCli([]);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Usage: claudia');
  });

  describe('seed-vault', () => {
    const dirs: string[] = [];

    afterEach(() => {
      for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('seeds a vault on a temp config and reports created/skipped counts', () => {
      const home = mkdtempSync(join(tmpdir(), 'claudia-cli-home-'));
      const vaultDir = mkdtempSync(join(tmpdir(), 'claudia-cli-vault-'));
      dirs.push(home, vaultDir);
      writeFileSync(join(home, 'config.json'), JSON.stringify({ vaultPath: vaultDir }));

      const first = runCli(['seed-vault'], { CLAUDIA_HOME: home });
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('Seeded vault:');
      expect(first.stdout).toMatch(/\d+ created, 0 already existed/);

      const second = runCli(['seed-vault'], { CLAUDIA_HOME: home });
      expect(second.status).toBe(0);
      expect(second.stdout).toMatch(/0 created, \d+ already existed/);
    });
  });

  describe('calendar-auth', () => {
    const dirs: string[] = [];

    afterEach(() => {
      for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('exits 1 with a clear message when client secrets are missing', () => {
      const home = mkdtempSync(join(tmpdir(), 'claudia-cli-home-'));
      const vaultDir = mkdtempSync(join(tmpdir(), 'claudia-cli-vault-'));
      dirs.push(home, vaultDir);
      writeFileSync(join(home, 'config.json'), JSON.stringify({ vaultPath: vaultDir }));

      const result = runCli(['calendar-auth'], { CLAUDIA_HOME: home });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('No Google Calendar client secrets found');
    });
  });
});
