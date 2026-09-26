import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Runtime configuration. Non-secret settings live in `$CLAUDIA_HOME/config.json` (default ~/.claudia);
 * secrets live as separate files under `$CLAUDIA_HOME/secrets` and are only referenced by path here.
 * Product behaviour (brief time, time zone, nudges) lives in the vault's _claudia/Settings.md instead.
 */
export interface ClaudiaConfig {
  home: string;
  vaultPath: string;
  vaultName: string;
  host: string;
  port: number;
  publicUrl: string;
  ownerEmail: string | null;
  access: { teamDomain: string | null; audience: string | null };
  ntfy: { baseUrl: string; topic: string | null; tokenFile: string };
  calendar: { clientSecretsFile: string; tokenFile: string; idFile: string };
  quietMs: number;
  paths: {
    indexDb: string;
    stateDb: string;
    secretsDir: string;
    logsDir: string;
    backupsDir: string;
    actionKeyFile: string;
    oauthKeyFile: string;
  };
}

const fileSchema = z
  .object({
    vaultPath: z.string().min(1),
    vaultName: z.string().min(1).default('Claudia'),
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(8787),
    publicUrl: z.url().default('https://claudia.aroopbiswal.com'),
    ownerEmail: z.email().nullable().default(null),
    access: z
      .object({
        teamDomain: z.string().min(1).nullable().default(null),
        audience: z.string().min(1).nullable().default(null),
      })
      .default({ teamDomain: null, audience: null }),
    ntfy: z
      .object({
        baseUrl: z.url().default('http://127.0.0.1:8790'),
        topic: z.string().min(1).nullable().default(null),
      })
      .default({ baseUrl: 'http://127.0.0.1:8790', topic: null }),
    quietMs: z.number().int().min(0).max(60_000).default(3000),
  })
  .strict();

export type ConfigFile = z.input<typeof fileSchema>;

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CLAUDIA_HOME ?? join(homedir(), '.claudia'));
}

/** Builds a config from an already-parsed config.json object (used by tests and by loadConfig). */
export function configFromObject(
  home: string,
  raw: unknown,
  env: NodeJS.ProcessEnv = {},
): ClaudiaConfig {
  const withEnv = { ...(raw as Record<string, unknown>) };
  if (env.CLAUDIA_VAULT) withEnv.vaultPath = env.CLAUDIA_VAULT;
  if (env.CLAUDIA_HOST) withEnv.host = env.CLAUDIA_HOST;
  if (env.CLAUDIA_PORT) withEnv.port = Number(env.CLAUDIA_PORT);
  if (env.CLAUDIA_PUBLIC_URL) withEnv.publicUrl = env.CLAUDIA_PUBLIC_URL;
  const parsed = fileSchema.safeParse(withEnv);
  if (!parsed.success) {
    throw new Error(`Invalid Claudia config: ${z.prettifyError(parsed.error)}`);
  }
  const c = parsed.data;
  const secretsDir = join(home, 'secrets');
  return {
    home,
    vaultPath: resolve(c.vaultPath),
    vaultName: c.vaultName,
    host: c.host,
    port: c.port,
    publicUrl: c.publicUrl.replace(/\/+$/, ''),
    ownerEmail: c.ownerEmail,
    access: c.access,
    ntfy: {
      baseUrl: c.ntfy.baseUrl,
      topic: c.ntfy.topic,
      tokenFile: join(secretsDir, 'ntfy-token'),
    },
    calendar: {
      clientSecretsFile: join(secretsDir, 'google-oauth-client.json'),
      tokenFile: join(secretsDir, 'google-token.json'),
      idFile: join(home, 'calendar-id'),
    },
    quietMs: c.quietMs,
    paths: {
      indexDb: join(home, 'index.db'),
      stateDb: join(home, 'state.db'),
      secretsDir,
      logsDir: join(home, 'logs'),
      backupsDir: join(home, 'backups'),
      actionKeyFile: join(secretsDir, 'action-links.key'),
      oauthKeyFile: join(secretsDir, 'oauth-signing.key'),
    },
  };
}

/** Loads `$CLAUDIA_HOME/config.json`. Fails loudly: the vault path must be configured explicitly. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClaudiaConfig {
  const home = defaultHome(env);
  const file = join(home, 'config.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${(error as Error).message}`, { cause: error });
  }
  return configFromObject(home, raw, env);
}
