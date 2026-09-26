import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fileTokenStore, readClientSecrets } from './calendar/google.ts';
import { runCalendarAuth } from './calendar/auth.ts';
import { loadConfig } from './config.ts';
import { openIndex } from './engine/index.ts';
import { startService } from './main.ts';
import { seedVault } from './ops/seed.ts';
import { VERSION } from './version.ts';

type Command = (args: string[]) => void | Promise<void>;

function openUrl(url: string): void {
  try {
    spawn('/usr/bin/open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Best effort only; the URL is also logged for the user to open by hand.
  }
}

async function serve(): Promise<void> {
  const config = loadConfig();
  const service = await startService(config);
  console.log(`listening on ${service.url}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`received ${signal}, shutting down`);
    service
      .stop()
      .then(() => {
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error(err);
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

async function reindex(): Promise<void> {
  const config = loadConfig();
  const index = openIndex({ dbPath: config.paths.indexDb, vaultDir: config.vaultPath });
  try {
    const result = await index.rebuild();
    console.log(
      `Rebuilt index: ${String(result.notes)} note(s), ${String(result.items)} item(s) in ${String(result.ms)}ms.`,
    );
  } finally {
    index.close();
  }
}

async function seedVaultCommand(): Promise<void> {
  const config = loadConfig();
  const result = await seedVault(config.vaultPath);
  console.log(
    `Seeded vault: ${String(result.created.length)} created, ${String(result.skipped.length)} already existed.`,
  );
  for (const path of result.created) {
    console.log(`  created: ${path}`);
  }
  for (const path of result.skipped) {
    console.log(`  skipped: ${path}`);
  }
}

async function calendarAuth(): Promise<void> {
  const config = loadConfig();
  if (!existsSync(config.calendar.clientSecretsFile)) {
    console.error(
      `No Google Calendar client secrets found at ${config.calendar.clientSecretsFile}.\n` +
        'Download an OAuth "Desktop app" client from ' +
        'https://console.cloud.google.com/apis/credentials and save it at that path, then run ' +
        '`claudia calendar-auth` again.',
    );
    process.exitCode = 1;
    return;
  }

  let secrets;
  try {
    secrets = readClientSecrets(config.calendar.clientSecretsFile);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  await runCalendarAuth({
    secrets,
    tokens: fileTokenStore(config.calendar.tokenFile),
    openUrl,
    log: (line) => {
      console.log(line);
    },
  });
  console.log('Google Calendar connected.');
}

const commands: Record<string, Command> = {
  serve,
  reindex,
  'seed-vault': seedVaultCommand,
  'calendar-auth': calendarAuth,
  smoke: () => {
    console.log('claudia smoke: not implemented yet');
  },
};

function printUsage(): void {
  console.log('Usage: claudia <command> [options]');
  console.log('');
  console.log('Commands:');
  for (const name of Object.keys(commands)) {
    console.log(`  ${name}`);
  }
  console.log('');
  console.log('Options:');
  console.log('  --version, -v    Print the current version and exit');
  console.log('  --help, -h       Print this usage message');
}

export async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;

  if (first === '--version' || first === '-v') {
    console.log(VERSION);
    return 0;
  }

  if (first === '--help' || first === '-h') {
    printUsage();
    return 0;
  }

  if (first === undefined) {
    printUsage();
    return 2;
  }

  const command = commands[first];
  if (!command) {
    printUsage();
    return 2;
  }

  await command(rest);
  // A command may set process.exitCode itself (e.g. a clear user-facing failure that isn't an
  // exception) rather than throwing; respect that instead of forcing a 0 exit.
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
