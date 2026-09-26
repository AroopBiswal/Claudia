import { createServer as createNetServer } from 'node:net';
import type { Server } from 'node:http';
import express, { type Application } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createActionsRouter } from '../../../src/http/actions.ts';
import { signActionLink } from '../../../src/notify/links.ts';
import { makeTestContext, type TestContext } from '../../helpers/test-context.ts';

let t: TestContext | undefined;
let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((err) => (err ? reject(err) : resolve()));
    });
    server = undefined;
  }
  await t?.cleanup();
  t = undefined;
});

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

/** Mounts the actions router (as main.ts would, at /a) on a real 127.0.0.1 server. */
async function startActionsServer(ctx: TestContext['ctx']): Promise<string> {
  const app: Application = express();
  app.use('/a', createActionsRouter(ctx));
  const port = await reservePort();
  await new Promise<void>((resolve) => {
    server = app.listen(port, '127.0.0.1', () => resolve());
  });
  return `http://127.0.0.1:${port}/a`;
}

function token(t: TestContext, action: 'done' | 'snooze1h' | 'tomorrow', id: string): string {
  return signActionLink(t.ctx.actionKey, { action, id, now: t.clock.now() });
}

/**
 * Flips the first character of the signature (right after the "."), which
 * always carries significant bits. Flipping the *last* character of a
 * base64url blob can land on padding bits that get dropped on decode,
 * leaving the signature bytes unchanged and making the tamper a no-op.
 */
function tamper(tok: string): string {
  const dot = tok.indexOf('.');
  const sigStart = dot + 1;
  const ch = tok[sigStart];
  const replacement = ch === 'A' ? 'B' : 'A';
  return tok.slice(0, sigStart) + replacement + tok.slice(sigStart + 1);
}

const TODO_FILES = {
  'Tasks/To do.md':
    '# To do\n\n- [ ] Call the <dentist> & "reschedule" ⏰ 2026-09-26 10:00 ^t0001\n',
};

describe('GET /a/:token', () => {
  it('shows an escaped confirm page and sets security headers, without changing anything', async () => {
    t = await makeTestContext({ now: '2026-09-26T17:00:00Z', files: TODO_FILES });
    const base = await startActionsServer(t.ctx);
    const tok = token(t, 'done', 't0001');

    const res = await fetch(`${base}/${tok}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const html = await res.text();
    expect(html).toContain('Mark done');
    expect(html).not.toContain('<dentist>');
    expect(html).toContain('&lt;dentist&gt;');
    expect(html).toContain('&quot;reschedule&quot;');

    // GET must never mutate: the item is still open, and the link still works afterwards.
    expect(t.ctx.index.getItem('t0001')?.status).toBe('open');
    const again = await fetch(`${base}/${tok}`);
    expect(again.status).toBe(200);
    expect(t.ctx.index.getItem('t0001')?.status).toBe('open');
  });

  it('returns 400 for a tampered token', async () => {
    t = await makeTestContext({ now: '2026-09-26T17:00:00Z', files: TODO_FILES });
    const base = await startActionsServer(t.ctx);
    const tok = token(t, 'done', 't0001');
    const tampered = tamper(tok);

    const res = await fetch(`${base}/${tampered}`);
    expect(res.status).toBe(400);
  });

  it('returns 410 for an expired token', async () => {
    t = await makeTestContext({ now: '2026-09-26T17:00:00Z', files: TODO_FILES });
    const base = await startActionsServer(t.ctx);
    const tok = token(t, 'done', 't0001');

    t.clock.advance(8 * 24 * 60 * 60_000); // links expire after 7 days
    const res = await fetch(`${base}/${tok}`);
    expect(res.status).toBe(410);
  });
});

describe('POST /a/:token', () => {
  it('done completes the vault line', async () => {
    t = await makeTestContext({ now: '2026-09-26T17:00:00Z', files: TODO_FILES });
    const base = await startActionsServer(t.ctx);
    const tok = token(t, 'done', 't0001');

    const res = await fetch(`${base}/${tok}`, { method: 'POST' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Done');

    expect(t.ctx.index.getItem('t0001')?.status).toBe('done');
  });

  it('replaying a used token returns 410', async () => {
    t = await makeTestContext({ now: '2026-09-26T17:00:00Z', files: TODO_FILES });
    const base = await startActionsServer(t.ctx);
    const tok = token(t, 'done', 't0001');

    const first = await fetch(`${base}/${tok}`, { method: 'POST' });
    expect(first.status).toBe(200);

    const second = await fetch(`${base}/${tok}`, { method: 'POST' });
    expect(second.status).toBe(410);
  });

  it('a tampered token is rejected with 400', async () => {
    t = await makeTestContext({ now: '2026-09-26T17:00:00Z', files: TODO_FILES });
    const base = await startActionsServer(t.ctx);
    const tok = token(t, 'done', 't0001');
    const tampered = tamper(tok);

    const res = await fetch(`${base}/${tampered}`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(t.ctx.index.getItem('t0001')?.status).toBe('open');
  });

  it('an expired token is rejected with 410', async () => {
    t = await makeTestContext({ now: '2026-09-26T17:00:00Z', files: TODO_FILES });
    const base = await startActionsServer(t.ctx);
    const tok = token(t, 'done', 't0001');

    t.clock.advance(8 * 24 * 60 * 60_000);
    const res = await fetch(`${base}/${tok}`, { method: 'POST' });
    expect(res.status).toBe(410);
    expect(t.ctx.index.getItem('t0001')?.status).toBe('open');
  });

  it('snooze1h sets 💤 to one hour from now', async () => {
    t = await makeTestContext({ now: '2026-09-26T17:00:00Z', files: TODO_FILES }); // 10:00 Pacific
    const base = await startActionsServer(t.ctx);
    const tok = token(t, 'snooze1h', 't0001');

    const res = await fetch(`${base}/${tok}`, { method: 'POST' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Snoozed until 11:00am');
    expect(t.ctx.index.getItem('t0001')?.snooze).toBe('2026-09-26 11:00');
  });

  it('tomorrow sets 💤 to the same time of day tomorrow', async () => {
    t = await makeTestContext({ now: '2026-09-26T17:00:00Z', files: TODO_FILES }); // 10:00 Pacific
    const base = await startActionsServer(t.ctx);
    const tok = token(t, 'tomorrow', 't0001');

    const res = await fetch(`${base}/${tok}`, { method: 'POST' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Tomorrow at 10:00am');
    expect(t.ctx.index.getItem('t0001')?.snooze).toBe('2026-09-27 10:00');
  });

  it('returns 404 for an item that no longer exists', async () => {
    t = await makeTestContext({ now: '2026-09-26T17:00:00Z', files: TODO_FILES });
    const base = await startActionsServer(t.ctx);
    const tok = token(t, 'done', 'tGONE');

    const res = await fetch(`${base}/${tok}`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('honors Accept: application/json', async () => {
    t = await makeTestContext({ now: '2026-09-26T17:00:00Z', files: TODO_FILES });
    const base = await startActionsServer(t.ctx);
    const tok = token(t, 'done', 't0001');

    const res = await fetch(`${base}/${tok}`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.message).toContain('Done');
  });

  it('returns JSON errors too when the client asks for JSON', async () => {
    t = await makeTestContext({ now: '2026-09-26T17:00:00Z', files: TODO_FILES });
    const base = await startActionsServer(t.ctx);
    const tok = token(t, 'done', 't0001');
    t.clock.advance(8 * 24 * 60 * 60_000);

    const res = await fetch(`${base}/${tok}`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
  });

  it('never logs the token', async () => {
    t = await makeTestContext({ now: '2026-09-26T17:00:00Z', files: TODO_FILES });
    const logged: string[] = [];
    t.ctx.log = (message: string) => logged.push(message);
    const base = await startActionsServer(t.ctx);
    const tok = token(t, 'done', 't0001');

    await fetch(`${base}/${tok}`);
    await fetch(`${base}/${tok}`, { method: 'POST' });

    expect(logged.every((line) => !line.includes(tok))).toBe(true);
  });
});
