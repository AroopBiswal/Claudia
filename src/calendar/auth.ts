// The one-time, human-run OAuth flow that connects Claudia to Google Calendar, using the
// installed-app loopback pattern (RFC 8252) with PKCE (RFC 7636), scoped to
// https://www.googleapis.com/auth/calendar.app.created only.
//
// Sources consulted:
// - OAuth 2.0 for iOS & Desktop Apps (loopback redirect, PKCE, access_type/prompt)
//   https://developers.google.com/identity/protocols/oauth2/native-app
// - Downloaded "Desktop app" client JSON shape ({"installed": {...}})
//   https://github.com/googleapis/google-api-python-client/blob/main/docs/client-secrets.md
// - Token endpoint https://oauth2.googleapis.com/token (authorization_code grant)
// - RFC 7636 (PKCE: code_verifier / code_challenge / S256), RFC 8252 (loopback interaction)

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GoogleClientSecrets, TokenStore } from './google.ts';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

function generateVerifier(): string {
  return base64url(randomBytes(32));
}

function codeChallengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

function generateState(): string {
  return base64url(randomBytes(16));
}

function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function successPage(): string {
  return '<!doctype html><html><body><p>Claudia can now use your Claudia calendar. You can close this tab.</p></body></html>';
}

function errorPage(message: string): string {
  return `<!doctype html><html><body><p>Claudia sign-in failed: ${escapeHtml(message)} You can close this tab and try again.</p></body></html>`;
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

export async function runCalendarAuth(opts: {
  secrets: GoogleClientSecrets;
  tokens: TokenStore;
  openUrl: (url: string) => void | Promise<void>;
  log: (line: string) => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
  port?: number;
}): Promise<void> {
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const verifier = generateVerifier();
  const challenge = codeChallengeFor(verifier);
  const state = generateState();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let redirectUri = '';

    const server = createServer((req, res) => {
      void handleRequest(req, res);
    });

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close();
      action();
    }

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (settled) {
        res.writeHead(410).end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const params = url.searchParams;
      const errorParam = params.get('error');
      if (errorParam) {
        sendHtml(res, 400, errorPage(`Google sign-in was cancelled (${errorParam}).`));
        finish(() => {
          reject(new Error(`Google sign-in failed: ${errorParam}`));
        });
        return;
      }

      const returnedState = params.get('state');
      if (returnedState !== state) {
        sendHtml(res, 400, errorPage('The sign-in state did not match.'));
        finish(() => {
          reject(new Error('OAuth state mismatch; aborting Google Calendar sign-in.'));
        });
        return;
      }

      const code = params.get('code');
      if (!code) {
        sendHtml(res, 400, errorPage('Google did not return an authorization code.'));
        finish(() => {
          reject(new Error('Google did not return an authorization code.'));
        });
        return;
      }

      try {
        const tokenRes = await fetchImpl(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: opts.secrets.client_id,
            client_secret: opts.secrets.client_secret,
            redirect_uri: redirectUri,
            code_verifier: verifier,
          }).toString(),
        });

        if (!tokenRes.ok) {
          sendHtml(res, 400, errorPage('Failed to exchange the authorization code.'));
          finish(() => {
            reject(
              new Error(
                `Failed to exchange the authorization code: HTTP ${String(tokenRes.status)}`,
              ),
            );
          });
          return;
        }

        const body = (await tokenRes.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in: number;
          scope?: string;
        };

        if (!body.refresh_token) {
          sendHtml(res, 400, errorPage('Google did not grant offline access.'));
          finish(() => {
            reject(
              new Error(
                'Google did not return a refresh token. Revoke Claudia at https://myaccount.google.com/permissions and try again.',
              ),
            );
          });
          return;
        }

        await opts.tokens.save({
          access_token: body.access_token,
          refresh_token: body.refresh_token,
          expiry: Date.now() + body.expires_in * 1000,
          scope: body.scope ?? SCOPE,
        });

        sendHtml(res, 200, successPage());
        finish(resolve);
      } catch (err) {
        sendHtml(res, 500, errorPage('Unexpected error completing sign-in.'));
        finish(() => {
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      }
    }

    server.on('error', (err) => {
      finish(() => {
        reject(err);
      });
    });

    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        finish(() => {
          reject(new Error('Failed to start the loopback OAuth server.'));
        });
        return;
      }

      redirectUri = `http://127.0.0.1:${String(address.port)}/callback`;
      const authUrl = buildAuthUrl(opts.secrets.client_id, redirectUri, challenge, state);
      opts.log(authUrl);
      Promise.resolve(opts.openUrl(authUrl)).catch((err: unknown) => {
        opts.log(`Could not open the browser automatically: ${String(err)}`);
      });

      timer = setTimeout(() => {
        finish(() => {
          reject(new Error('Timed out waiting for Google sign-in.'));
        });
      }, timeoutMs);
    });
  });
}
