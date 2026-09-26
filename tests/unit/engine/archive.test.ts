import { describe, expect, it } from 'vitest';
import { archiveCompleted } from '../../../src/engine/archive.ts';
import { createVaultWriter } from '../../../src/engine/writer.ts';
import {
  createTempVault,
  readVaultFile,
  removeTempVault,
  vaultFileExists,
} from '../../helpers/temp-vault.ts';

async function withTempVault(
  files: Record<string, string>,
  fn: (vaultDir: string) => Promise<void>,
): Promise<void> {
  const vaultDir = await createTempVault(files);
  try {
    await fn(vaultDir);
  } finally {
    await removeTempVault(vaultDir);
  }
}

describe('archiveCompleted', () => {
  it('moves a done task whose ✅ date is before today into the Done note for that month', async () => {
    await withTempVault(
      {
        'Tasks/To do.md':
          '# To do\n\n- [x] Call the dentist ⏰ 2026-09-01 09:00 ✅ 2026-09-01 ^t0001\n- [ ] Still open ^t0002\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const moved = await archiveCompleted({ writer, today: '2026-09-26' });
        expect(moved).toEqual([
          { id: 't0001', from: 'Tasks/To do.md', to: 'Tasks/Done/2026-09.md' },
        ]);

        const todo = await readVaultFile(vaultDir, 'Tasks/To do.md');
        expect(todo).toBe('# To do\n\n- [ ] Still open ^t0002\n');

        const done = await readVaultFile(vaultDir, 'Tasks/Done/2026-09.md');
        expect(done).toBe(
          '# Done 2026-09\n\n- [x] Call the dentist ⏰ 2026-09-01 09:00 ✅ 2026-09-01 ^t0001\n',
        );
      },
    );
  });

  it('does not move a done task whose ✅ date is today', async () => {
    await withTempVault(
      { 'Tasks/To do.md': '# To do\n\n- [x] Done today ✅ 2026-09-26 ^t0001\n' },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const moved = await archiveCompleted({ writer, today: '2026-09-26' });
        expect(moved).toEqual([]);
        expect(await vaultFileExists(vaultDir, 'Tasks/Done/2026-09.md')).toBe(false);
      },
    );
  });

  it('moves a cancelled task whose ❌ date is before today', async () => {
    await withTempVault(
      { 'Tasks/To do.md': '# To do\n\n- [-] Cancelled thing ❌ 2026-08-15 ^t0001\n' },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const moved = await archiveCompleted({ writer, today: '2026-09-26' });
        expect(moved).toEqual([
          { id: 't0001', from: 'Tasks/To do.md', to: 'Tasks/Done/2026-08.md' },
        ]);
        expect(await readVaultFile(vaultDir, 'Tasks/Done/2026-08.md')).toBe(
          '# Done 2026-08\n\n- [-] Cancelled thing ❌ 2026-08-15 ^t0001\n',
        );
      },
    );
  });

  it('leaves a done/cancelled line with no done date in place', async () => {
    await withTempVault(
      { 'Tasks/To do.md': '# To do\n\n- [x] Done but no date ^t0001\n' },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const moved = await archiveCompleted({ writer, today: '2026-09-26' });
        expect(moved).toEqual([]);
        expect(await readVaultFile(vaultDir, 'Tasks/To do.md')).toBe(
          '# To do\n\n- [x] Done but no date ^t0001\n',
        );
      },
    );
  });

  it('archives from Follow-ups.md the same way', async () => {
    await withTempVault(
      {
        'Tasks/Follow-ups.md':
          '# Follow-ups\n\n- [x] Waiting on [[Alex]]: resume draft #waiting ➕ 2026-08-01 ✅ 2026-08-20 ^t0001\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const moved = await archiveCompleted({ writer, today: '2026-09-26' });
        expect(moved).toEqual([
          { id: 't0001', from: 'Tasks/Follow-ups.md', to: 'Tasks/Done/2026-08.md' },
        ]);
        expect(await readVaultFile(vaultDir, 'Tasks/Follow-ups.md')).toBe('# Follow-ups\n\n');
      },
    );
  });

  it('marks an open appointment more than one day overdue as done, using the appointment date, then archives it', async () => {
    await withTempVault(
      {
        'Tasks/Appointments.md':
          '# Appointments\n\n- [ ] Dentist cleaning #appointment 🗓️ 2026-09-20 15:00-16:00 ^a0001\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const moved = await archiveCompleted({ writer, today: '2026-09-26' });
        expect(moved).toEqual([
          { id: 'a0001', from: 'Tasks/Appointments.md', to: 'Tasks/Done/2026-09.md' },
        ]);
        const done = await readVaultFile(vaultDir, 'Tasks/Done/2026-09.md');
        expect(done).toBe(
          '# Done 2026-09\n\n- [x] Dentist cleaning #appointment 🗓️ 2026-09-20 15:00-16:00 ✅ 2026-09-20 ^a0001\n',
        );
        expect(await readVaultFile(vaultDir, 'Tasks/Appointments.md')).toBe('# Appointments\n\n');
      },
    );
  });

  it('does not touch an open appointment only one day past (stays open)', async () => {
    await withTempVault(
      {
        'Tasks/Appointments.md':
          '# Appointments\n\n- [ ] Dentist cleaning #appointment 🗓️ 2026-09-25 15:00-16:00 ^a0001\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const moved = await archiveCompleted({ writer, today: '2026-09-26' });
        expect(moved).toEqual([]);
        expect(await readVaultFile(vaultDir, 'Tasks/Appointments.md')).toBe(
          '# Appointments\n\n- [ ] Dentist cleaning #appointment 🗓️ 2026-09-25 15:00-16:00 ^a0001\n',
        );
      },
    );
  });

  it('does not touch a future or same-day open appointment', async () => {
    await withTempVault(
      {
        'Tasks/Appointments.md':
          '# Appointments\n\n- [ ] Future one #appointment 🗓️ 2026-10-01 10:00 ^a0001\n- [ ] Today one #appointment 🗓️ 2026-09-26 10:00 ^a0002\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const moved = await archiveCompleted({ writer, today: '2026-09-26' });
        expect(moved).toEqual([]);
      },
    );
  });

  it('groups lines that finished in different months into their respective Done notes', async () => {
    await withTempVault(
      {
        'Tasks/To do.md':
          '# To do\n\n- [x] August thing ✅ 2026-08-10 ^t0001\n- [x] September thing ✅ 2026-09-05 ^t0002\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const moved = await archiveCompleted({ writer, today: '2026-09-26' });
        expect(moved).toHaveLength(2);
        expect(await readVaultFile(vaultDir, 'Tasks/Done/2026-08.md')).toBe(
          '# Done 2026-08\n\n- [x] August thing ✅ 2026-08-10 ^t0001\n',
        );
        expect(await readVaultFile(vaultDir, 'Tasks/Done/2026-09.md')).toBe(
          '# Done 2026-09\n\n- [x] September thing ✅ 2026-09-05 ^t0002\n',
        );
      },
    );
  });

  it('appends to an existing Done note rather than overwriting it', async () => {
    await withTempVault(
      {
        'Tasks/To do.md': '# To do\n\n- [x] New done thing ✅ 2026-09-10 ^t0002\n',
        'Tasks/Done/2026-09.md': '# Done 2026-09\n\n- [x] Already archived ✅ 2026-09-01 ^t0001\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        await archiveCompleted({ writer, today: '2026-09-26' });
        expect(await readVaultFile(vaultDir, 'Tasks/Done/2026-09.md')).toBe(
          '# Done 2026-09\n\n- [x] Already archived ✅ 2026-09-01 ^t0001\n- [x] New done thing ✅ 2026-09-10 ^t0002\n',
        );
      },
    );
  });

  it('is idempotent: running twice in a row moves nothing the second time', async () => {
    await withTempVault(
      {
        'Tasks/To do.md': '# To do\n\n- [x] Done thing ✅ 2026-09-01 ^t0001\n',
        'Tasks/Appointments.md':
          '# Appointments\n\n- [ ] Overdue appt #appointment 🗓️ 2026-09-01 10:00 ^a0001\n',
      },
      async (vaultDir) => {
        const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
        const first = await archiveCompleted({ writer, today: '2026-09-26' });
        expect(first).toHaveLength(2);
        const second = await archiveCompleted({ writer, today: '2026-09-26' });
        expect(second).toEqual([]);
        expect(await readVaultFile(vaultDir, 'Tasks/To do.md')).toBe('# To do\n\n');
        expect(await readVaultFile(vaultDir, 'Tasks/Appointments.md')).toBe('# Appointments\n\n');
      },
    );
  });

  it('does nothing when the source files do not exist', async () => {
    await withTempVault({}, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      const moved = await archiveCompleted({ writer, today: '2026-09-26' });
      expect(moved).toEqual([]);
    });
  });

  it('leaves untouched lines in the source byte-identical', async () => {
    const original =
      '# To do\r\n\r\n- [ ] Keep me exactly as I am ⏰ 2026-09-30 09:00 ^t0002\r\n- [x] Archive me ✅ 2026-08-01 ^t0001\r\n';
    await withTempVault({ 'Tasks/To do.md': original }, async (vaultDir) => {
      const writer = createVaultWriter({ vaultDir, quietMs: 0, maxWaitMs: 0 });
      await archiveCompleted({ writer, today: '2026-09-26' });
      const text = await readVaultFile(vaultDir, 'Tasks/To do.md');
      expect(text).toBe(
        '# To do\r\n\r\n- [ ] Keep me exactly as I am ⏰ 2026-09-30 09:00 ^t0002\r\n',
      );
    });
  });
});
