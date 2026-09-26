// End-to-end MCP integration test: a real HTTP server (src/main.ts
// startService), a real MCP client (@modelcontextprotocol/sdk/client) over
// Streamable HTTP, and the full OAuth dance (401 discovery, DCR, Access
// approval, PKCE token exchange, refresh rotation and reuse detection),
// against a scratch vault. Mirrors tests/integration/oauth.test.ts's OAuth
// patterns, extended through the MCP layer itself.

import { createHash } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { configFromObject } from '../../src/config.ts';
import { startService, type RunningService } from '../../src/main.ts';
import { seedVault } from '../../src/ops/seed.ts';
import { SERVER_INSTRUCTIONS } from '../../src/http/mcp.ts';
import { createAccessKeyFixture, type AccessKeyFixture } from '../helpers/access-keys.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { startFakeNtfy, type FakeNtfy } from '../helpers/fake-ntfy.ts';

const TEAM_DOMAIN = 'myteam.cloudflareaccess.com';
const AUDIENCE = 'claudia-test-audience';
const OWNER_EMAIL = 'aroop@example.com';
const ISSUER = `https://${TEAM_DOMAIN}`;
const NTFY_TOKEN = 'test-ntfy-token-do-not-use';

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('failed to reserve a port')));
      }
    });
  });
}

function extractSignedRequest(html: string): string {
  const match = /name="request" value="([^"]+)"/.exec(html);
  if (!match?.[1]) throw new Error(`could not find signed request field in:\n${html}`);
  return match[1];
}

interface StructuredCaptureItem {
  index: number;
  status: string;
  kind: string;
  id?: string;
  note?: string;
  reason?: string;
  calendar?: string;
}

describe('MCP layer over real HTTP (integration)', () => {
  let home: string;
  let vaultDir: string;
  let publicUrl: string;
  let port: number;
  let accessKeys: AccessKeyFixture;
  let fakeNtfy: FakeNtfy;
  let clock: FakeClock;
  let service: RunningService;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'claudia-home-'));
    vaultDir = await mkdtemp(join(tmpdir(), 'claudia-vault-'));
    await seedVault(vaultDir);

    accessKeys = await createAccessKeyFixture();
    fakeNtfy = await startFakeNtfy({ token: NTFY_TOKEN });
    port = await reservePort();
    publicUrl = `http://127.0.0.1:${String(port)}`;

    const config = configFromObject(
      home,
      {
        vaultPath: vaultDir,
        vaultName: 'ClaudiaTest',
        host: '127.0.0.1',
        port,
        publicUrl,
        ownerEmail: OWNER_EMAIL,
        access: { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
        ntfy: { baseUrl: fakeNtfy.url, topic: 'claudia-test-topic' },
        quietMs: 0,
      },
      {},
    );

    await mkdir(join(home, 'secrets'), { recursive: true, mode: 0o700 });
    await writeFile(config.ntfy.tokenFile, NTFY_TOKEN, 'utf8');

    clock = new FakeClock('2026-09-26T17:00:00Z'); // Sat 2026-09-26 10:00 America/Los_Angeles

    service = await startService(config, {
      clock,
      accessJwks: accessKeys.jwks,
      watch: false,
    });

    expect(service.url).toBe(publicUrl);
  });

  afterAll(async () => {
    await service.stop();
    await fakeNtfy.close();
    await rm(home, { recursive: true, force: true });
    await rm(vaultDir, { recursive: true, force: true });
  });

  function accessJwt(): Promise<string> {
    return accessKeys.signAccessJwt({ email: OWNER_EMAIL, aud: AUDIENCE, iss: ISSUER });
  }

  async function readVaultFile(relPath: string): Promise<string> {
    return readFile(join(vaultDir, relPath), 'utf8');
  }

  // --- OAuth: 401 discovery, DCR, Access approval, PKCE token exchange -----------------------

  it('rejects an unauthenticated /mcp POST with 401 and a resource_metadata challenge', async () => {
    const res = await fetch(`${publicUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const header = res.headers.get('www-authenticate');
    expect(header).toContain(
      `resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(header).not.toContain('error=');
  });

  let clientId: string;
  const redirectUri = 'http://127.0.0.1:59991/callback';
  const verifier = 'integration-test-code-verifier-1234567890-abcdefghijklmno';
  const challenge = pkceChallenge(verifier);

  it('serves protected resource metadata matching the mcp resource', async () => {
    const res = await fetch(`${publicUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string };
    expect(body.resource).toBe(`${publicUrl}/mcp`);
  });

  it('registers a client via dynamic client registration', async () => {
    const res = await fetch(`${publicUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        client_name: 'Claudia MCP test client',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string };
    clientId = body.client_id;
  });

  let accessToken: string;
  let refreshToken: string;

  it('authorizes with the Access JWT, approves, and exchanges the code for tokens', async () => {
    const authorizeUrl = new URL(`${publicUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('resource', `${publicUrl}/mcp`);
    authorizeUrl.searchParams.set('state', 'integration-state');

    const jwt = await accessJwt();
    const authorizeRes = await fetch(authorizeUrl, {
      headers: { 'cf-access-jwt-assertion': jwt },
    });
    expect(authorizeRes.status).toBe(200);
    const html = await authorizeRes.text();
    expect(html).toContain('Approve');
    const signedRequest = extractSignedRequest(html);

    const approveRes = await fetch(`${publicUrl}/oauth/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'cf-access-jwt-assertion': jwt,
      },
      body: new URLSearchParams({ request: signedRequest, decision: 'approve' }).toString(),
    });
    expect(approveRes.status).toBe(302);
    const location = new URL(approveRes.headers.get('location')!);
    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenRes = await fetch(`${publicUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as { access_token: string; refresh_token: string };
    accessToken = body.access_token;
    refreshToken = body.refresh_token;
    expect(accessToken).toEqual(expect.any(String));
    expect(refreshToken).toEqual(expect.any(String));
  });

  it('rejects GET and DELETE on /mcp with 405 and Allow: POST once authenticated', async () => {
    const getRes = await fetch(`${publicUrl}/mcp`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(getRes.status).toBe(405);
    expect(getRes.headers.get('allow')).toBe('POST');
    const getBody = (await getRes.json()) as { jsonrpc: string; error: { code: number } };
    expect(getBody.jsonrpc).toBe('2.0');
    expect(getBody.error.code).toBe(-32000);

    const deleteRes = await fetch(`${publicUrl}/mcp`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(deleteRes.status).toBe(405);
    expect(deleteRes.headers.get('allow')).toBe('POST');
  });

  // --- MCP client: connect, initialize, list tools ------------------------------------------

  let client: Client;

  function makeClient(token: string): { client: Client; transport: StreamableHTTPClientTransport } {
    const transport = new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const c = new Client({ name: 'claudia-integration-test', version: '0.0.0' });
    return { client: c, transport };
  }

  it('connects the MCP client with the bearer token and receives the server instructions', async () => {
    const made = makeClient(accessToken);
    client = made.client;
    await client.connect(made.transport);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });

  it('lists exactly the five documented tools with their annotations', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect([...byName.keys()].sort()).toEqual(['agenda', 'capture', 'notify', 'recall', 'update']);

    expect(byName.get('capture')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName.get('recall')?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(byName.get('agenda')?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(byName.get('update')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName.get('notify')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });

    expect(byName.get('capture')?.inputSchema.required).toContain('items');
    expect(byName.get('agenda')?.inputSchema.required).toContain('view');
    expect(byName.get('update')?.inputSchema.required).toContain('action');
    expect(byName.get('notify')?.inputSchema.required).toContain('message');
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.description!.length).toBeLessThan(900);
    }
  });

  // --- capture --------------------------------------------------------------------------------

  let taskId: string;
  let followUpId: string;
  let appointmentId: string;
  let factId: string;

  it('captures a task, follow-up, appointment and fact, and refuses a sensitive item', async () => {
    const result = await client.callTool({
      name: 'capture',
      arguments: {
        items: [
          { kind: 'task', text: 'Call the dentist', remind_at: 'tuesday 09:00' },
          {
            kind: 'follow_up',
            text: 'send the proposal',
            person: 'Alex Rivera',
            direction: 'promised',
          },
          { kind: 'appointment', text: 'Dentist appointment', start: 'wednesday 15:00' },
          { kind: 'fact', text: 'Allergic to penicillin', topic: 'Health' },
          { kind: 'task', text: 'my password is hunter2' },
        ],
        surface: 'iPhone chat',
      },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toBe('Reminder set: Tue 9:00am.');

    const structured = result.structuredContent as {
      receipt?: string;
      results: StructuredCaptureItem[];
    };
    expect(structured.receipt).toBe('Reminder set: Tue 9:00am.');
    expect(structured.results).toHaveLength(5);

    const [task, followUp, appointment, fact, refused] = structured.results;
    expect(task!.status).toBe('saved');
    expect(task!.kind).toBe('task');
    taskId = task!.id!;

    expect(followUp!.status).toBe('saved');
    followUpId = followUp!.id!;

    expect(appointment!.status).toBe('saved');
    expect(appointment!.calendar).toBe('not_configured');
    appointmentId = appointment!.id!;

    expect(fact!.status).toBe('saved');
    factId = fact!.id!;

    expect(refused!.status).toBe('refused');
    expect(refused!.reason).toMatch(/password/i);

    const todo = await readVaultFile('Tasks/To do.md');
    expect(todo).toContain('Call the dentist');
    expect(todo).toContain(`^${taskId}`);
    expect(todo).not.toContain('hunter2');

    const followUps = await readVaultFile('Tasks/Follow-ups.md');
    expect(followUps).toContain('send the proposal');
    expect(followUps).toContain(`^${followUpId}`);

    const appointments = await readVaultFile('Tasks/Appointments.md');
    expect(appointments).toContain('Dentist appointment');
    expect(appointments).toContain(`^${appointmentId}`);

    const health = await readVaultFile('Memory/Topics/Health.md');
    expect(health).toContain('Allergic to penicillin');
    expect(health).toContain(`^${factId}`);

    const alex = await readVaultFile('People/Alex Rivera.md');
    expect(alex).toContain('# Alex Rivera');
  });

  // --- recall -----------------------------------------------------------------------------------

  it('recalls the task with an Obsidian link', async () => {
    const result = await client.callTool({ name: 'recall', arguments: { query: 'dentist' } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      total: number;
      results: Array<{ id: string; link: string }>;
    };
    expect(structured.total).toBeGreaterThanOrEqual(1);
    const found = structured.results.find((r) => r.id === taskId);
    expect(found).toBeDefined();
    expect(found!.link).toContain('obsidian://open?vault=ClaudiaTest');
  });

  // --- agenda -------------------------------------------------------------------------------

  it('serves the today, upcoming, follow_ups and brief agenda views', async () => {
    const today = await client.callTool({ name: 'agenda', arguments: { view: 'today' } });
    expect(today.isError).toBeFalsy();
    expect((today.structuredContent as { view: string }).view).toBe('today');

    const upcoming = await client.callTool({ name: 'agenda', arguments: { view: 'upcoming' } });
    expect(upcoming.isError).toBeFalsy();
    const upcomingBody = upcoming.structuredContent as {
      reminders: Array<{ id: string }>;
      appointments: Array<{ id: string }>;
    };
    expect(upcomingBody.reminders.some((r) => r.id === taskId)).toBe(true);
    expect(upcomingBody.appointments.some((a) => a.id === appointmentId)).toBe(true);

    const followUps = await client.callTool({ name: 'agenda', arguments: { view: 'follow_ups' } });
    expect(followUps.isError).toBeFalsy();
    const followUpsBody = followUps.structuredContent as { promised: Array<{ id: string }> };
    expect(followUpsBody.promised.some((f) => f.id === followUpId)).toBe(true);

    const brief = await client.callTool({ name: 'agenda', arguments: { view: 'brief' } });
    expect(brief.isError).toBeFalsy();
    expect((brief.structuredContent as { view: string }).view).toBe('brief');
  });

  // --- update ------------------------------------------------------------------------------

  it('completes the appointment', async () => {
    const result = await client.callTool({
      name: 'update',
      arguments: { action: 'complete', id: appointmentId },
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { status: string }).status).toBe('ok');
    const appointments = await readVaultFile('Tasks/Appointments.md');
    expect(appointments).toMatch(new RegExp(`- \\[x\\].*\\^${appointmentId}`));
  });

  it('snoozes the task past its current reminder', async () => {
    const result = await client.callTool({
      name: 'update',
      arguments: { action: 'snooze', id: taskId, until: 'wednesday 09:00' },
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { status: string }).status).toBe('ok');
    const todo = await readVaultFile('Tasks/To do.md');
    expect(todo).toContain('💤 2026-09-30 09:00');
  });

  it('reschedules the follow-up with a new reminder', async () => {
    const result = await client.callTool({
      name: 'update',
      arguments: { action: 'reschedule', id: followUpId, remind_at: 'thursday 10:00' },
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { status: string }).status).toBe('ok');
    const followUps = await readVaultFile('Tasks/Follow-ups.md');
    expect(followUps).toContain('⏰ 2026-10-01 10:00');
  });

  it('forgets the fact', async () => {
    const result = await client.callTool({
      name: 'update',
      arguments: { action: 'forget', id: factId },
    });
    expect(result.isError).toBeFalsy();
    const health = await readVaultFile('Memory/Topics/Health.md');
    expect(health).not.toContain('Allergic to penicillin');
  });

  it('reports not_found as an error result for an unknown id', async () => {
    const result = await client.callTool({
      name: 'update',
      arguments: { action: 'complete', id: 'tXXXX' },
    });
    expect(result.isError).toBe(true);
  });

  it('undoes the most recent capture', async () => {
    const captured = await client.callTool({
      name: 'capture',
      arguments: { items: [{ kind: 'task', text: 'Temporary undo test item' }] },
    });
    const structured = captured.structuredContent as { results: StructuredCaptureItem[] };
    const tempId = structured.results[0]!.id!;

    let todo = await readVaultFile('Tasks/To do.md');
    expect(todo).toContain('Temporary undo test item');

    const undone = await client.callTool({ name: 'update', arguments: { action: 'undo' } });
    expect(undone.isError).toBeFalsy();

    todo = await readVaultFile('Tasks/To do.md');
    expect(todo).not.toContain('Temporary undo test item');
    expect(todo).not.toContain(`^${tempId}`);
  });

  it('adds a never-save rule, then refuses a matching capture', async () => {
    const added = await client.callTool({
      name: 'update',
      arguments: {
        action: 'add_rule',
        text: 'Nothing about my fantasy football league',
        keywords: ['fantasy football'],
      },
    });
    expect(added.isError).toBeFalsy();
    expect((added.structuredContent as { status: string }).status).toBe('ok');

    const captured = await client.callTool({
      name: 'capture',
      arguments: {
        items: [{ kind: 'task', text: 'Set my fantasy football lineup' }],
      },
    });
    const structured = captured.structuredContent as { results: StructuredCaptureItem[] };
    expect(structured.results[0]!.status).toBe('refused');
    expect(structured.results[0]!.reason).toMatch(/fantasy football/i);
  });

  it('changes a setting', async () => {
    const result = await client.callTool({
      name: 'update',
      arguments: { action: 'set_setting', setting: 'Brief time', value: '08:00' },
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { status: string }).status).toBe('ok');
    const settings = await readVaultFile('_claudia/Settings.md');
    expect(settings).toContain('Brief time: 08:00');
  });

  // --- notify ------------------------------------------------------------------------------

  it('sends a push via ntfy and updates Today.md with the brief summary', async () => {
    const before = fakeNtfy.messages.length;
    const result = await client.callTool({
      name: 'notify',
      arguments: {
        message: '2 things today.',
        kind: 'brief',
        today_summary: 'Dentist at 3pm; call mom.',
      },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { status: string; today_updated: boolean };
    expect(structured.status).toBe('sent');
    expect(structured.today_updated).toBe(true);

    expect(fakeNtfy.messages.length).toBe(before + 1);
    const lastMessage = fakeNtfy.messages.at(-1) as { message: string };
    expect(lastMessage.message).toBe('2 things today.');

    const today = await readVaultFile('Today.md');
    expect(today).toContain('Dentist at 3pm; call mom.');

    const brief = await client.callTool({ name: 'agenda', arguments: { view: 'brief' } });
    expect(
      (brief.structuredContent as { brief_published_today: boolean }).brief_published_today,
    ).toBe(true);
  });

  // --- refresh-token rotation, reuse detection and family revocation -------------------------

  it('rotates the refresh token mid-session; the new token works and reuse revokes the family', async () => {
    const rotateRes = await fetch(`${publicUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    });
    expect(rotateRes.status).toBe(200);
    const rotated = (await rotateRes.json()) as { access_token: string; refresh_token: string };
    expect(rotated.access_token).not.toBe(accessToken);

    // The new access token works for a real tool call.
    const made = makeClient(rotated.access_token);
    const rotatedClient = made.client;
    await rotatedClient.connect(made.transport);
    const recallResult = await rotatedClient.callTool({
      name: 'recall',
      arguments: { query: 'dentist' },
    });
    expect(recallResult.isError).toBeFalsy();

    // Reusing the old (already-rotated) refresh token is rejected...
    const reuseRes = await fetch(`${publicUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    });
    expect(reuseRes.status).toBe(400);

    // ...and revokes the whole family: the token minted by the legitimate rotation is now dead.
    const afterReuseRes = await fetch(`${publicUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rotated.access_token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(afterReuseRes.status).toBe(401);
    expect(afterReuseRes.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  // --- /health -----------------------------------------------------------------------------

  it('serves a /health report with the documented shape and no secrets', async () => {
    const res = await fetch(`${publicUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      vault: { path_ok: true, writable: true },
      ntfy: { configured: true },
      calendar: { configured: false },
    });
    expect(body.status).toMatch(/^(ok|degraded)$/);
    expect(typeof body.version).toBe('string');
    const index = body.index as { items: number; notes: number };
    expect(typeof index.items).toBe('number');
    expect(typeof index.notes).toBe('number');
    expect(Array.isArray(body.settings_warnings)).toBe(true);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain(vaultDir);
    expect(raw).not.toContain(OWNER_EMAIL);
    expect(raw).not.toContain(NTFY_TOKEN);
  });
});
