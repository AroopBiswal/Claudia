// One-off maintenance: stamp facts that have no ➕ with the date and time the Log says they were
// added. Facts with no Log entry (hand-written ones) are left alone and listed.
// Usage: node scripts/backfill-fact-timestamps.ts [--apply]   (default is a dry run)
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createVaultWriter } from '../src/engine/writer.ts';
import { extractItems } from '../src/vault/items.ts';
import { parseLine, setField } from '../src/vault/line.ts';
import { parseNote } from '../src/vault/note.ts';

const ADDED_RE = /^- (\d\d:\d\d) · .*? · added \[\[[^\]#]*#\^([A-Za-z0-9-]+)\|/;

/** Block id → 'YYYY-MM-DD HH:mm' of its first `added` Log line. */
export async function addedTimes(vaultDir: string): Promise<Map<string, string>> {
  const times = new Map<string, string>();
  const logDir = join(vaultDir, 'Log');
  const files = (await readdir(logDir).catch(() => [] as string[]))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();
  for (const file of files) {
    const date = file.slice(0, 10);
    for (const line of (await readFile(join(logDir, file), 'utf8')).split(/\r?\n/)) {
      const m = ADDED_RE.exec(line);
      if (m?.[1] && m[2] && !times.has(m[2])) times.set(m[2], `${date} ${m[1]}`);
    }
  }
  return times;
}

async function walk(dir: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, p)));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const { vaultPath } = loadConfig();
  const times = await addedTimes(vaultPath);
  const writer = createVaultWriter({ vaultDir: vaultPath });
  const notes = [...(await walk(vaultPath, 'Memory')), ...(await walk(vaultPath, 'People'))];
  let stamped = 0;
  const unknown: string[] = [];
  for (const path of notes) {
    const text = await readFile(join(vaultPath, path), 'utf8');
    for (const item of extractItems(path, parseNote(text))) {
      if (item.kind !== 'fact' || item.created || !item.id) continue;
      const at = times.get(item.id);
      if (!at) {
        unknown.push(`${path}: ${item.text}`);
        continue;
      }
      console.log(`${apply ? 'stamp' : 'would stamp'} ${path} ^${item.id} ➕ ${at}`);
      if (apply) {
        await writer.editById(path, item.id, (raw) =>
          parseLine(raw).fields.created ? raw : setField(raw, 'created', at),
        );
      }
      stamped += 1;
    }
  }
  console.log(
    `${apply ? 'stamped' : 'would stamp'} ${String(stamped)} fact(s); ${String(unknown.length)} without a Log entry`,
  );
  for (const u of unknown) console.log(`  no Log entry: ${u}`);
}

if (process.argv[1]?.endsWith('backfill-fact-timestamps.ts')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
