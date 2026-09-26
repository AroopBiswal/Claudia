#!/usr/bin/env node
// Capture eval runner (docs/KICKOFF.md "Testing bar: capture eval"): drives headless Claude Code,
// loaded with the Claudia plugin skill and only the Claudia MCP tools, against a fresh scratch
// Claudia instance per case (tests/eval/instance.ts), then scores what got saved with
// tests/eval/score.ts. Full runs use the owner's Claude plan (docs/KICKOFF.md, "Cost note"), so
// this file only ever runs the subset it's told to: `npm run eval -- --ids p01,p02`,
// `--category personal`, `--limit N`. The orchestrator decides when to run the full set.
//
// Never calls an AI API itself and never touches the real vault (CLAUDE.md hard rules): every
// case gets its own temp CLAUDIA_HOME and temp vault under os.tmpdir(), and the only network
// traffic is headless Claude Code's own model calls plus its loopback MCP connection back to the
// scratch instance this process just started.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DateTime } from 'luxon';

import { parseDateExpression, parseTimeExpression } from '../../src/time/expressions.ts';
import { scoreAll, formatReport, type Report } from './score.ts';
import { startEvalInstance } from './instance.ts';
import type { CaseRun, EvalCase } from './types.ts';

const ZONE = 'America/Los_Angeles';
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_CONCURRENCY = 3;
export const CASE_TIMEOUT_MS = 180_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const CASES_PATH = join(HERE, 'cases.json');
const SKILL_PATH = join(REPO_ROOT, 'plugin/skills/claudia/SKILL.md');

// --- CLI arg parsing -----------------------------------------------------------------------

export interface CliOptions {
  ids?: string[];
  category?: string;
  limit?: number;
  concurrency: number;
  model: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { concurrency: DEFAULT_CONCURRENCY, model: DEFAULT_MODEL };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;

    let key: string;
    let value: string | undefined;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      }
    }

    switch (key) {
      case 'ids':
        if (value) {
          opts.ids = value
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }
        break;
      case 'category':
        if (value) opts.category = value;
        break;
      case 'limit':
        if (value !== undefined) {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0)
            throw new Error(`--limit must be a non-negative number, got "${value}"`);
          opts.limit = n;
        }
        break;
      case 'concurrency':
        if (value !== undefined) {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 1)
            throw new Error(`--concurrency must be a positive number, got "${value}"`);
          opts.concurrency = n;
        }
        break;
      case 'model':
        if (value) opts.model = value;
        break;
      default:
        throw new Error(`Unknown flag: --${key}`);
    }
  }

  return opts;
}

export function selectCases(cases: EvalCase[], opts: CliOptions): EvalCase[] {
  let selected = cases;
  if (opts.ids && opts.ids.length > 0) {
    const idSet = new Set(opts.ids);
    selected = selected.filter((c) => idSet.has(c.id));
  } else if (opts.category) {
    selected = selected.filter((c) => c.category === opts.category);
  }
  if (opts.limit !== undefined) {
    selected = selected.slice(0, opts.limit);
  }
  return selected;
}

// --- per-case MCP config (docs/KICKOFF.md's exact headless command) -----------------------

export interface EvalMcpConfig {
  mcpServers: {
    'claudia-eval': { type: 'http'; url: string; headers: { Authorization: string } };
  };
}

export function buildMcpConfig(port: number, token: string): EvalMcpConfig {
  return {
    mcpServers: {
      'claudia-eval': {
        type: 'http',
        url: `http://127.0.0.1:${String(port)}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
}

/** Never logs a bearer token: every occurrence of `token` in `text` is replaced. */
export function redactToken(text: string, token: string): string {
  if (token.length === 0) return text;
  return text.split(token).join('[REDACTED]');
}

/** "Surface: Claude Code. Today is <weekday>, <date> and the time is <HH:mm> in
 * America/Los_Angeles." -- told to the model directly since `--disable-slash-commands` means it
 * never sees the normal dynamic system-prompt sections (cwd, env, date) Claude Code usually adds. */
export function surfaceLine(now: DateTime): string {
  const weekday = now.toFormat('cccc');
  const date = now.toFormat('yyyy-LL-dd');
  const time = now.toFormat('HH:mm');
  return `Surface: Claude Code. Today is ${weekday}, ${date} and the time is ${time} in America/Los_Angeles.`;
}

// --- time/date resolvers wired to the real server-side implementation ---------------------

export function resolveTimeExpr(expr: string, now: Date): string {
  const result = parseTimeExpression(expr, { now, zone: ZONE });
  if (!result.ok)
    throw new Error(`cases.json time expression "${expr}" failed to resolve: ${result.error}`);
  return result.value.local;
}

export function resolveDateExpr(expr: string, now: Date): string {
  const result = parseDateExpression(expr, { now, zone: ZONE });
  if (!result.ok)
    throw new Error(`cases.json date expression "${expr}" failed to resolve: ${result.error}`);
  return result.value;
}

// --- running headless Claude Code ----------------------------------------------------------

interface ClaudeRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError?: string;
}

function runClaude(args: string[], cwd: string, timeoutMs: number): Promise<ClaudeRunResult> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolvePromise({
        stdout: '',
        stderr: '',
        code: null,
        signal: null,
        timedOut: false,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        stdout,
        stderr,
        code: null,
        signal: null,
        timedOut,
        spawnError: err.message,
      });
    });
    proc.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code, signal, timedOut });
    });
  });
}

interface ClaudeJsonResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
}

function parseClaudeJson(stdout: string): ClaudeJsonResult | null {
  try {
    return JSON.parse(stdout) as ClaudeJsonResult;
  } catch {
    return null;
  }
}

// --- one case end to end ---------------------------------------------------------------------

interface CaseOutcome {
  run: CaseRun;
  durationMs: number;
}

async function runOneCase(
  evalCase: EvalCase,
  opts: CliOptions,
  resultsDir: string,
): Promise<CaseOutcome> {
  const startedAt = new Date();
  const instance = await startEvalInstance(evalCase);
  const cwd = await mkdtemp(join(tmpdir(), 'claudia-eval-cwd-'));
  const mcpConfigPath = join(resultsDir, `${evalCase.id}.mcp.json`);

  try {
    const config = buildMcpConfig(instance.port, instance.token);
    await writeFile(mcpConfigPath, JSON.stringify(config), { mode: 0o600 });

    const now = DateTime.now().setZone(ZONE);
    const args = [
      '-p',
      evalCase.message,
      '--model',
      opts.model,
      '--permission-mode',
      'dontAsk',
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfigPath,
      '--allowedTools',
      'mcp__claudia-eval__*',
      '--append-system-prompt-file',
      SKILL_PATH,
      '--append-system-prompt',
      surfaceLine(now),
      '--disable-slash-commands',
      '--no-session-persistence',
      '--output-format',
      'json',
    ];

    const before = Date.now();
    const claudeResult = await runClaude(args, cwd, CASE_TIMEOUT_MS);
    const durationMs = Date.now() - before;

    const redactedStdout = redactToken(claudeResult.stdout, instance.token);
    const redactedStderr = redactToken(claudeResult.stderr, instance.token);
    await writeFile(
      join(resultsDir, `${evalCase.id}.log`),
      `--- stdout ---\n${redactedStdout}\n--- stderr ---\n${redactedStderr}\n`,
      'utf8',
    );

    let error: string | undefined;
    const parsed = parseClaudeJson(claudeResult.stdout);
    if (claudeResult.spawnError) {
      error = `claude could not be started: ${claudeResult.spawnError}`;
    } else if (claudeResult.timedOut) {
      error = `claude timed out after ${String(CASE_TIMEOUT_MS)}ms`;
    } else if (claudeResult.code !== 0) {
      const stderrTail = redactedStderr.trim().slice(-500);
      const reason = parsed?.result ?? (stderrTail || `exit code ${String(claudeResult.code)}`);
      error = `claude exited ${String(claudeResult.code)}: ${reason}`;
    } else if (parsed?.is_error) {
      error = `claude reported an error: ${parsed.result ?? parsed.subtype ?? 'unknown'}`;
    } else if (parsed === null) {
      error = 'claude did not produce parseable JSON output';
    }

    const saved = await instance.savedItems();
    const rulesAdded = instance.rulesAdded();

    const run: CaseRun = {
      caseId: evalCase.id,
      startedAt,
      saved,
      rulesAdded,
      ...(error ? { error } : {}),
    };

    await writeFile(
      join(resultsDir, `${evalCase.id}.json`),
      JSON.stringify(
        {
          caseId: evalCase.id,
          model: opts.model,
          startedAt: startedAt.toISOString(),
          durationMs,
          exitCode: claudeResult.code,
          signal: claudeResult.signal,
          timedOut: claudeResult.timedOut,
          spawnError: claudeResult.spawnError,
          claudeResult: parsed,
          saved,
          rulesAdded,
          error,
        },
        null,
        2,
      ),
      'utf8',
    );

    return { run, durationMs };
  } finally {
    await rm(mcpConfigPath, { force: true });
    await instance.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}

// --- concurrency pool --------------------------------------------------------------------

async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let next = 0;
  async function runner(): Promise<void> {
    for (;;) {
      const idx = next++;
      const item = items[idx];
      if (item === undefined && idx >= items.length) return;
      results[idx] = await worker(item as T);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runner()));
  return results;
}

// --- main ----------------------------------------------------------------------------------

async function loadCases(): Promise<EvalCase[]> {
  const text = await readFile(CASES_PATH, 'utf8');
  return JSON.parse(text) as EvalCase[];
}

export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const allCases = await loadCases();
  const selected = selectCases(allCases, opts);

  if (selected.length === 0) {
    console.error('No cases matched the given --ids/--category/--limit filters.');
    return 1;
  }

  const runId = DateTime.now().toFormat("yyyy-LL-dd'T'HHmmss'Z'");
  const resultsDir = join(HERE, 'results', runId);
  await mkdir(resultsDir, { recursive: true });

  console.log(
    `Running ${String(selected.length)} case(s) [${selected.map((c) => c.id).join(', ')}] ` +
      `with model ${opts.model}, concurrency ${String(opts.concurrency)}...`,
  );

  const outcomes = await runPool(selected, opts.concurrency, (c) =>
    runOneCase(c, opts, resultsDir),
  );

  for (const { run, durationMs } of outcomes) {
    const status = run.error ? `ERROR: ${run.error}` : 'ok';
    console.log(`  ${run.caseId}: ${(durationMs / 1000).toFixed(1)}s -- ${status}`);
  }

  const runs = outcomes.map((o) => o.run);
  const report: Report = scoreAll(selected, runs, {
    resolveTime: resolveTimeExpr,
    resolveDate: resolveDateExpr,
    zone: ZONE,
  });

  const reportText = formatReport(report);
  console.log('');
  console.log(reportText);

  await writeFile(join(resultsDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(join(resultsDir, 'report.txt'), `${reportText}\n`, 'utf8');
  console.log('');
  console.log(`Results written to ${resultsDir}`);

  return report.passed ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exitCode = 1;
    });
}
