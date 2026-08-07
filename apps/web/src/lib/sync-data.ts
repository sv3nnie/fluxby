/**
 * Sync <-> database plumbing.
 *
 * The merge rules already live in @fluxby/database (applySyncData,
 * getChangesSince); what was missing was anything that called them. These
 * helpers are the join, kept free of React so they can be tested directly.
 */

import {
  SYNCABLE_TABLES,
  applySyncData,
  getChangesSince,
  type SyncDatabaseAdapter,
  type SyncableTable,
  type SyncableRow as DbSyncableRow,
} from '@fluxby/database';
import type { SyncChange, SyncableRow } from '@fluxby/core';

/**
 * SQLite has no boolean type and stores is_deleted as 0/1, while SyncChange
 * rows travelling between devices use real booleans. Convert at the boundary
 * so neither side has to know about the other's representation.
 */
export function toWireRow(row: DbSyncableRow): SyncableRow {
  return { ...row, is_deleted: row.is_deleted === 1 } as SyncableRow;
}

export function toDbRow(row: SyncableRow): DbSyncableRow {
  return { ...row, is_deleted: row.is_deleted ? 1 : 0 } as DbSyncableRow;
}

export function isSyncableTable(table: string): table is SyncableTable {
  return (SYNCABLE_TABLES as readonly string[]).includes(table);
}

export interface ApplyIncomingResult {
  applied: number;
  skipped: number;
  /** Changes dropped because their table is not syncable */
  ignored: number;
}

/**
 * Write changes received from another device into the local database.
 *
 * Rejects if any table fails, because callers use rejection to decide whether
 * a batch may be marked as consumed. Conflicts themselves are not failures --
 * applySyncData resolves those with Last-Write-Wins.
 */
export async function applyIncomingChanges(
  adapter: SyncDatabaseAdapter,
  deviceId: string,
  changes: SyncChange<SyncableRow>[]
): Promise<ApplyIncomingResult> {
  const result: ApplyIncomingResult = { applied: 0, skipped: 0, ignored: 0 };
  if (changes.length === 0) return result;

  const profileId = adapter.getProfileId();

  // Group by table so each table is applied in a single transaction.
  const byTable = new Map<SyncableTable, DbSyncableRow[]>();
  for (const change of changes) {
    if (!isSyncableTable(change.table)) {
      result.ignored++;
      continue;
    }
    const rows = byTable.get(change.table) ?? [];
    // Incoming rows belong to whichever profile this device is syncing.
    rows.push({ ...toDbRow(change.row), profile_id: profileId });
    byTable.set(change.table, rows);
  }

  for (const [table, rows] of byTable) {
    const { applied, skipped } = await applySyncData(
      adapter,
      table,
      rows,
      deviceId
    );
    result.applied += applied;
    result.skipped += skipped;
  }

  return result;
}

/**
 * Collect every row in the active profile changed after `since`.
 *
 * A failing table is logged and skipped rather than aborting the sweep, so one
 * bad table cannot block sync for all the others.
 */
export async function collectLocalChanges(
  adapter: SyncDatabaseAdapter,
  since: number
): Promise<SyncChange<SyncableRow>[]> {
  const changes: SyncChange<SyncableRow>[] = [];

  for (const table of SYNCABLE_TABLES) {
    try {
      const rows = await getChangesSince(adapter, table, since);
      for (const row of rows) {
        changes.push({ table, row: toWireRow(row) });
      }
    } catch (error) {
      console.warn(`[sync] Could not read changes from ${table}:`, error);
    }
  }

  return changes;
}

/**
 * Where to move the push cursor after a sweep that started at `sweepStartedAt`.
 *
 * Deliberately not the highest `updated_at` seen: getChangesSince filters on
 * `updated_at > cursor`, so a row written in the same millisecond as the
 * newest row, but after the query ran, would never be collected again. Anchor
 * to just before the sweep start instead. Anything written from that instant
 * onwards is re-examined next time, which at worst re-sends a row -- and
 * re-sending is harmless under Last-Write-Wins, whereas skipping is not.
 */
export function nextPushCursor(
  sweepStartedAt: number,
  currentCursor: number
): number {
  return Math.max(currentCursor, sweepStartedAt - 1);
}
