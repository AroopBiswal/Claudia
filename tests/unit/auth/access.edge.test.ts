import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { createLocalJWKSet, exportJWK, exportSPKI, generateKeyPair } from 'jose';
import type { JWK } from 'jose';
import { createAccessVerifier } from '../../../src/auth/access.ts';
import { createAccessKeyFixture, type AccessKeyFixture } from '../../helpers/access-keys.ts';

const TEAM_DOMAIN = 'myteam.cloudflareaccess.com';
const AUDIENCE = 'test-audience-tag';
const OWNER_EMAIL = 'aroop@example.com';
const ISSUER = `https://${TEAM_DOMAIN}`;

function reqWithHeader(name: string, value: string): Request {
  return { headers: { [name]: value } } as unknown as Request;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

describe('createAccessVerifier: token forgery edge cases', () => {
  let fixture: AccessKeyFixture;

  beforeAll(async () => {
    fixture = await createAccessKeyFixture();
  });

  function verifier() {
    return createAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      ownerEmail: OWNER_EMAIL,
      jwks: fixture.jwks,
    });
  }

  it('rejects a token with alg: none and no signature', async () => {
    const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({
        email: OWNER_EMAIL,
        iss: ISSUER,
        aud: AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const token = `${header}.${payload}.`;
    const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', token));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects an HS256 token signed with the RSA public key PEM bytes (algorithm-confusion attack)', async () => {
    // Classic RS256 -> HS256 downgrade: the RSA public key is, by definition, public. A verifier
    // that dynamically trusted the JWT's own "alg" header (instead of pinning one) could be
    // tricked into treating that public key's bytes as an HMAC-SHA256 shared secret, since a
    // correctly-computed HMAC over attacker-chosen claims would "verify". Build a fresh key pair
    // so we control (and can export) the exact public key bytes, register it the same way the
    // real verifier registers Access's JWKS, then attempt exactly this downgrade against it.
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    void privateKey; // unused: the attack never touches the private key
    const kid = 'confusion-key';
    const jwk: JWK = await exportJWK(publicKey);
    jwk.kid = kid;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const confusionJwks = createLocalJWKSet({ keys: [jwk] });
    const confusionVerifier = createAccessVerifier({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      ownerEmail: OWNER_EMAIL,
      jwks: confusionJwks,
    });

    const publicKeyPem = await exportSPKI(publicKey);
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid }));
    const payload = base64url(
      JSON.stringify({
        email: OWNER_EMAIL,
        iss: ISSUER,
        aud: AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const signature = createHmac('sha256', Buffer.from(publicKeyPem, 'utf8'))
      .update(`${header}.${payload}`)
      .digest();
    const token = `${header}.${payload}.${base64url(signature)}`;

    const result = await confusionVerifier.verify(reqWithHeader('cf-access-jwt-assertion', token));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects a validly-signed token whose kid is not present in the JWKS', async () => {
    const jwt = await fixture.signAccessJwt({
      email: OWNER_EMAIL,
      aud: AUDIENCE,
      iss: ISSUER,
      kid: 'some-other-key-id-not-in-the-jwks',
    });
    const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', jwt));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects a validly-signed token with the email claim missing entirely', async () => {
    const jwt = await fixture.signAccessJwt({
      // Casting past the required-string type to exercise the "no email at all" wire case: jose's
      // SignJWT payload drops keys whose value is undefined, so the claim is genuinely absent.
      email: undefined as unknown as string,
      aud: AUDIENCE,
      iss: ISSUER,
    });
    const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', jwt));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('accepts an audience claim that is an array containing the configured audience', async () => {
    const jwt = await fixture.signAccessJwt({
      email: OWNER_EMAIL,
      aud: [AUDIENCE, 'some-other-audience'] as unknown as string,
      iss: ISSUER,
    });
    const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', jwt));
    expect(result).toEqual({ ok: true, email: OWNER_EMAIL });
  });

  it('rejects an audience array that does not contain the configured audience', async () => {
    const jwt = await fixture.signAccessJwt({
      email: OWNER_EMAIL,
      aud: ['some-other-audience', 'yet-another'] as unknown as string,
      iss: ISSUER,
    });
    const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', jwt));
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  describe('clock skew on exp/nbf: no grace period is configured (documented current behaviour)', () => {
    it('rejects a token that expired 30 seconds ago', async () => {
      const jwt = await fixture.signAccessJwt({
        email: OWNER_EMAIL,
        aud: AUDIENCE,
        iss: ISSUER,
        expSeconds: -30,
      });
      const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', jwt));
      expect(result).toMatchObject({ ok: false, status: 403 });
    });

    it('rejects a token that only becomes valid 30 seconds from now (nbf in the near future)', async () => {
      const jwt = await fixture.signAccessJwt({
        email: OWNER_EMAIL,
        aud: AUDIENCE,
        iss: ISSUER,
        notBefore: Math.floor(Date.now() / 1000) + 30,
      });
      const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', jwt));
      expect(result).toMatchObject({ ok: false, status: 403 });
    });

    it('accepts a token comfortably within its validity window (control case)', async () => {
      const jwt = await fixture.signAccessJwt({ email: OWNER_EMAIL, aud: AUDIENCE, iss: ISSUER });
      const result = await verifier().verify(reqWithHeader('cf-access-jwt-assertion', jwt));
      expect(result).toEqual({ ok: true, email: OWNER_EMAIL });
    });
  });
});
