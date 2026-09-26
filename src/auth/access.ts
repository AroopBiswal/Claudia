import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { Request } from 'express';

export interface AccessVerifierOptions {
  /** e.g. "myteam.cloudflareaccess.com" */
  teamDomain?: string;
  audience?: string;
  ownerEmail?: string;
  /** Overrides the default remote JWKS (tests use a local one). */
  jwks?: JWTVerifyGetKey;
}

export type AccessResult =
  { ok: true; email: string } | { ok: false; status: 403 | 503; reason: string };

const NOT_CONFIGURED_REASON = 'Cloudflare Access is not configured for Claudia yet.';

/**
 * Verifies the Cloudflare Access identity on a request: the short-lived JWT Access issues after
 * its own sign-in, found in the `Cf-Access-Jwt-Assertion` header (or the `CF_Authorization`
 * cookie as a fallback), scoped to a single owner email.
 */
export function createAccessVerifier(opts: AccessVerifierOptions) {
  const { teamDomain, audience, ownerEmail } = opts;
  const configured = Boolean(teamDomain) && Boolean(audience) && Boolean(ownerEmail);
  const jwks: JWTVerifyGetKey | undefined =
    opts.jwks ??
    (teamDomain
      ? createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`))
      : undefined);

  async function verify(req: Request): Promise<AccessResult> {
    if (!configured || !jwks || !teamDomain || !audience || !ownerEmail) {
      return { ok: false, status: 503, reason: NOT_CONFIGURED_REASON };
    }

    const token = extractToken(req);
    if (!token) {
      return { ok: false, status: 403, reason: 'Missing Cloudflare Access assertion.' };
    }

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: `https://${teamDomain}`,
        audience,
        algorithms: ['RS256'],
      });

      const email = typeof payload.email === 'string' ? payload.email : undefined;
      if (!email || email.toLowerCase() !== ownerEmail.toLowerCase()) {
        return {
          ok: false,
          status: 403,
          reason: 'Access identity does not match the Claudia owner.',
        };
      }

      return { ok: true, email };
    } catch {
      return { ok: false, status: 403, reason: 'Invalid or expired Cloudflare Access assertion.' };
    }
  }

  return { verify };
}

function extractToken(req: Request): string | null {
  const header = req.headers['cf-access-jwt-assertion'];
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (typeof headerValue === 'string' && headerValue.length > 0) {
    return headerValue;
  }

  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader === 'string') {
    for (const part of cookieHeader.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith('CF_Authorization=')) {
        const value = trimmed.slice('CF_Authorization='.length);
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      }
    }
  }

  return null;
}
