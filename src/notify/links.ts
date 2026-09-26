import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type LinkAction = 'done' | 'snooze1h' | 'tomorrow';

// n: 16 random bytes base64url (nonce, for single use); exp: unix seconds
export interface LinkPayload {
  v: 1;
  a: LinkAction;
  id: string;
  n: string;
  exp: number;
}

export type VerifyResult =
  | { ok: true; payload: LinkPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'unsupported' };

const SIGNATURE_PREFIX = 'claudia-action-v1.';
const MAX_TOKEN_LENGTH = 512;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const ACTIONS: readonly LinkAction[] = ['done', 'snooze1h', 'tomorrow'];
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_TTL_DAYS = 7;

function isLinkAction(value: unknown): value is LinkAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

export function signActionLink(
  key: Buffer,
  opts: { action: LinkAction; id: string; now: Date; ttlDays?: number; nonce?: string },
): string {
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const exp = Math.floor(opts.now.getTime() / 1000) + ttlDays * 86400;
  const nonce = opts.nonce ?? randomBytes(16).toString('base64url');

  const payload: LinkPayload = {
    v: 1,
    a: opts.action,
    id: opts.id,
    n: nonce,
    exp,
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', key)
    .update(SIGNATURE_PREFIX + payloadB64)
    .digest('base64url');

  return `${payloadB64}.${signature}`;
}

export function verifyActionLink(key: Buffer, token: string, opts: { now: Date }): VerifyResult {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'malformed' };
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return { ok: false, reason: 'malformed' };
  }

  const [payloadB64, signatureB64] = parts;
  if (
    !payloadB64 ||
    !signatureB64 ||
    !BASE64URL_PATTERN.test(payloadB64) ||
    !BASE64URL_PATTERN.test(signatureB64)
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const expectedSignature = createHmac('sha256', key)
    .update(SIGNATURE_PREFIX + payloadB64)
    .digest();
  const providedSignature = Buffer.from(signatureB64, 'base64url');

  if (
    expectedSignature.length !== providedSignature.length ||
    !timingSafeEqual(expectedSignature, providedSignature)
  ) {
    return { ok: false, reason: 'bad_signature' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'malformed' };
  }

  const candidate = parsed as Record<string, unknown>;

  if (candidate.v !== 1) {
    return { ok: false, reason: 'unsupported' };
  }
  if (!isLinkAction(candidate.a)) {
    return { ok: false, reason: 'unsupported' };
  }
  if (typeof candidate.id !== 'string' || !ID_PATTERN.test(candidate.id)) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof candidate.n !== 'string' || candidate.n.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof candidate.exp !== 'number' || !Number.isFinite(candidate.exp)) {
    return { ok: false, reason: 'malformed' };
  }

  const nowSeconds = Math.floor(opts.now.getTime() / 1000);
  if (nowSeconds > candidate.exp) {
    return { ok: false, reason: 'expired' };
  }

  return {
    ok: true,
    payload: { v: 1, a: candidate.a, id: candidate.id, n: candidate.n, exp: candidate.exp },
  };
}

export function actionUrl(publicUrl: string, token: string): string {
  const base = publicUrl.endsWith('/') ? publicUrl.slice(0, -1) : publicUrl;
  return `${base}/a/${token}`;
}
