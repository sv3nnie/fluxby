/**
 * Shared in-memory database double for sync tests.
 *
 * Understands just enough SQL for the sync helpers in @fluxby/database:
 * SELECT ... FROM <table>, INSERT and UPDATE.
 */
import { vi } from 'vitest';
import type { SyncDatabaseAdapter, SyncableRow } from '@fluxby/database';

export const TEST_PROFILE = 'profile-1';

/**
 * In-memory adapter that understands just enough SQL for the sync helpers:
 * SELECT ... FROM <table>, INSERT and UPDATE.
 */
export function createFakeAdapter(seed: Record<string, SyncableRow[]> = {}) {
  const tables: Record<string, SyncableRow[]> = {};
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((r) => ({ ...r }));
  }

  const adapter: SyncDatabaseAdapter = {
    query: vi.fn(
      async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
        const table = sql.match(/FROM\s+(\w+)/i)?.[1];
        if (!table) return [] as T[];
        const rows = tables[table] ?? [];

        // iterateProfileRows keyset page:
        //   (updated_at > ? OR (updated_at = ? AND id > ?)) ORDER BY .. LIMIT ?
        // Must honour ORDER BY and LIMIT, otherwise a test asserting that
        // paging is memory-bounded would pass against a single huge page.
        if (/updated_at\s*=\s*\?\s*AND\s+id\s*>/i.test(sql)) {
          const [, lastUpdatedAt, , lastId, limit] = params as [
            string,
            number,
            number,
            string,
            number,
          ];
          return [...rows]
            .sort(
              (a, b) =>
                a.updated_at - b.updated_at ||
                String(a.id).localeCompare(String(b.id))
            )
            .filter(
              (r) =>
                r.updated_at > lastUpdatedAt ||
                (r.updated_at === lastUpdatedAt && String(r.id) > lastId)
            )
            .slice(0, limit) as T[];
        }
        // getChangesSince: WHERE profile_id = ? AND updated_at > ?
        if (/updated_at\s*>/.test(sql)) {
          const since = Number(params[1] ?? 0);
          return rows.filter((r) => r.updated_at > since) as T[];
        }
        // applySyncData existence probe: WHERE id = ? AND profile_id = ?
        if (/WHERE\s+id\s*=/.test(sql)) {
          return rows.filter((r) => r.id === params[0]) as T[];
        }
        return rows as T[];
      }
    ),

    run: vi.fn(async (sql: string, params: unknown[] = []) => {
      const insert = sql.match(/INSERT INTO\s+(\w+)\s*\(([^)]+)\)/i);
      if (insert) {
        const [, table, columnList] = insert;
        const columns = columnList.split(',').map((c) => c.trim());
        const row = Object.fromEntries(
          columns.map((c, i) => [c, params[i]])
        ) as SyncableRow;
        tables[table] = [...(tables[table] ?? []), row];
        return { changes: 1 };
      }

      const update = sql.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE/is);
      if (update) {
        const [, table, setClause] = update;
        const columns = setClause.split(',').map((c) => c.split('=')[0].trim());
        // Trailing params after the SET values are id then profile_id.
        const id = params[columns.length];
        const target = (tables[table] ?? []).find((r) => r.id === id);
        if (!target) return { changes: 0 };
        columns.forEach((c, i) => {
          (target as Record<string, unknown>)[c] = params[i];
        });
        return { changes: 1 };
      }
      return { changes: 0 };
    }),

    transaction: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => fn()),
    getProfileId: vi.fn(() => TEST_PROFILE),
  };

  return { adapter, tables };
}
