import { randomBytes } from 'node:crypto';
import { createVaultWriter } from '../../src/engine/writer.ts';
import { openIndex } from '../../src/engine/index.ts';
import { openState } from '../../src/engine/state.ts';
import type { Notifier, PushMessage } from '../../src/notify/ntfy.ts';
import type { CalendarSync, ClaudiaContext } from '../../src/services/context.ts';
import { SEED_NOTES } from '../../src/vault/templates.ts';
import { FakeClock } from './fake-clock.ts';
import { makeScratchVault, type ScratchVault } from './scratch-vault.ts';

export interface FakeNotifier extends Notifier {
  sent: PushMessage[];
  fail: boolean;
}

export function fakeNotifier(): FakeNotifier {
  const n: FakeNotifier = {
    sent: [],
    fail: false,
    send(msg) {
      if (n.fail) return Promise.resolve({ ok: false, error: 'fake failure' });
      n.sent.push(msg);
      return Promise.resolve({ ok: true, id: `m${n.sent.length}` });
    },
  };
  return n;
}

export interface TestContext {
  ctx: ClaudiaContext;
  clock: FakeClock;
  vault: ScratchVault;
  notifier: FakeNotifier;
  changes: number;
  cleanup(): Promise<void>;
}

/**
 * A complete service context over a scratch vault (seeded with the vault skeleton unless `seed: false`),
 * in-memory index and state, a fake clock (default Saturday 2026-09-26 10:00 Pacific) and a fake notifier.
 */
export async function makeTestContext(
  opts: {
    files?: Record<string, string>;
    now?: string;
    seed?: boolean;
    calendar?: CalendarSync | null;
  } = {},
): Promise<TestContext> {
  const seed =
    opts.seed === false ? {} : Object.fromEntries(SEED_NOTES.map((n) => [n.path, n.content]));
  const vault = await makeScratchVault({ ...seed, ...(opts.files ?? {}) });
  const clock = new FakeClock(opts.now ?? '2026-09-26T17:00:00Z');
  const now = () => clock.now();
  const index = openIndex({ dbPath: ':memory:', vaultDir: vault.dir, now });
  await index.rebuild();
  const state = openState({ dbPath: ':memory:', now });
  const writer = createVaultWriter({ vaultDir: vault.dir, now, quietMs: 0 });
  const notifier = fakeNotifier();
  const t: TestContext = {
    clock,
    vault,
    notifier,
    changes: 0,
    ctx: {
      vaultDir: vault.dir,
      vaultName: 'Claudia',
      publicUrl: 'https://claudia.test',
      clock,
      index,
      state,
      writer,
      notifier,
      calendar: opts.calendar ?? null,
      actionKey: randomBytes(32),
      log: () => {},
      onVaultChanged: () => {
        t.changes += 1;
      },
    },
    async cleanup() {
      index.close();
      state.close();
      await vault.cleanup();
    },
  };
  return t;
}
