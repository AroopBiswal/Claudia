import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  signApprovalRequest,
  verifyApprovalRequest,
  type ApprovalRequest,
} from '../../../src/auth/approval-token.ts';

const signingKey = Buffer.from('unit-test-signing-key-do-not-use-in-prod');

function baseRequest(expiresAt: number): ApprovalRequest {
  return {
    clientId: 'client-1',
    redirectUri: 'http://127.0.0.1:12345/callback',
    codeChallenge: 'challenge-value',
    scope: 'claudia',
    resource: 'https://claudia.example.com/mcp',
    state: 'xyz',
    subject: 'aroop@example.com',
    expiresAt,
  };
}

describe('approval token signing', () => {
  it('round-trips a valid, unexpired request', () => {
    const now = () => new Date(1_000_000);
    const request = baseRequest(1_000_000 + 60_000);
    const token = signApprovalRequest(signingKey, request);
    expect(verifyApprovalRequest(signingKey, token, now)).toEqual(request);
  });

  it('rejects a tampered payload', () => {
    const now = () => new Date(1_000_000);
    const token = signApprovalRequest(signingKey, baseRequest(1_000_000 + 60_000));
    const parts = token.split('.');
    const payload = parts[0]!;
    const mac = parts[1]!;
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as ApprovalRequest;
    decoded.clientId = 'attacker-client';
    const tamperedPayload = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    const tamperedToken = `${tamperedPayload}.${mac}`;
    expect(verifyApprovalRequest(signingKey, tamperedToken, now)).toBeNull();
  });

  it('rejects a token signed with a different key', () => {
    const now = () => new Date(1_000_000);
    const token = signApprovalRequest(
      Buffer.from('a-different-key'),
      baseRequest(1_000_000 + 60_000),
    );
    expect(verifyApprovalRequest(signingKey, token, now)).toBeNull();
  });

  it('rejects an expired request', () => {
    const request = baseRequest(1_000_000);
    const token = signApprovalRequest(signingKey, request);
    const later = () => new Date(1_000_001);
    expect(verifyApprovalRequest(signingKey, token, later)).toBeNull();
  });

  it('accepts a request exactly at its expiry boundary is rejected once now has passed it', () => {
    const request = baseRequest(1_000_000);
    const token = signApprovalRequest(signingKey, request);
    const exactlyAtExpiry = () => new Date(1_000_000);
    expect(verifyApprovalRequest(signingKey, token, exactlyAtExpiry)).toEqual(request);
  });

  it('rejects a malformed token with no separator', () => {
    expect(verifyApprovalRequest(signingKey, 'not-a-valid-token', () => new Date())).toBeNull();
  });

  it('rejects a token whose payload is not valid JSON, even with a correctly matching signature', () => {
    const badPayload = Buffer.from('not json', 'utf8').toString('base64url');
    const mac = createHmac('sha256', signingKey).update(badPayload).digest('base64url');
    const token = `${badPayload}.${mac}`;
    expect(verifyApprovalRequest(signingKey, token, () => new Date())).toBeNull();
  });
});
