// Unit coverage for tests/eval/run.ts that needs no `claude` binary and no network: CLI arg
// parsing, the per-case MCP config JSON shape (and that it never leaks the bearer token in logs),
// and the resolver wiring the scorer uses (the real src/time/expressions.ts, not a stand-in).

import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MODEL,
  buildMcpConfig,
  parseArgs,
  redactToken,
  resolveDateExpr,
  resolveTimeExpr,
  selectCases,
  surfaceLine,
} from '../../eval/run.ts';
import type { EvalCase } from '../../eval/types.ts';

describe('parseArgs', () => {
  it('defaults to the standard model and concurrency with no flags', () => {
    const opts = parseArgs([]);
    expect(opts).toEqual({ concurrency: DEFAULT_CONCURRENCY, model: DEFAULT_MODEL });
  });

  it('parses --ids as a trimmed, comma-separated list', () => {
    const opts = parseArgs(['--ids', 'p01, p02,p03']);
    expect(opts.ids).toEqual(['p01', 'p02', 'p03']);
  });

  it('parses --category, --limit, --concurrency and --model', () => {
    const opts = parseArgs([
      '--category',
      'personal',
      '--limit',
      '5',
      '--concurrency',
      '2',
      '--model',
      'claude-opus-5',
    ]);
    expect(opts).toEqual({
      category: 'personal',
      limit: 5,
      concurrency: 2,
      model: 'claude-opus-5',
    });
  });

  it('accepts --flag=value form', () => {
    const opts = parseArgs(['--limit=3']);
    expect(opts.limit).toBe(3);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--bogus', 'x'])).toThrow(/Unknown flag/);
  });

  it('rejects a non-numeric --limit', () => {
    expect(() => parseArgs(['--limit', 'nope'])).toThrow(/--limit/);
  });

  it('rejects a zero or negative --concurrency', () => {
    expect(() => parseArgs(['--concurrency', '0'])).toThrow(/--concurrency/);
  });
});

describe('selectCases', () => {
  const cases: EvalCase[] = [
    { id: 'p01', category: 'personal', message: 'a', expect: [] },
    { id: 'p02', category: 'personal', message: 'b', expect: [] },
    { id: 'r01', category: 'rule', message: 'c', expect: [] },
  ];

  it('with no filters, returns every case', () => {
    expect(selectCases(cases, { concurrency: 1, model: 'x' })).toHaveLength(3);
  });

  it('filters by --ids, in cases.json order, ignoring unknown ids', () => {
    const selected = selectCases(cases, {
      ids: ['r01', 'p01', 'nope'],
      concurrency: 1,
      model: 'x',
    });
    expect(selected.map((c) => c.id)).toEqual(['p01', 'r01']);
  });

  it('filters by --category when --ids is absent', () => {
    const selected = selectCases(cases, { category: 'personal', concurrency: 1, model: 'x' });
    expect(selected.map((c) => c.id)).toEqual(['p01', 'p02']);
  });

  it('--ids takes priority over --category', () => {
    const selected = selectCases(cases, {
      ids: ['r01'],
      category: 'personal',
      concurrency: 1,
      model: 'x',
    });
    expect(selected.map((c) => c.id)).toEqual(['r01']);
  });

  it('applies --limit after filtering', () => {
    const selected = selectCases(cases, { limit: 1, concurrency: 1, model: 'x' });
    expect(selected.map((c) => c.id)).toEqual(['p01']);
  });

  it('--limit 0 selects nothing', () => {
    expect(selectCases(cases, { limit: 0, concurrency: 1, model: 'x' })).toEqual([]);
  });
});

describe('buildMcpConfig', () => {
  it('matches the exact shape claude --mcp-config expects', () => {
    const config = buildMcpConfig(54321, 'secret-token-abc');
    expect(config).toEqual({
      mcpServers: {
        'claudia-eval': {
          type: 'http',
          url: 'http://127.0.0.1:54321/mcp',
          headers: { Authorization: 'Bearer secret-token-abc' },
        },
      },
    });
  });

  it('round-trips through JSON.stringify the way run.ts writes it to disk', () => {
    const config = buildMcpConfig(8080, 'tok');
    const parsed = JSON.parse(JSON.stringify(config)) as unknown;
    expect(parsed).toEqual(config);
  });
});

describe('redactToken', () => {
  const token = 'super-secret-bearer-token';

  it('replaces every occurrence of the token', () => {
    const text = `Authorization: Bearer ${token}\nlog line mentions ${token} again`;
    const redacted = redactToken(text, token);
    expect(redacted).not.toContain(token);
    expect(redacted).toBe('Authorization: Bearer [REDACTED]\nlog line mentions [REDACTED] again');
  });

  it('leaves text alone when the token does not appear', () => {
    expect(redactToken('nothing sensitive here', token)).toBe('nothing sensitive here');
  });

  it('is a no-op for an empty token', () => {
    expect(redactToken('some text', '')).toBe('some text');
  });
});

describe('surfaceLine', () => {
  it('names the surface and states weekday, date and time in America/Los_Angeles', () => {
    const now = DateTime.fromISO('2026-09-26T14:05:00', { zone: 'America/Los_Angeles' });
    expect(surfaceLine(now)).toBe(
      'Surface: Claude Code. Today is Saturday, 2026-09-26 and the time is 14:05 in America/Los_Angeles.',
    );
  });
});

describe('resolver wiring (real src/time/expressions.ts)', () => {
  // 2026-09-26 is a Saturday.
  const now = new Date('2026-09-26T17:00:00Z'); // 10:00 America/Los_Angeles

  it('resolveTimeExpr resolves an absolute weekday form to the next such weekday', () => {
    expect(resolveTimeExpr('tuesday 09:00', now)).toBe('2026-09-29 09:00');
  });

  it('resolveTimeExpr resolves a relative form off `now`', () => {
    expect(resolveTimeExpr('+2h', now)).toBe('2026-09-26 12:00');
  });

  it('resolveDateExpr resolves a bare weekday date expression', () => {
    expect(resolveDateExpr('friday', now)).toBe('2026-10-02');
  });

  it('resolveTimeExpr throws with a helpful message on an unparsable expression', () => {
    expect(() => resolveTimeExpr('whenever', now)).toThrow(/cases\.json time expression/);
  });

  it('resolveDateExpr throws on an unparsable expression', () => {
    expect(() => resolveDateExpr('whenever', now)).toThrow(/cases\.json date expression/);
  });
});
