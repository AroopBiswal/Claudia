import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configFromObject, loadConfig } from '../../src/config.ts';

describe('config', () => {
  it('applies defaults and derives paths under home', () => {
    const c = configFromObject('/h', { vaultPath: '/v' });
    expect(c.port).toBe(8787);
    expect(c.host).toBe('127.0.0.1');
    expect(c.vaultName).toBe('Claudia');
    expect(c.publicUrl).toBe('https://claudia.aroopbiswal.com');
    expect(c.paths.stateDb).toBe('/h/state.db');
    expect(c.ntfy.tokenFile).toBe('/h/secrets/ntfy-token');
    expect(c.access).toEqual({ teamDomain: null, audience: null });
  });

  it('requires a vault path and rejects unknown keys', () => {
    expect(() => configFromObject('/h', {})).toThrow(/Invalid Claudia config/);
    expect(() => configFromObject('/h', { vaultPath: '/v', devBypass: true })).toThrow();
  });

  it('lets env override vault, port and public URL', () => {
    const c = configFromObject(
      '/h',
      { vaultPath: '/v' },
      {
        CLAUDIA_VAULT: '/other',
        CLAUDIA_PORT: '9999',
        CLAUDIA_PUBLIC_URL: 'https://example.test/',
      },
    );
    expect(c.vaultPath).toBe('/other');
    expect(c.port).toBe(9999);
    expect(c.publicUrl).toBe('https://example.test');
  });

  it('loads config.json from CLAUDIA_HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'claudia-config-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ vaultPath: '/v', port: 8800 }));
    const c = loadConfig({ CLAUDIA_HOME: home });
    expect(c.home).toBe(home);
    expect(c.port).toBe(8800);
  });
});
