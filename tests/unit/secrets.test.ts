import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateSecret, readSecretText } from '../../src/secrets.ts';

describe('loadOrCreateSecret', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claudia-secrets-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a new secret with the requested byte length', () => {
    const path = join(dir, 'nested', 'secret.key');
    const secret = loadOrCreateSecret(path, 32);
    expect(secret).toHaveLength(32);
    expect(readFileSync(path)).toEqual(secret);
  });

  it('creates the parent directory with mode 0700', () => {
    const path = join(dir, 'nested', 'secret.key');
    loadOrCreateSecret(path);
    const stat = statSync(join(dir, 'nested'));
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('creates the secret file with mode 0600', () => {
    const path = join(dir, 'secret.key');
    loadOrCreateSecret(path);
    const stat = statSync(path);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('returns the same secret on a second call instead of overwriting it', () => {
    const path = join(dir, 'secret.key');
    const first = loadOrCreateSecret(path);
    const second = loadOrCreateSecret(path);
    expect(second).toEqual(first);
  });

  it('defaults to 32 bytes', () => {
    const path = join(dir, 'secret.key');
    expect(loadOrCreateSecret(path)).toHaveLength(32);
  });

  it('supports a custom byte length', () => {
    const path = join(dir, 'secret.key');
    expect(loadOrCreateSecret(path, 64)).toHaveLength(64);
  });
});

describe('readSecretText', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claudia-secrets-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', () => {
    expect(readSecretText(join(dir, 'missing.txt'))).toBeNull();
  });

  it('trims trailing whitespace from the file contents', () => {
    const path = join(dir, 'token.txt');
    writeFileSync(path, 'my-secret-value\n', { mode: 0o600 });
    expect(readSecretText(path)).toBe('my-secret-value');
  });
});
