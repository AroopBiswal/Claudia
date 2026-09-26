import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

describe('cli', () => {
  it('prints the version and exits 0 for --version', () => {
    const result = spawnSync(process.execPath, [cliPath, '--version'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints usage and exits 2 for an unknown command', () => {
    const result = spawnSync(process.execPath, [cliPath, 'not-a-real-command'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Usage: claudia');
  });

  it('prints usage and exits 2 with no arguments', () => {
    const result = spawnSync(process.execPath, [cliPath], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Usage: claudia');
  });
});
