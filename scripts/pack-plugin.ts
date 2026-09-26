import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export interface PackResult {
  outputZip: string;
  bytes: number;
}

/**
 * Zips the CONTENTS of `pluginDir` (so `.claude-plugin/plugin.json` sits at
 * the zip root) into `outputZip`, using the system `zip` CLI.
 */
export function packPlugin(
  pluginDir: string = join(repoRoot, 'plugin'),
  outputZip: string = join(repoRoot, 'dist', 'claudia-plugin.zip'),
): PackResult {
  if (!existsSync(pluginDir)) {
    throw new Error(`Plugin directory not found: ${pluginDir}`);
  }

  mkdirSync(dirname(outputZip), { recursive: true });

  if (existsSync(outputZip)) {
    rmSync(outputZip);
  }

  const result = spawnSync('zip', ['-r', '-X', '-q', outputZip, '.', '-x', '*.DS_Store'], {
    cwd: pluginDir,
    encoding: 'utf8',
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'The `zip` CLI is not available on this machine. Install it (e.g. Xcode Command Line ' +
          'Tools on macOS, or your package manager on Linux) and run this script again.',
      );
    }
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `zip exited with status ${String(result.status)}: ${result.stderr || result.stdout}`,
    );
  }

  const { size } = statSync(outputZip);
  return { outputZip, bytes: size };
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
  try {
    const { outputZip, bytes } = packPlugin();
    console.log(`Wrote ${outputZip} (${bytes.toLocaleString('en-US')} bytes)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
