import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { VERSION } from './version.ts';

type Command = (args: string[]) => void | Promise<void>;

// Extend this map as real commands land (serve, reindex, calendar-auth, smoke, ...).
const commands: Record<string, Command> = {
  serve: () => {
    console.log('claudia serve: not implemented yet');
  },
  reindex: () => {
    console.log('claudia reindex: not implemented yet');
  },
  'calendar-auth': () => {
    console.log('claudia calendar-auth: not implemented yet');
  },
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
  return 0;
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
