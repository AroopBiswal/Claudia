import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { actionUrl, signActionLink, verifyActionLink } from '../../../src/notify/links.ts';

const KEY = Buffer.from('a'.repeat(32), 'utf8');
const OTHER_KEY = Buffer.from('b'.repeat(32), 'utf8');
const NOW = new Date('2026-09-26T18:00:00Z');

function craftToken(key: Buffer, payload: unknown): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', key)
    .update(`claudia-action-v1.${payloadB64}`)
    .digest('base64url');
  return `${payloadB64}.${signature}`;
}

describe('signActionLink / verifyActionLink', () => {
  it('round trips a signed token', () => {
    const token = signActionLink(KEY, { action: 'done', id: 't9x2k', now: NOW });
    const result = verifyActionLink(KEY, token, { now: NOW });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toMatchObject({ v: 1, a: 'done', id: 't9x2k' });
      expect(result.payload.exp).toBe(Math.floor(NOW.getTime() / 1000) + 7 * 86400);
      expect(typeof result.payload.n).toBe('string');
      expect(result.payload.n.length).toBeGreaterThan(0);
    }
  });

  it('respects a custom ttl and nonce', () => {
    const token = signActionLink(KEY, {
      action: 'snooze1h',
      id: 'abc-1',
      now: NOW,
      ttlDays: 1,
      nonce: 'fixed-nonce',
    });
    const result = verifyActionLink(KEY, token, { now: NOW });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.n).toBe('fixed-nonce');
      expect(result.payload.exp).toBe(Math.floor(NOW.getTime() / 1000) + 86400);
    }
  });

  it('rejects a token whose payload was tampered with (id changed)', () => {
    const token = signActionLink(KEY, { action: 'done', id: 't9x2k', now: NOW });
    const [payloadB64, sig] = token.split('.');
    const tamperedPayload = JSON.parse(
      Buffer.from(payloadB64!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    tamperedPayload.id = 'someone-else';
    const tamperedB64 = Buffer.from(JSON.stringify(tamperedPayload), 'utf8').toString('base64url');
    const tamperedToken = `${tamperedB64}.${sig}`;

    const result = verifyActionLink(KEY, tamperedToken, { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a token with a tampered signature', () => {
    const token = signActionLink(KEY, { action: 'done', id: 't9x2k', now: NOW });
    const [payloadB64, sig] = token.split('.');
    const flippedChar = sig![0] === 'A' ? 'B' : 'A';
    const tamperedSig = flippedChar + sig!.slice(1);
    const tamperedToken = `${payloadB64}.${tamperedSig}`;

    const result = verifyActionLink(KEY, tamperedToken, { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a token whose action was swapped without re-signing', () => {
    const token = signActionLink(KEY, { action: 'done', id: 't9x2k', now: NOW });
    const [payloadB64, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    payload.a = 'tomorrow';
    const swappedB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const swappedToken = `${swappedB64}.${sig}`;

    const result = verifyActionLink(KEY, swappedToken, { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('is valid exactly at the expiry second and expired one second later', () => {
    const token = signActionLink(KEY, { action: 'done', id: 't9x2k', now: NOW, ttlDays: 7 });
    const expSeconds = Math.floor(NOW.getTime() / 1000) + 7 * 86400;

    const atExpiry = verifyActionLink(KEY, token, { now: new Date(expSeconds * 1000) });
    expect(atExpiry.ok).toBe(true);

    const afterExpiry = verifyActionLink(KEY, token, { now: new Date((expSeconds + 1) * 1000) });
    expect(afterExpiry).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token signed with a different key', () => {
    const token = signActionLink(KEY, { action: 'done', id: 't9x2k', now: NOW });
    const result = verifyActionLink(OTHER_KEY, token, { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a malformed token with no dot', () => {
    const result = verifyActionLink(KEY, 'not-a-real-token', { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a malformed token with invalid base64url characters', () => {
    const result = verifyActionLink(KEY, 'not!valid!base64.also!bad', { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an oversized token', () => {
    const huge = `${'A'.repeat(600)}.${'B'.repeat(50)}`;
    const result = verifyActionLink(KEY, huge, { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a token whose id does not match the allowed pattern', () => {
    const token = craftToken(KEY, {
      v: 1,
      a: 'done',
      id: 'bad id with spaces!',
      n: 'nonce',
      exp: Math.floor(NOW.getTime() / 1000) + 1000,
    });
    const result = verifyActionLink(KEY, token, { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an unsupported version', () => {
    const token = craftToken(KEY, {
      v: 2,
      a: 'done',
      id: 't9x2k',
      n: 'nonce',
      exp: Math.floor(NOW.getTime() / 1000) + 1000,
    });
    const result = verifyActionLink(KEY, token, { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('rejects an unsupported action', () => {
    const token = craftToken(KEY, {
      v: 1,
      a: 'delete-everything',
      id: 't9x2k',
      n: 'nonce',
      exp: Math.floor(NOW.getTime() / 1000) + 1000,
    });
    const result = verifyActionLink(KEY, token, { now: NOW });
    expect(result).toEqual({ ok: false, reason: 'unsupported' });
  });
});

describe('actionUrl', () => {
  it('joins the public url and token without duplicating slashes', () => {
    expect(actionUrl('https://claudia.example.com', 'tok123')).toBe(
      'https://claudia.example.com/a/tok123',
    );
    expect(actionUrl('https://claudia.example.com/', 'tok123')).toBe(
      'https://claudia.example.com/a/tok123',
    );
  });
});
