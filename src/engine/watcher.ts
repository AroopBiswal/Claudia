// Vault file watcher (docs/PLAN.md "Writing safely" / sync conflicts): a
// debounced fs.watch over the vault that reports unique, vault-relative
// Markdown paths, plus a periodic rescan as a safety net for missed events.
// Never crashes the process: callback errors are caught and logged.

import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { sep } from 'node:path';
import { isIgnoredPath } from '../vault/layout.ts';

export type WatchFn = typeof fsWatch;

export interface CreateWatcherOptions {
  vaultDir: string;
  onChanges: (relPaths: string[]) => void | Promise<void>;
  debounceMs?: number;
  rescanMs?: number;
  onRescan?: () => void | Promise<void>;
  watch?: WatchFn;
}

export interface Watcher {
  start(): void;
  stop(): void;
}

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_RESCAN_MS = 5 * 60 * 1000;

function toRelPosix(filename: string): string {
  return sep === '/' ? filename : filename.split(sep).join('/');
}

function isTempFile(relPath: string): boolean {
  return relPath.endsWith('.claudia-tmp');
}

function isMarkdownChange(relPath: string): boolean {
  if (!relPath.endsWith('.md')) return false;
  if (isTempFile(relPath)) return false;
  if (isIgnoredPath(relPath)) return false;
  return true;
}

export function createWatcher(opts: CreateWatcherOptions): Watcher {
  const vaultDir = opts.vaultDir;
  const onChanges = opts.onChanges;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const rescanMs = opts.rescanMs ?? DEFAULT_RESCAN_MS;
  const onRescan = opts.onRescan;
  const watchFn = opts.watch ?? fsWatch;

  let watcher: FSWatcher | { close: () => void } | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let rescanTimer: ReturnType<typeof setInterval> | null = null;
  let pending = new Set<string>();

  function flush(): void {
    debounceTimer = null;
    if (pending.size === 0) return;
    const relPaths = Array.from(pending);
    pending = new Set();
    try {
      Promise.resolve(onChanges(relPaths)).catch((err: unknown) => {
        console.error('[watcher] onChanges failed', err);
      });
    } catch (err) {
      console.error('[watcher] onChanges threw synchronously', err);
    }
  }

  function scheduleFlush(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, debounceMs);
    debounceTimer.unref?.();
  }

  function handleEvent(_eventType: string, filename: string | Buffer | null): void {
    try {
      if (!filename) return;
      const relPath = toRelPosix(filename.toString());
      if (!isMarkdownChange(relPath)) return;
      pending.add(relPath);
      scheduleFlush();
    } catch (err) {
      console.error('[watcher] error handling fs event', err);
    }
  }

  function runRescan(): void {
    if (!onRescan) return;
    try {
      Promise.resolve(onRescan()).catch((err: unknown) => {
        console.error('[watcher] onRescan failed', err);
      });
    } catch (err) {
      console.error('[watcher] onRescan threw synchronously', err);
    }
  }

  function start(): void {
    watcher = watchFn(vaultDir, { recursive: true }, handleEvent);
    if (watcher && 'on' in watcher && typeof watcher.on === 'function') {
      watcher.on('error', (err: unknown) => {
        console.error('[watcher] fs.watch error', err);
      });
    }
    rescanTimer = setInterval(runRescan, rescanMs);
    rescanTimer.unref?.();
  }

  function stop(): void {
    if (watcher) {
      try {
        watcher.close();
      } catch (err) {
        console.error('[watcher] error closing watcher', err);
      }
      watcher = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (rescanTimer) {
      clearInterval(rescanTimer);
      rescanTimer = null;
    }
    pending = new Set();
  }

  return { start, stop };
}
