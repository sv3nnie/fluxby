/**
 * Tests for the sync <-> database join.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SyncableRow } from '@fluxby/database';
import type { SyncChange, SyncableRow as WireRow } from '@fluxby/core';
import { createFakeAdapter, TEST_PROFILE } from './helpers/fake-sync-db';
import {
  applyIncomingChanges,
  collectLocalChanges,
  nextPushCursor,
  isSyncableTable,
  toDbRow,
  toWireRow,
} from '@/lib/sync-data';

const PROFILE = TEST_PROFILE;
const LOCAL_DEVICE = 'device-local';
const REMOTE_DEVICE = 'device-remote';

function dbRow(overrides: Partial<SyncableRow> = {}): SyncableRow {
  return {
    id: 'row-1',
    updated_at: 1000,
    is_deleted: 0,
    device_id: REMOTE_DEVICE,
    profile_id: PROFILE,
    ...overrides,
  };
}

function change(
  row: Partial<WireRow>,
  table = 'transactions'
): SyncChange<WireRow> {
  return {
    table,
    row: {
      id: 'row-1',
      updated_at: 2000,
      is_deleted: false,
      device_id: REMOTE_DEVICE,
      ...row,
    } as WireRow,
  };
}

describe('row representation', () => {
  it('converts SQLite 0/1 to booleans and back', () => {
    expect(toWireRow(dbRow({ is_deleted: 1 })).is_deleted).toBe(true);
    expect(toWireRow(dbRow({ is_deleted: 0 })).is_deleted).toBe(false);
    expect(toDbRow(change({ is_deleted: true }).row).is_deleted).toBe(1);
    expect(toDbRow(change({ is_deleted: false }).row).is_deleted).toBe(0);
  });

  it('round-trips without corrupting other fields', () => {
    const original = dbRow({ id: 'abc', updated_at: 42, is_deleted: 1 });
    const round = toDbRow(toWireRow(original));
    expect(round).toEqual(original);
  });

  it('recognises only known syncable tables', () => {
    expect(isSyncableTable('transactions')).toBe(true);
    expect(isSyncableTable('accounts')).toBe(true);
    expect(isSyncableTable('users')).toBe(false);
  });
});

describe('applyIncomingChanges', () => {
  let fake: ReturnType<typeof createFakeAdapter>;

  beforeEach(() => {
    fake = createFakeAdapter({ transactions: [], accounts: [] });
  });

  it('inserts a row that does not exist locally', async () => {
    const result = await applyIncomingChanges(fake.adapter, LOCAL_DEVICE, [
      change({ id: 'new-row' }),
    ]);

    expect(result.applied).toBe(1);
    expect(fake.tables.transactions).toHaveLength(1);
    expect(fake.tables.transactions[0].id).toBe('new-row');
    // Booleans must land in the database as 0/1.
    expect(fake.tables.transactions[0].is_deleted).toBe(0);
  });

  it('stamps incoming rows with the active profile', async () => {
    await applyIncomingChanges(fake.adapter, LOCAL_DEVICE, [
      change({ id: 'new-row' }),
    ]);
    expect(fake.tables.transactions[0].profile_id).toBe(PROFILE);
  });

  it('overwrites when the remote row is newer', async () => {
    fake = createFakeAdapter({
      transactions: [dbRow({ id: 'r', updated_at: 1000 })],
    });

    const result = await applyIncomingChanges(fake.adapter, LOCAL_DEVICE, [
      change({ id: 'r', updated_at: 5000 }),
    ]);

    expect(result.applied).toBe(1);
    expect(fake.tables.transactions[0].updated_at).toBe(5000);
  });

  it('keeps the local row when it is newer', async () => {
    fake = createFakeAdapter({
      transactions: [dbRow({ id: 'r', updated_at: 9000 })],
    });

    const result = await applyIncomingChanges(fake.adapter, LOCAL_DEVICE, [
      change({ id: 'r', updated_at: 1000 }),
    ]);

    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(fake.tables.transactions[0].updated_at).toBe(9000);
  });

  it('propagates a soft delete', async () => {
    fake = createFakeAdapter({
      transactions: [dbRow({ id: 'r', updated_at: 1000, is_deleted: 0 })],
    });

    await applyIncomingChanges(fake.adapter, LOCAL_DEVICE, [
      change({ id: 'r', updated_at: 2000, is_deleted: true }),
    ]);

    expect(fake.tables.transactions[0].is_deleted).toBe(1);
  });

  it('ignores changes for tables that are not syncable', async () => {
    const result = await applyIncomingChanges(fake.adapter, LOCAL_DEVICE, [
      change({ id: 'x' }, 'users'),
    ]);

    expect(result.ignored).toBe(1);
    expect(result.applied).toBe(0);
  });

  it('spreads a mixed batch across the right tables', async () => {
    await applyIncomingChanges(fake.adapter, LOCAL_DEVICE, [
      change({ id: 't1' }, 'transactions'),
      change({ id: 'a1' }, 'accounts'),
      change({ id: 't2' }, 'transactions'),
    ]);

    expect(fake.tables.transactions.map((r) => r.id)).toEqual(['t1', 't2']);
    expect(fake.tables.accounts.map((r) => r.id)).toEqual(['a1']);
  });

  it('rejects when the database write fails', async () => {
    // Callers rely on rejection to avoid marking a batch as consumed.
    fake.adapter.run = vi.fn(async () => {
      throw new Error('disk full');
    });

    await expect(
      applyIncomingChanges(fake.adapter, LOCAL_DEVICE, [change({ id: 'r' })])
    ).rejects.toThrow('disk full');
  });

  it('is a no-op for an empty change set', async () => {
    const result = await applyIncomingChanges(fake.adapter, LOCAL_DEVICE, []);
    expect(result).toEqual({ applied: 0, skipped: 0, ignored: 0 });
    expect(fake.adapter.run).not.toHaveBeenCalled();
  });
});

describe('collectLocalChanges', () => {
  it('returns only rows newer than the cursor', async () => {
    const { adapter } = createFakeAdapter({
      transactions: [
        dbRow({ id: 'old', updated_at: 500 }),
        dbRow({ id: 'new', updated_at: 1500 }),
      ],
    });

    const changes = await collectLocalChanges(adapter, 1000);

    expect(changes.map((c) => c.row.id)).toEqual(['new']);
    expect(changes[0].table).toBe('transactions');
  });

  it('emits wire rows with boolean is_deleted', async () => {
    const { adapter } = createFakeAdapter({
      transactions: [dbRow({ id: 'gone', updated_at: 1500, is_deleted: 1 })],
    });

    const changes = await collectLocalChanges(adapter, 0);
    expect(changes[0].row.is_deleted).toBe(true);
  });

  it('gathers rows across every syncable table', async () => {
    const { adapter } = createFakeAdapter({
      transactions: [dbRow({ id: 't', updated_at: 1500 })],
      accounts: [dbRow({ id: 'a', updated_at: 1500 })],
      budgets: [dbRow({ id: 'b', updated_at: 1500 })],
    });

    const changes = await collectLocalChanges(adapter, 0);
    expect(changes.map((c) => c.row.id).sort()).toEqual(['a', 'b', 't']);
  });

  it('skips a failing table instead of aborting the sweep', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(vi.fn());
    const { adapter } = createFakeAdapter({
      transactions: [dbRow({ id: 't', updated_at: 1500 })],
    });

    const original = adapter.query;
    adapter.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (/FROM\s+accounts/i.test(sql)) throw new Error('table missing');
      return original(sql, params);
    }) as typeof adapter.query;

    const changes = await collectLocalChanges(adapter, 0);

    // The healthy table still made it through.
    expect(changes.map((c) => c.row.id)).toEqual(['t']);
    warn.mockRestore();
  });
});

describe('nextPushCursor', () => {
  it('anchors just before the sweep start, not at it', () => {
    // getChangesSince filters on `> cursor`, so a row written during the sweep
    // must still be visible next time.
    expect(nextPushCursor(1000, 0)).toBe(999);
  });

  it('never moves the cursor backwards', () => {
    expect(nextPushCursor(1000, 5000)).toBe(5000);
  });

  it('re-collects a row written in the same millisecond as the sweep', () => {
    const cursor = nextPushCursor(1000, 0);
    const rowWrittenDuringSweep = 1000;
    expect(rowWrittenDuringSweep > cursor).toBe(true);
  });
});

describe('round trip between two devices', () => {
  it('carries a local change through to the other device intact', async () => {
    // Device A has a soft-deleted transaction it has not yet shared.
    const deviceA = createFakeAdapter({
      transactions: [
        dbRow({
          id: 'shared-row',
          updated_at: 4242,
          is_deleted: 1,
          device_id: 'device-a',
        }),
      ],
    });
    const deviceB = createFakeAdapter({ transactions: [] });

    const outbound = await collectLocalChanges(deviceA.adapter, 0);
    await applyIncomingChanges(deviceB.adapter, 'device-b', outbound);

    expect(deviceB.tables.transactions).toHaveLength(1);
    expect(deviceB.tables.transactions[0]).toMatchObject({
      id: 'shared-row',
      updated_at: 4242,
      is_deleted: 1,
      device_id: 'device-a',
    });
  });
});
