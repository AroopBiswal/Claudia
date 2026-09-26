import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packPlugin } from '../../../scripts/pack-plugin.ts';

function hasCli(name: string): boolean {
  const result = spawnSync(name, ['-v'], { encoding: 'utf8' });
  return result.error === undefined;
}

const zipAvailable = hasCli('zip');
const unzipAvailable = hasCli('unzip');
const pluginDir = fileURLToPath(new URL('../../../plugin', import.meta.url));

describe.skipIf(!zipAvailable || !unzipAvailable)('pack-plugin', () => {
  it('zips the contents of plugin/ with plugin.json and SKILL.md at the zip root', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'claudia-plugin-pack-'));
    const outputZip = join(workDir, 'claudia-plugin.zip');

    try {
      const result = packPlugin(pluginDir, outputZip);
      expect(result.outputZip).toBe(outputZip);
      expect(result.bytes).toBeGreaterThan(0);

      const listing = spawnSync('unzip', ['-l', outputZip], { encoding: 'utf8' });
      expect(listing.status).toBe(0);
      expect(listing.stdout).toContain('.claude-plugin/plugin.json');
      expect(listing.stdout).toContain('skills/claudia/SKILL.md');
      expect(listing.stdout).not.toContain('.DS_Store');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('replaces a previously packed zip rather than appending to it', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'claudia-plugin-pack-'));
    const outputZip = join(workDir, 'claudia-plugin.zip');

    try {
      packPlugin(pluginDir, outputZip);
      const second = packPlugin(pluginDir, outputZip);

      const listing = spawnSync('unzip', ['-l', outputZip], { encoding: 'utf8' });
      const matches = listing.stdout.match(/plugin\.json/g) ?? [];
      expect(matches.length).toBe(1);
      expect(second.bytes).toBeGreaterThan(0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
