import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The validated /oauth/authorize parameters, carried through the approval page as a signed,
 * short-lived, opaque token so that /oauth/approve never has to trust client-supplied data.
 */
export interface ApprovalRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string | null;
  state?: string;
  subject: string;
  /** Epoch milliseconds after which the approval token must be rejected. */
  expiresAt: number;
}

/** HMAC-SHA256 signs the approval request as `base64url(json).base64url(mac)`. */
export function signApprovalRequest(signingKey: Buffer, request: ApprovalRequest): string {
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
  const mac = createHmac('sha256', signingKey).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

/** Verifies signature and expiry; returns null for a tampered, malformed or expired token. */
export function verifyApprovalRequest(
  signingKey: Buffer,
  token: string,
  now: () => Date,
): ApprovalRequest | null {
  const separatorIndex = token.indexOf('.');
  if (separatorIndex < 0) return null;

  const payload = token.slice(0, separatorIndex);
  const mac = token.slice(separatorIndex + 1);
  if (payload.length === 0 || mac.length === 0) return null;

  const expectedMac = createHmac('sha256', signingKey).update(payload).digest('base64url');
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expectedMac);
  if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!isApprovalRequest(parsed)) return null;
  if (parsed.expiresAt < now().getTime()) return null;

  return parsed;
}

function isApprovalRequest(value: unknown): value is ApprovalRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.clientId === 'string' &&
    typeof v.redirectUri === 'string' &&
    typeof v.codeChallenge === 'string' &&
    typeof v.scope === 'string' &&
    (typeof v.resource === 'string' || v.resource === null) &&
    (v.state === undefined || typeof v.state === 'string') &&
    typeof v.subject === 'string' &&
    typeof v.expiresAt === 'number'
  );
}
