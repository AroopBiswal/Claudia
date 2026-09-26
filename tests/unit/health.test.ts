import { afterEach, describe, expect, it } from 'vitest';
import { createHealth } from '../../src/health.ts';
import { makeTestContext, type TestContext } from '../helpers/test-context.ts';

let t: TestContext | undefined;
afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

describe('createHealth', () => {
  it('reports ok with vault/index/settings info and the given configured flags', async () => {
    t = await makeTestContext();
    const health = createHealth(t.ctx, {
      vaultPath: t.vault.dir,
      ntfyConfigured: true,
      calendarConfigured: false,
    });

    const report = await health();
    expect(report.status).toBe('ok');
    expect(report.vault).toEqual({ path_ok: true, writable: true });
    expect(report.ntfy).toEqual({ configured: true });
    expect(report.calendar).toEqual({ configured: false });
    expect(report.scheduler).toEqual({ last_tick: null });
    expect(typeof report.version).toBe('string');
    expect(Array.isArray(report.settings_warnings)).toBe(true);
    expect(report.index.notes).toBeGreaterThan(0);
  });

  it('reports degraded when the vault path does not exist', async () => {
    t = await makeTestContext();
    const health = createHealth(t.ctx, {
      vaultPath: `${t.vault.dir}-missing`,
      ntfyConfigured: false,
      calendarConfigured: false,
    });

    const report = await health();
    expect(report.status).toBe('degraded');
    expect(report.vault.path_ok).toBe(false);
    expect(report.vault.writable).toBe(false);
  });

  it('reflects the scheduler last-tick key from state', async () => {
    t = await makeTestContext();
    t.ctx.state.setKv('scheduler:last_tick', '2026-09-26T18:00:00.000Z');
    const health = createHealth(t.ctx, {
      vaultPath: t.vault.dir,
      ntfyConfigured: false,
      calendarConfigured: false,
    });

    const report = await health();
    expect(report.scheduler.last_tick).toBe('2026-09-26T18:00:00.000Z');
  });

  it('caches the report for 2 seconds of clock time, then refreshes', async () => {
    t = await makeTestContext();
    const health = createHealth(t.ctx, {
      vaultPath: t.vault.dir,
      ntfyConfigured: false,
      calendarConfigured: false,
    });

    const first = await health();
    expect(first.scheduler.last_tick).toBeNull();

    // A change within the cache window should not be visible yet.
    t.ctx.state.setKv('scheduler:last_tick', '2026-09-26T18:00:00.000Z');
    const stillCached = await health();
    expect(stillCached.scheduler.last_tick).toBeNull();

    // Once the cache window elapses (by the injected clock), the change is visible.
    t.clock.advance(2001);
    const fresh = await health();
    expect(fresh.scheduler.last_tick).toBe('2026-09-26T18:00:00.000Z');
  });

  it('never includes the vault path or note content in the report', async () => {
    t = await makeTestContext();
    const health = createHealth(t.ctx, {
      vaultPath: t.vault.dir,
      ntfyConfigured: false,
      calendarConfigured: false,
    });

    const report = await health();
    const raw = JSON.stringify(report);
    expect(raw).not.toContain(t.vault.dir);
  });
});
