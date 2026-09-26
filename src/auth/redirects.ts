/**
 * Redirect URI allowlist for OAuth dynamic client registration and authorization.
 *
 * Claude's hosted apps always redirect to one of two fixed HTTPS callbacks. Claude Code (and
 * other local clients) use a loopback redirect on an ephemeral port, which RFC 8252 says must be
 * matched ignoring the port number.
 */
export const CLAUDE_HOSTED_CALLBACKS: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '');
}

function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isLoopbackHttpUrl(url: URL): boolean {
  // RFC 6749 3.1.2 forbids a fragment in the redirect_uri; userinfo (user:pass@host) has no
  // legitimate use here and, left unchecked, is an easy way to smuggle unexpected characters
  // into a URI that otherwise parses as an allowed loopback host.
  if (url.hash !== '' || url.username !== '' || url.password !== '') return false;
  return url.protocol === 'http:' && isLoopbackHost(url.hostname);
}

/** Whether `uri` may be registered as a redirect_uri for a new OAuth client. */
export function isAllowedRedirectUri(
  uri: string,
  extraRedirectUris: readonly string[] = [],
): boolean {
  if (CLAUDE_HOSTED_CALLBACKS.includes(uri) || extraRedirectUris.includes(uri)) return true;

  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }

  return isLoopbackHttpUrl(url);
}

/**
 * Whether an authorization request's redirect_uri matches one the client registered.
 * Loopback redirects match ignoring port (RFC 8252 section 7.3); everything else must match
 * exactly.
 */
export function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;

  let requestedUrl: URL;
  let registeredUrl: URL;
  try {
    requestedUrl = new URL(requested);
    registeredUrl = new URL(registered);
  } catch {
    return false;
  }

  if (!isLoopbackHttpUrl(requestedUrl) || !isLoopbackHttpUrl(registeredUrl)) return false;
  if (normalizeHost(requestedUrl.hostname) !== normalizeHost(registeredUrl.hostname)) return false;

  return (
    requestedUrl.pathname === registeredUrl.pathname && requestedUrl.search === registeredUrl.search
  );
}
