import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { CryptoKey, JWK, JWTVerifyGetKey } from 'jose';

export interface SignAccessJwtOptions {
  email: string;
  aud: string;
  iss: string;
  /** Seconds from now until expiry; negative produces an already-expired token. Default 3600. */
  expSeconds?: number;
  kid?: string;
  /** Epoch seconds; when set in the future, produces a not-yet-valid token. */
  notBefore?: number;
}

export interface AccessKeyFixture {
  jwks: JWTVerifyGetKey;
  kid: string;
  signAccessJwt(opts: SignAccessJwtOptions): Promise<string>;
}

/**
 * Generates an RS256 key pair and exposes it as a local JWKS (mirroring Cloudflare Access's
 * `/cdn-cgi/access/certs` JWKS), plus a helper to mint test Access JWTs signed by it.
 */
export async function createAccessKeyFixture(kid = 'test-key-1'): Promise<AccessKeyFixture> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  const jwks = createLocalJWKSet({ keys: [jwk] });

  async function signAccessJwt(opts: SignAccessJwtOptions): Promise<string> {
    return signWithKey(privateKey, opts.kid ?? kid, opts);
  }

  return { jwks, kid, signAccessJwt };
}

/** Signs a JWT with an arbitrary (e.g. attacker-controlled) key, for bad-signature tests. */
export async function signAccessJwtWithUnknownKey(opts: SignAccessJwtOptions): Promise<string> {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  return signWithKey(privateKey, opts.kid ?? 'unknown-key', opts);
}

async function signWithKey(
  privateKey: CryptoKey,
  kid: string,
  opts: SignAccessJwtOptions,
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT({ email: opts.email })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt(nowSeconds)
    .setIssuer(opts.iss)
    .setAudience(opts.aud)
    .setExpirationTime(nowSeconds + (opts.expSeconds ?? 3600));

  if (opts.notBefore !== undefined) {
    jwt = jwt.setNotBefore(opts.notBefore);
  }

  return jwt.sign(privateKey);
}
