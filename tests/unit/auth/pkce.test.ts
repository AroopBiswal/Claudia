import { describe, expect, it } from 'vitest';
import { verifyPkceS256 } from '../../../src/auth/pkce.ts';

describe('verifyPkceS256', () => {
  it('accepts the RFC 7636 appendix B test vector', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it('rejects a verifier that does not hash to the challenge', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(verifyPkceS256(verifier, 'not-the-right-challenge')).toBe(false);
  });

  it('rejects a verifier for a completely different challenge', () => {
    expect(
      verifyPkceS256(
        'some-other-verifier-value-1234567890',
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      ),
    ).toBe(false);
  });

  it('rejects an empty challenge', () => {
    expect(verifyPkceS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', '')).toBe(false);
  });
});
