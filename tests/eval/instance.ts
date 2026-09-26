// Starts one scratch Claudia instance per eval case: a temp CLAUDIA_HOME, a
// temp seeded vault (plus any `setup.rules` written straight into
// `_claudia/Rules.md` before the service starts, since capture's never-save
// guard must already see them), a real HTTP listener on an OS-assigned port,
// and an MCP access token minted through the real OAuth store (no bypass —
// docs/DECISIONS.md B10). The eval runner (run.ts) points headless Claude
// Code's `--mcp-config` at `port`/`token` and, once the process exits, reads
// back everything it saved via `savedItems()`/`rulesAdded()`.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configFromObject } from '../../src/config.ts';
import { startService, type RunningService } from '../../src/main.ts';
import { seedVault } from '../../src/ops/seed.ts';
import { createOAuthStore } from '../../src/auth/store.ts';
import { newBlockId } from '../../src/vault/ids.ts';
import { LAYOUT } from '../../src/vault/layout.ts';
import type { FieldName } from '../../src/vault/line.ts';
import { renderItemLine } from '../../src/vault/line.ts';
import { normalizeKeywords } from '../../src/vault/rules.ts';
import type { IndexedItem } from '../../src/engine/index.ts';
import type { EvalCase, SavedItem } from './types.ts';

export interface EvalInstance {
  port: number;
  token: string;
  vaultDir: string;
  stop(): Promise<void>;
  savedItems(): Promise<SavedItem[]>;
  rulesAdded(): number;
}

/** Vault-relative folders whose items count as "saved" for the eval (docs/tools.md kinds). */
function isSavedFolder(path: string): boolean {
  return path.startsWith('Tasks/') || path.startsWith('People/') || path.startsWith('Memory/');
}

function appointmentStartOf(item: IndexedItem): string | null {
  if (item.kind !== 'appointment' || !item.appointment) return null;
  return `${item.appointment.date} ${item.appointment.start}`;
}

function personOf(item: IndexedItem): string | null {
  if (item.kind !== 'fact' && item.kind !== 'follow_up') return null;
  return item.people[0] ?? null;
}

function toSavedItem(item: IndexedItem): SavedItem {
  return {
    kind: item.kind,
    text: item.text,
    person: personOf(item),
    people: item.people,
    direction: item.direction,
    reminderLocal: item.effectiveReminder,
    due: item.due,
    appointmentStart: appointmentStartOf(item),
    repeat: item.repeat,
    path: item.path,
  };
}

/** Writes `setup.rules` (docs/KICKOFF.md-style never-save rules) into a freshly seeded Rules.md,
 * in the exact vault format `update`'s `add_rule` action produces: `- <text> 🚫 kw1, kw2 ^rXXXX`. */
async function writeSetupRules(
  vaultDir: string,
  rules: Array<{ text: string; keywords: string[] }>,
): Promise<void> {
  if (rules.length === 0) return;

  const usedIds = new Set<string>();
  const lines = rules.map(({ text, keywords }) => {
    const id = newBlockId('r', (candidate) => usedIds.has(candidate));
    usedIds.add(id);
    const fields: Partial<Record<FieldName, string>> = {
      keywords: normalizeKeywords(keywords).join(', '),
    };
    return renderItemLine({ task: false, description: text, fields, blockId: id });
  });

  const rulesPath = join(vaultDir, LAYOUT.rules);
  const existing = await readFile(rulesPath, 'utf8');
  const sep = existing.endsWith('\n') ? '' : '\n';
  await writeFile(rulesPath, `${existing}${sep}${lines.join('\n')}\n`, 'utf8');
}

export async function startEvalInstance(evalCase: EvalCase): Promise<EvalInstance> {
  const home = await mkdtemp(join(tmpdir(), 'claudia-eval-home-'));
  const vaultDir = await mkdtemp(join(tmpdir(), 'claudia-eval-vault-'));

  await seedVault(vaultDir);
  const setupRules = evalCase.setup?.rules ?? [];
  await writeSetupRules(vaultDir, setupRules);

  const config = configFromObject(
    home,
    {
      vaultPath: vaultDir,
      vaultName: 'ClaudiaEval',
      host: '127.0.0.1',
      port: 8787, // unused: startService listens on an OS-assigned port (port0: true) below.
      publicUrl: 'http://127.0.0.1:8787',
      ownerEmail: null,
      quietMs: 0,
    },
    {},
  );

  let service: RunningService;
  try {
    service = await startService(config, {
      // Real clock: Claude's own notion of "today" comes from its own environment, so the
      // scratch server's clock must agree with real wall-clock time, not a fake one.
      watch: false,
      schedulerAutoStart: false,
      port0: true,
      notifier: null,
      calendarClient: null,
    });
  } catch (err) {
    await rm(home, { recursive: true, force: true });
    await rm(vaultDir, { recursive: true, force: true });
    throw err;
  }

  const oauthStore = createOAuthStore(service.ctx.state.db, { now: () => new Date() });
  oauthStore.migrate();
  const client = oauthStore.registerClient({
    clientName: 'claudia-eval',
    redirectUris: ['http://127.0.0.1/eval'],
  });
  const tokens = oauthStore.issueTokens(client.clientId, 'eval', 'claudia', `${service.url}/mcp`);

  const port = Number(new URL(service.url).port);

  async function savedItems(): Promise<SavedItem[]> {
    // Every capture/update call already reindexes synchronously before returning
    // (src/services/context.ts's afterWrite), so this refresh is a defensive no-op in the
    // common case, not a requirement for correctness.
    await service.ctx.index.refresh();
    const items: SavedItem[] = [];
    for (const path of service.ctx.index.notePaths()) {
      if (!isSavedFolder(path)) continue;
      for (const item of service.ctx.index.itemsInNote(path)) {
        if (item.kind === 'rule') continue;
        items.push(toSavedItem(item));
      }
    }
    return items;
  }

  function rulesAdded(): number {
    return service.ctx.index.rules().length - setupRules.length;
  }

  async function stop(): Promise<void> {
    await service.stop();
    await rm(home, { recursive: true, force: true });
    await rm(vaultDir, { recursive: true, force: true });
  }

  return { port, token: tokens.accessToken, vaultDir, stop, savedItems, rulesAdded };
}
