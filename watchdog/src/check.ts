// Minimal Workers KV surface used by the watchdog. We only ever get/put one
// JSON blob under a single key, so we do not need the full KVNamespace type
// (and we are not allowed to add the @cloudflare/workers-types dependency).
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface WatchdogState {
  consecutiveFailures: number;
  down: boolean;
  since: string | null;
  lastCheck: string;
  lastError: string | null;
}

export interface RunCheckDeps {
  fetch: typeof fetch;
  kv: KVLike;
  now: () => Date;
  healthUrl: string;
  alertTopicUrl: string;
  /** Defaults to 10s. */
  timeoutMs?: number;
}

export interface RunCheckResult {
  healthy: boolean;
  alerted: 'down' | 'recovered' | null;
  state: WatchdogState;
}

const STATE_KEY = 'state';
const FAILURE_THRESHOLD = 2;
const DEFAULT_TIMEOUT_MS = 10_000;

function defaultState(): WatchdogState {
  return {
    consecutiveFailures: 0,
    down: false,
    since: null,
    lastCheck: '',
    lastError: null,
  };
}

async function loadState(kv: KVLike): Promise<WatchdogState> {
  const raw = await kv.get(STATE_KEY);
  if (raw === null) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WatchdogState>;
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

async function saveState(kv: KVLike, state: WatchdogState): Promise<void> {
  await kv.put(STATE_KEY, JSON.stringify(state));
}

interface HealthCheckOutcome {
  healthy: boolean;
  error: string | null;
}

async function checkHealth(
  fetchImpl: typeof fetch,
  healthUrl: string,
  timeoutMs: number,
): Promise<HealthCheckOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(healthUrl, {
      method: 'GET',
      credentials: 'omit',
      signal: controller.signal,
    });

    if (response.status !== 200) {
      return { healthy: false, error: `unexpected HTTP status ${response.status}` };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { healthy: false, error: 'response body was not valid JSON' };
    }

    const status =
      body !== null && typeof body === 'object' && 'status' in body
        ? (body as { status?: unknown }).status
        : undefined;

    if (status === 'ok' || status === 'degraded') {
      return { healthy: true, error: null };
    }

    return { healthy: false, error: `health status was ${JSON.stringify(status)}` };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { healthy: false, error: `timed out after ${timeoutMs}ms` };
    }
    return { healthy: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

interface AlertOptions {
  title: string;
  message: string;
  priority: string;
  tags?: string;
}

async function sendAlert(
  fetchImpl: typeof fetch,
  alertTopicUrl: string,
  options: AlertOptions,
): Promise<void> {
  try {
    const headers: Record<string, string> = {
      Title: options.title,
      Priority: options.priority,
    };
    if (options.tags !== undefined) {
      headers['Tags'] = options.tags;
    }
    await fetchImpl(alertTopicUrl, {
      method: 'POST',
      headers,
      body: options.message,
    });
  } catch {
    // Alert delivery is best-effort: a failed ntfy push must never fail the check.
  }
}

/**
 * Runs one watchdog check: hits the Claudia /health endpoint, updates the
 * persisted state in KV, and fires an alert on the down/recovery edges only.
 */
export async function runCheck(deps: RunCheckDeps): Promise<RunCheckResult> {
  const { fetch: fetchImpl, kv, now, healthUrl, alertTopicUrl } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const state = await loadState(kv);
  const nowIso = now().toISOString();
  const outcome = await checkHealth(fetchImpl, healthUrl, timeoutMs);

  let alerted: 'down' | 'recovered' | null = null;

  if (outcome.healthy) {
    if (state.down) {
      alerted = 'recovered';
      await sendAlert(fetchImpl, alertTopicUrl, {
        title: 'Claudia is back',
        message: `Claudia recovered at ${nowIso}.`,
        priority: 'default',
      });
    }
    state.consecutiveFailures = 0;
    state.down = false;
    state.since = null;
    state.lastError = null;
  } else {
    state.consecutiveFailures += 1;
    state.lastError = outcome.error;

    if (state.consecutiveFailures >= FAILURE_THRESHOLD && !state.down) {
      state.down = true;
      state.since = nowIso;
      alerted = 'down';
      await sendAlert(fetchImpl, alertTopicUrl, {
        title: 'Claudia is down',
        message: `Claudia health check has failed ${String(state.consecutiveFailures)} times in a row, down since ${state.since}. Last error: ${state.lastError ?? 'unknown'}.`,
        priority: 'high',
        tags: 'warning',
      });
    }
  }

  state.lastCheck = nowIso;
  await saveState(kv, state);

  return { healthy: outcome.healthy, alerted, state };
}
