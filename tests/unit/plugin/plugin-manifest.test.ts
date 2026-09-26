import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pluginJsonPath = fileURLToPath(
  new URL('../../../plugin/.claude-plugin/plugin.json', import.meta.url),
);
const mcpJsonPath = fileURLToPath(new URL('../../../plugin/.mcp.json', import.meta.url));

describe('plugin.json', () => {
  it('is valid JSON naming the claudia plugin', () => {
    const parsed = JSON.parse(readFileSync(pluginJsonPath, 'utf8')) as Record<string, unknown>;

    expect(parsed.name).toBe('claudia');
    expect(typeof parsed.version).toBe('string');
    expect(typeof parsed.description).toBe('string');
    expect(parsed.author).toMatchObject({ name: expect.any(String) as string });
  });
});

describe('.mcp.json', () => {
  it('points to the Claudia MCP endpoint over http', () => {
    const parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as {
      mcpServers: Record<string, { type: string; url: string }>;
    };

    expect(parsed.mcpServers.claudia).toBeDefined();
    expect(parsed.mcpServers.claudia?.type).toBe('http');
    expect(parsed.mcpServers.claudia?.url).toBe('https://claudia.aroopbiswal.com/mcp');
  });
});
