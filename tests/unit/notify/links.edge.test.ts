import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signActionLink, verifyActionLink, type LinkPayload } from '../../../src/notify/links.ts';

const KEY = Buffer.from('a'.repeat(32), 'utf8');
const NOW = new Date('2026-09-26T18:00:00Z');

function craftToken(key: Buffer, payload: unknown): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', key)
    .update(`claudia-action-v1.${payloadB64}`)
    .digest('base64url');
  return `${payloadB64}.${signature}`;
}

function validPayload(overrides: Partial<LinkPayload> = {}): LinkPayload {
  return {
    v: 1,
    a: 'done',
    id: 't9x2k',
    n: 'a-nonce',
    exp: Math.floor(NOW.getTime() / 1000) + 1000,
    ...overrides,
  };
}

describe('verifyActionLink: id length and character boundary', () => {
  it('accepts a 64-character id (the maximum)', () => {
    const id = 'a'.repeat(64);
    const token = craftToken(KEY, validPayload({ id }));
    const result = verifyActionLink(KEY, token, { now: NOW });
    expect(result).toEqual({ ok: true, payload: validPayload({ id }) });
  });

  it('rejects a 65-character id (one over the maximum)', () => {
    const id = 'a'.repeat(65);
    const token = craftToken(KEY, validPayload({ id }));
    const result = verifyActionLink(KEY, token, { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an id containing a slash', () => {
    const token = craftToken(KEY, validPayload({ id: 't9x2k/extra' }));
    expect(verifyActionLink(KEY, token, { now: NOW })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects an id containing ".."', () => {
    const token = craftToken(KEY, validPayload({ id: '../../etc' }));
    expect(verifyActionLink(KEY, token, { now: NOW })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects an id containing unicode characters', () => {
    const token = craftToken(KEY, validPayload({ id: 't9x2k-café' }));
    expect(verifyActionLink(KEY, token, { now: NOW })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects an empty id', () => {
    const token = craftToken(KEY, validPayload({ id: '' }));
    expect(verifyActionLink(KEY, token, { now: NOW })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('verifyActionLink: token structure', () => {
  it('rejects a token with three segments (extra dot)', () => {
    const token = signActionLink(KEY, { action: 'done', id: 't9x2k', now: NOW });
    const result = verifyActionLink(KEY, `${token}.extra`, { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a token with only one segment (missing dot)', () => {
    const token = signActionLink(KEY, { action: 'done', id: 't9x2k', now: NOW });
    const [payloadOnly] = token.split('.');
    const result = verifyActionLink(KEY, payloadOnly!, { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an empty-string token', () => {
    expect(verifyActionLink(KEY, '', { now: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('verifyActionLink: extra JSON fields are ignored but do not break verification', () => {
  it('verifies successfully and drops fields not in the payload shape', () => {
    const payloadWithExtra = {
      ...validPayload(),
      extraField: 'should be ignored',
      nested: { a: 1 },
    };
    const token = craftToken(KEY, payloadWithExtra);
    const result = verifyActionLink(KEY, token, { now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual(validPayload());
      expect(result.payload).not.toHaveProperty('extraField');
      expect(result.payload).not.toHaveProperty('nested');
    }
  });
});

describe('signActionLink: nonce uniqueness', () => {
  it('produces 10,000 unique nonces', () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const token = signActionLink(KEY, { action: 'done', id: 't9x2k', now: NOW });
      const result = verifyActionLink(KEY, token, { now: NOW });
      if (!result.ok) throw new Error('expected a valid token while checking nonce uniqueness');
      nonces.add(result.payload.n);
    }
    expect(nonces.size).toBe(10_000);
  });
});
