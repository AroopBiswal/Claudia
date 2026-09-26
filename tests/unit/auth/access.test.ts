import { beforeAll, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { createAccessVerifier } from '../../../src/auth/access.ts';
import {
  createAccessKeyFixture,
  signAccessJwtWithUnknownKey,
  type AccessKeyFixture,
} from '../../helpers/access-keys.ts';

const TEAM_DOMAIN = 'myteam.cloudflareaccess.com';
const AUDIENCE = 'test-audience-tag';
const OWNER_EMAIL = 'aroop@example.com';
const ISSUER = `https://${TEAM_DOMAIN}`;

function reqWithHeader(name: string, value: string): Request {
  return { headers: { [name]: value } } as unknown as Request;
}

function reqWithHeaders(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

const noHeadersReq = { headers: {} } as unknown as Request;

describe('createAccessVerifier', () => {
  let fixture: AccessKeyFixture;

  beforeAll(async () => {
    fixture = await createAccessKeyFixture();
  });

  function verifier(overrides: Partial<Parameters<typeof createAccessVerifier>[0]> = {}) {
    return createAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      ownerEmail: OWNER_EMAIL,
      jwks: fixture.jwks,
      ...overrides,
    });
  }

  it('accepts a valid Access JWT for the owner email', async () => {
    const jwt = await fixture.signAccessJwt({ email: OWNER_EMAIL, aud: AUDIENCE, iss: ISSUER });
    const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', jwt));
    expect(result).toEqual({ ok: true, email: OWNER_EMAIL });
  });

  it('matches the owner email case-insensitively', async () => {
    const jwt = await fixture.signAccessJwt({
      email: 'AROOP@Example.com',
      aud: AUDIENCE,
      iss: ISSUER,
    });
    const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', jwt));
    expect(result.ok).toBe(true);
  });

  it('rejects the wrong audience', async () => {
    const jwt = await fixture.signAccessJwt({
      email: OWNER_EMAIL,
      aud: 'some-other-audience',
      iss: ISSUER,
    });
    const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', jwt));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects the wrong issuer', async () => {
    const jwt = await fixture.signAccessJwt({
      email: OWNER_EMAIL,
      aud: AUDIENCE,
      iss: 'https://not-my-team.cloudflareaccess.com',
    });
    const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', jwt));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects a mismatched email', async () => {
    const jwt = await fixture.signAccessJwt({
      email: 'someone-else@example.com',
      aud: AUDIENCE,
      iss: ISSUER,
    });
    const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', jwt));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects an expired token', async () => {
    const jwt = await fixture.signAccessJwt({
      email: OWNER_EMAIL,
      aud: AUDIENCE,
      iss: ISSUER,
      expSeconds: -60,
    });
    const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', jwt));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects a not-yet-valid token', async () => {
    const jwt = await fixture.signAccessJwt({
      email: OWNER_EMAIL,
      aud: AUDIENCE,
      iss: ISSUER,
      notBefore: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', jwt));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects a token with a bad signature', async () => {
    const jwt = await signAccessJwtWithUnknownKey({
      email: OWNER_EMAIL,
      aud: AUDIENCE,
      iss: ISSUER,
    });
    const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', jwt));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects a request with no assertion at all', async () => {
    const result = await verifier().verify(noHeadersReq);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('returns 503 when Access is not configured', async () => {
    const jwt = await fixture.signAccessJwt({ email: OWNER_EMAIL, aud: AUDIENCE, iss: ISSUER });
    const result = await createAccessVerifier({ jwks: fixture.jwks }).verify(
      reqWithHeader('cf-access-jwt-assertion', jwt),
    );
    expect(result).toEqual({
      ok: false,
      status: 503,
      reason: 'Cloudflare Access is not configured for Claudia yet.',
    });
  });

  it('falls back to the CF_Authorization cookie when the header is absent', async () => {
    const jwt = await fixture.signAccessJwt({ email: OWNER_EMAIL, aud: AUDIENCE, iss: ISSUER });
    const result = await verifier().verify(
      reqWithHeaders({ cookie: `other=1; CF_Authorization=${jwt}; more=2` }),
    );
    expect(result).toEqual({ ok: true, email: OWNER_EMAIL });
  });

  it('prefers the header over the cookie when both are present', async () => {
    const goodJwt = await fixture.signAccessJwt({ email: OWNER_EMAIL, aud: AUDIENCE, iss: ISSUER });
    const result = await verifier().verify(
      reqWithHeaders({ 'cf-access-jwt-assertion': goodJwt, cookie: 'CF_Authorization=garbage' }),
    );
    expect(result).toEqual({ ok: true, email: OWNER_EMAIL });
  });
});
