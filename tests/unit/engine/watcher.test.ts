import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createWatcher, type WatchFn } from '../../../src/engine/watcher.ts';
import { createTempVault, removeTempVault, writeVaultFile } from '../../helpers/temp-vault.ts';

class FakeFsWatcher extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

function makeFakeWatch(): {
  watch: WatchFn;
  emit: (event: string, filename: string) => void;
  watcher: FakeFsWatcher;
} {
  const watcher = new FakeFsWatcher();
  let listener: ((event: string, filename: string) => void) | null = null;
  const watch = ((_path: unknown, _opts: unknown, cb: (e: string, f: string) => void) => {
    listener = cb;
    return watcher as unknown as ReturnType<WatchFn>;
  }) as WatchFn;
  return {
    watch,
    emit: (event, filename) => listener?.(event, filename),
    watcher,
  };
}

describe('createWatcher with an injected fake watch', () => {
  it('debounces multiple events into a single call with unique paths', async () => {
    const { watch, emit } = makeFakeWatch();
    const onChanges = vi.fn();
    const watcher = createWatcher({
      vaultDir: '/vault',
      onChanges,
      debounceMs: 20,
      watch,
    });
    watcher.start();

    emit('change', 'Tasks/To do.md');
    emit('change', 'Tasks/To do.md');
    emit('change', 'Tasks/Follow-ups.md');

    expect(onChanges).not.toHaveBeenCalled();
    await delay(60);
    expect(onChanges).toHaveBeenCalledTimes(1);
    const arg = onChanges.mock.calls[0]![0] as string[];
    expect(new Set(arg)).toEqual(new Set(['Tasks/To do.md', 'Tasks/Follow-ups.md']));

    watcher.stop();
  });

  it('filters out non-.md files, dot-folders and .claudia-tmp files', async () => {
    const { watch, emit } = makeFakeWatch();
    const onChanges = vi.fn();
    const watcher = createWatcher({ vaultDir: '/vault', onChanges, debounceMs: 10, watch });
    watcher.start();

    emit('change', 'Tasks/To do.md');
    emit('change', 'Tasks/notes.txt');
    emit('change', '.obsidian/workspace.json');
    emit('change', '.To do.abc123.claudia-tmp');
    emit('rename', 'Tasks/.To do.xyz.claudia-tmp');

    await delay(40);
    expect(onChanges).toHaveBeenCalledTimes(1);
    expect(onChanges.mock.calls[0]![0]).toEqual(['Tasks/To do.md']);

    watcher.stop();
  });

  it('calls onRescan on the given interval', async () => {
    const { watch } = makeFakeWatch();
    const onRescan = vi.fn();
    const watcher = createWatcher({
      vaultDir: '/vault',
      onChanges: () => {},
      rescanMs: 15,
      onRescan,
      watch,
    });
    watcher.start();
    await delay(50);
    watcher.stop();
    expect(onRescan.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('never throws when onChanges rejects', async () => {
    const { watch, emit } = makeFakeWatch();
    const onChanges = vi.fn().mockRejectedValue(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const watcher = createWatcher({ vaultDir: '/vault', onChanges, debounceMs: 5, watch });
    watcher.start();
    emit('change', 'Tasks/To do.md');
    await delay(30);
    expect(onChanges).toHaveBeenCalled();
    watcher.stop();
    errorSpy.mockRestore();
  });

  it('never throws when onChanges throws synchronously', async () => {
    const { watch, emit } = makeFakeWatch();
    const onChanges = vi.fn(() => {
      throw new Error('sync boom');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const watcher = createWatcher({ vaultDir: '/vault', onChanges, debounceMs: 5, watch });
    watcher.start();
    expect(() => emit('change', 'Tasks/To do.md')).not.toThrow();
    await delay(30);
    watcher.stop();
    errorSpy.mockRestore();
  });

  it('stop() closes the underlying watcher and clears timers so no further events fire', async () => {
    const { watch, emit, watcher: fakeWatcher } = makeFakeWatch();
    const onChanges = vi.fn();
    const watcher = createWatcher({ vaultDir: '/vault', onChanges, debounceMs: 10, watch });
    watcher.start();
    emit('change', 'Tasks/To do.md');
    watcher.stop();
    expect(fakeWatcher.closed).toBe(true);
    await delay(30);
    expect(onChanges).not.toHaveBeenCalled();
  });
});

describe('createWatcher with a real temp dir', () => {
  it('detects a real file write and reports the vault-relative path', async () => {
    const vaultDir = await createTempVault({ 'Tasks/To do.md': '# To do\n\n' });
    try {
      const seen: string[][] = [];
      const watcher = createWatcher({
        vaultDir,
        onChanges: (paths) => {
          seen.push(paths);
        },
        debounceMs: 30,
      });
      watcher.start();
      await delay(50);
      await writeVaultFile(vaultDir, 'Tasks/To do.md', '# To do\n\n- [ ] New ^t0001\n');
      await delay(300);
      watcher.stop();

      const all = seen.flat();
      expect(all).toContain('Tasks/To do.md');
    } finally {
      await removeTempVault(vaultDir);
    }
  });
});
