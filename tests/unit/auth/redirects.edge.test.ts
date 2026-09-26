import { describe, expect, it } from 'vitest';
import { isAllowedRedirectUri, redirectUriMatches } from '../../../src/auth/redirects.ts';

describe('isAllowedRedirectUri: bug fix, fragment and userinfo in a loopback redirect_uri', () => {
  it('rejects a loopback redirect_uri carrying a fragment (RFC 6749 3.1.2)', () => {
    expect(isAllowedRedirectUri('http://127.0.0.1:1234/callback#frag')).toBe(false);
  });

  it('rejects a loopback redirect_uri carrying userinfo (user:pass@host)', () => {
    expect(isAllowedRedirectUri('http://user:pass@127.0.0.1:1234/callback')).toBe(false);
  });

  it('rejects a loopback redirect_uri carrying a bare username with no password', () => {
    expect(isAllowedRedirectUri('http://attacker@127.0.0.1:1234/callback')).toBe(false);
  });

  it('still allows a clean loopback redirect_uri', () => {
    expect(isAllowedRedirectUri('http://127.0.0.1:1234/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://[::1]:1234/callback')).toBe(true);
  });
});

describe('isAllowedRedirectUri: hostile hostnames that must never be confused with Claude or loopback', () => {
  it('rejects a plain http callback impersonating the Claude path on a different host', () => {
    expect(isAllowedRedirectUri('http://evil.com/api/mcp/auth_callback')).toBe(false);
  });

  it('rejects a subdomain-confusion host (claude.ai.evil.com)', () => {
    expect(isAllowedRedirectUri('https://claude.ai.evil.com/api/mcp/auth_callback')).toBe(false);
  });

  it('rejects a userinfo-confusion host (claude.ai@evil.com) at registration', () => {
    expect(isAllowedRedirectUri('https://claude.ai@evil.com/api/mcp/auth_callback')).toBe(false);
  });
});

describe('redirectUriMatches: fragment/userinfo on the requested URI at authorize time', () => {
  it('rejects a match when the requested URI (not the registered one) carries a fragment', () => {
    expect(
      redirectUriMatches('http://127.0.0.1:54321/callback#frag', 'http://127.0.0.1:11111/callback'),
    ).toBe(false);
  });

  it('still matches loopback ignoring port with IPv6', () => {
    expect(redirectUriMatches('http://[::1]:54321/callback', 'http://[::1]:11111/callback')).toBe(
      true,
    );
  });
});
