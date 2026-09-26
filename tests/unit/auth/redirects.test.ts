import { describe, expect, it } from 'vitest';
import { isAllowedRedirectUri, redirectUriMatches } from '../../../src/auth/redirects.ts';

describe('isAllowedRedirectUri', () => {
  it('allows the claude.ai hosted callback', () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
  });

  it('allows the claude.com hosted callback', () => {
    expect(isAllowedRedirectUri('https://claude.com/api/mcp/auth_callback')).toBe(true);
  });

  it('allows any loopback port and path over http on 127.0.0.1', () => {
    expect(isAllowedRedirectUri('http://127.0.0.1:54321/callback')).toBe(true);
  });

  it('allows any loopback port and path over http on localhost', () => {
    expect(isAllowedRedirectUri('http://localhost:9999/callback')).toBe(true);
  });

  it('allows loopback IPv6', () => {
    expect(isAllowedRedirectUri('http://[::1]:8080/callback')).toBe(true);
  });

  it('allows extraRedirectUris explicitly passed in', () => {
    expect(
      isAllowedRedirectUri('https://example.com/custom-callback', [
        'https://example.com/custom-callback',
      ]),
    ).toBe(true);
  });

  it('rejects an arbitrary https callback not on the allowlist', () => {
    expect(isAllowedRedirectUri('https://evil.example.com/callback')).toBe(false);
  });

  it('rejects https on loopback (only http is allowed for loopback)', () => {
    expect(isAllowedRedirectUri('https://127.0.0.1:1234/callback')).toBe(false);
  });

  it('rejects a non-loopback http URL', () => {
    expect(isAllowedRedirectUri('http://example.com/callback')).toBe(false);
  });

  it('rejects a malformed URI', () => {
    expect(isAllowedRedirectUri('not a url')).toBe(false);
  });

  it('rejects a claude.ai path other than the exact callback', () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/other')).toBe(false);
  });
});

describe('redirectUriMatches', () => {
  it('matches identical non-loopback URIs', () => {
    expect(
      redirectUriMatches(
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.ai/api/mcp/auth_callback',
      ),
    ).toBe(true);
  });

  it('rejects non-loopback URIs that differ at all', () => {
    expect(
      redirectUriMatches(
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.ai/api/mcp/other',
      ),
    ).toBe(false);
  });

  it('matches loopback redirect URIs that differ only by port', () => {
    expect(
      redirectUriMatches('http://127.0.0.1:54321/callback', 'http://127.0.0.1:11111/callback'),
    ).toBe(true);
  });

  it('matches loopback across localhost and 127.0.0.1 only if path matches, hostnames still compared', () => {
    // Different loopback hostnames are NOT the same host, so this should not match.
    expect(
      redirectUriMatches('http://127.0.0.1:54321/callback', 'http://localhost:54321/callback'),
    ).toBe(false);
  });

  it('requires the path to match even on loopback', () => {
    expect(
      redirectUriMatches('http://127.0.0.1:54321/other', 'http://127.0.0.1:11111/callback'),
    ).toBe(false);
  });

  it('rejects a non-loopback registered URI even if the requested one is loopback', () => {
    expect(
      redirectUriMatches(
        'http://127.0.0.1:54321/callback',
        'https://claude.ai/api/mcp/auth_callback',
      ),
    ).toBe(false);
  });
});
