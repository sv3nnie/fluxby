/**
 * Client-side snapshot creation and restore, against the real server.
 *
 * The point of snapshots is large datasets, so these tests care as much about
 * memory and chunking behaviour as about correctness.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import request from 'supertest';
import type { SyncChange, SyncableRow } from '@fluxby/core';
import { createApp } from '../../../apps/sync-server/src/app.js';
import { VaultStore } from '../../../apps/sync-server/src/store.js';
import { createFakeAdapter, TEST_PROFILE } from '../helpers/fake-sync-db';

const cursors = new Map<string, number>();
let activeDevice = 'device-a';
vi.mock('@/addons/remote-sync/config', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/addons/remote-sync/config')>();
  return {
    ...actual,
    loadCursor: async (vaultId: string) =>
      cursors.get(`${activeDevice}:${vaultId}`) ?? 0,
    saveCursor: async (vaultId: string, seq: number) => {
      const key = `${activeDevice}:${vaultId}`;
      if ((cursors.get(key) ?? 0) < seq) cursors.set(key, seq);
    },
  };
});

const { deriveVaultKeys } = await import('@/addons/remote-sync/crypto');
const { RemoteSyncClient } = await import('@/addons/remote-sync/client');
const {
  createSnapshot,
  restoreSnapshot,
  shouldCreateSnapshot,
  DEFAULT_CHUNK_TARGET_BYTES,
} = await import('@/addons/remote-sync/snapshot');
const { applyIncomingChanges } = await import('@/lib/sync-data');
const { iterateProfileRows } = await import('@/lib/sync-data');

import type { VaultKeys } from '@/addons/remote-sync/crypto';

/** Narrows a nullable value, failing the test with a clear message instead. */
function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to exist`);
  }
  return value;
}

let keys: VaultKeys;
let store: VaultStore;
let app: ReturnType<typeof createApp>;
let client: InstanceType<typeof RemoteSyncClient>;

function installServerBridge() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      const path = target.pathname + target.search;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const method = (init?.method ?? 'GET').toUpperCase();

      let call =
        method === 'POST'
          ? request(app).post(path)
          : method === 'PUT'
            ? request(app).put(path)
            : request(app).get(path);

      for (const [key, value] of Object.entries(headers)) {
        call = call.set(key, value);
      }
      if (init?.body) call = call.send(JSON.parse(String(init.body)));

      const res = await call;
      return new Response(JSON.stringify(res.body), {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      });
    })
  );
}

/** `count` transactions with realistic-ish payload sizes. */
function seedRows(count: number, prefix = 'txn') {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${String(i).padStart(6, '0')}`,
    // Deliberately identical timestamps for most rows: bulk imports do this,
    // and keyset pagination has to survive it.
    updated_at: 1000 + Math.floor(i / 100),
    is_deleted: 0,
    device_id: 'device-a',
    profile_id: TEST_PROFILE,
    amount: -(i % 500) - 0.99,
    description: `Merchant ${i} ${'x'.repeat(40)}`,
  }));
}

beforeAll(async () => {
  keys = await deriveVaultKeys('snapshot passphrase', 'snap@example.com');
}, 30_000);

beforeEach(() => {
  cursors.clear();
  activeDevice = 'device-a';
  store = new VaultStore(':memory:');
  app = createApp({ store, rateLimitMax: 0 });
  installServerBridge();
  client = new RemoteSyncClient({
    serverUrl: 'http://sync.test',
    vaultId: keys.vaultId,
    authToken: keys.authToken,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.close();
});

describe('iterateProfileRows', () => {
  it('pages through every row exactly once', async () => {
    const { adapter } = createFakeAdapter({ transactions: seedRows(1000) });

    const seen: string[] = [];
    for await (const page of iterateProfileRows(adapter, 100)) {
      seen.push(...page.map((c) => c.row.id));
    }

    expect(seen).toHaveLength(1000);
    expect(new Set(seen).size).toBe(1000);
  });

  it('never yields more than a page at a time', async () => {
    const { adapter } = createFakeAdapter({ transactions: seedRows(500) });

    const pageSizes: number[] = [];
    for await (const page of iterateProfileRows(adapter, 50)) {
      pageSizes.push(page.length);
    }

    // This is the property that keeps snapshotting memory-bounded.
    expect(Math.max(...pageSizes)).toBeLessThanOrEqual(50);
    expect(pageSizes.reduce((a, b) => a + b, 0)).toBe(500);
  });

  it('survives many rows sharing one updated_at', async () => {
    const rows = seedRows(300).map((r) => ({ ...r, updated_at: 5000 }));
    const { adapter } = createFakeAdapter({ transactions: rows });

    const seen: string[] = [];
    for await (const page of iterateProfileRows(adapter, 50)) {
      seen.push(...page.map((c) => c.row.id));
    }

    // Paging on updated_at alone would loop forever or skip rows here.
    expect(new Set(seen).size).toBe(300);
  });

  it('spans every syncable table', async () => {
    const { adapter } = createFakeAdapter({
      transactions: seedRows(10, 'txn'),
      accounts: seedRows(5, 'acct'),
      budgets: seedRows(3, 'budget'),
    });

    const seen: string[] = [];
    for await (const page of iterateProfileRows(adapter, 4)) {
      seen.push(...page.map((c) => c.row.id));
    }
    expect(seen).toHaveLength(18);
  });
});

describe('createSnapshot', () => {
  it('splits a large dataset into multiple bounded chunks', async () => {
    const { adapter } = createFakeAdapter({ transactions: seedRows(2000) });
    store.authenticate(keys.vaultId, keys.authToken);
    store.append(keys.vaultId, 'device-a', 'batch');

    const result = await createSnapshot({
      adapter,
      client,
      keys,
      deviceId: 'device-a',
      throughSeq: 1,
      chunkTargetBytes: 32 * 1024,
      pageSize: 100,
    });

    expect(result.rowCount).toBe(2000);
    expect(result.chunkCount).toBeGreaterThan(1);

    // Every chunk must fit inside the server's per-payload limit.
    for (let i = 0; i < result.chunkCount; i++) {
      const payload = store.getSnapshotChunk(
        keys.vaultId,
        result.snapshotId,
        i
      );
      expect(required(payload, 'chunk payload').length).toBeLessThan(
        1024 * 1024
      );
    }
  }, 30_000);

  it('writes a single chunk for a small dataset', async () => {
    const { adapter } = createFakeAdapter({ transactions: seedRows(5) });
    store.authenticate(keys.vaultId, keys.authToken);
    store.append(keys.vaultId, 'device-a', 'batch');

    const result = await createSnapshot({
      adapter,
      client,
      keys,
      deviceId: 'device-a',
      throughSeq: 1,
    });

    expect(result.chunkCount).toBe(1);
    expect(result.rowCount).toBe(5);
  });

  it('produces no chunks for an empty dataset', async () => {
    const { adapter } = createFakeAdapter({ transactions: [] });
    store.authenticate(keys.vaultId, keys.authToken);

    const result = await createSnapshot({
      adapter,
      client,
      keys,
      deviceId: 'device-a',
      throughSeq: 0,
    });

    expect(result).toMatchObject({ chunkCount: 0, rowCount: 0 });
    expect(store.getSnapshot(keys.vaultId)?.chunkCount).toBe(0);
  });

  it('stores nothing the server can read', async () => {
    const { adapter } = createFakeAdapter({
      transactions: [
        {
          id: 'secret',
          updated_at: 1,
          is_deleted: 0,
          device_id: 'device-a',
          profile_id: TEST_PROFILE,
          description: 'VERY_SECRET_MERCHANT',
        },
      ],
    });
    store.authenticate(keys.vaultId, keys.authToken);
    store.append(keys.vaultId, 'device-a', 'batch');

    const result = await createSnapshot({
      adapter,
      client,
      keys,
      deviceId: 'device-a',
      throughSeq: 1,
    });

    const payload = store.getSnapshotChunk(keys.vaultId, result.snapshotId, 0);
    expect(payload).not.toContain('VERY_SECRET_MERCHANT');
    expect(atob(payload ?? '')).not.toContain('VERY_SECRET_MERCHANT');
  });
});

describe('restoreSnapshot', () => {
  it('rebuilds the full dataset on a fresh device', async () => {
    const source = createFakeAdapter({ transactions: seedRows(750) });
    store.authenticate(keys.vaultId, keys.authToken);
    store.append(keys.vaultId, 'device-a', 'batch');

    await createSnapshot({
      adapter: source.adapter,
      client,
      keys,
      deviceId: 'device-a',
      throughSeq: 1,
      chunkTargetBytes: 16 * 1024,
      pageSize: 100,
    });

    const target = createFakeAdapter({ transactions: [] });
    const manifest = await client.getSnapshot();
    expect(manifest).not.toBeNull();

    const applied = await restoreSnapshot({
      client,
      keys,
      manifest: required(manifest, 'snapshot manifest'),
      applyChanges: (changes) =>
        applyIncomingChanges(target.adapter, 'device-b', changes).then(
          () => undefined
        ),
    });

    expect(applied).toBe(750);
    expect(target.tables.transactions).toHaveLength(750);
    expect(target.tables.transactions[0].description).toContain('Merchant');
  }, 30_000);

  it('applies one chunk at a time rather than buffering the dataset', async () => {
    const source = createFakeAdapter({ transactions: seedRows(600) });
    store.authenticate(keys.vaultId, keys.authToken);
    store.append(keys.vaultId, 'device-a', 'batch');

    const created = await createSnapshot({
      adapter: source.adapter,
      client,
      keys,
      deviceId: 'device-a',
      throughSeq: 1,
      chunkTargetBytes: 16 * 1024,
      pageSize: 100,
    });
    expect(created.chunkCount).toBeGreaterThan(2);

    const batchSizes: number[] = [];
    const manifest = await client.getSnapshot();
    await restoreSnapshot({
      client,
      keys,
      manifest: required(manifest, 'snapshot manifest'),
      applyChanges: async (changes: SyncChange<SyncableRow>[]) => {
        batchSizes.push(changes.length);
      },
    });

    // One apply per chunk, never one giant apply.
    expect(batchSizes.length).toBe(created.chunkCount);
    expect(Math.max(...batchSizes)).toBeLessThan(600);
  }, 30_000);

  it('propagates a failure so the caller does not advance its cursor', async () => {
    const source = createFakeAdapter({ transactions: seedRows(10) });
    store.authenticate(keys.vaultId, keys.authToken);
    store.append(keys.vaultId, 'device-a', 'batch');
    await createSnapshot({
      adapter: source.adapter,
      client,
      keys,
      deviceId: 'device-a',
      throughSeq: 1,
    });

    const manifest = await client.getSnapshot();
    await expect(
      restoreSnapshot({
        client,
        keys,
        manifest: required(manifest, 'snapshot manifest'),
        applyChanges: async () => {
          throw new Error('disk full');
        },
      })
    ).rejects.toThrow('disk full');
  });

  it('cannot be decrypted with the wrong passphrase', async () => {
    const source = createFakeAdapter({ transactions: seedRows(5) });
    store.authenticate(keys.vaultId, keys.authToken);
    store.append(keys.vaultId, 'device-a', 'batch');
    await createSnapshot({
      adapter: source.adapter,
      client,
      keys,
      deviceId: 'device-a',
      throughSeq: 1,
    });

    const manifest = await client.getSnapshot();
    const wrong = await deriveVaultKeys('wrong', 'snap@example.com');

    await expect(
      restoreSnapshot({
        client,
        keys: wrong,
        manifest: required(manifest, 'snapshot manifest'),
        applyChanges: async () => undefined,
      })
    ).rejects.toThrow();
  }, 30_000);
});

describe('shouldCreateSnapshot', () => {
  it('waits until the log has grown past the threshold', () => {
    expect(shouldCreateSnapshot(100, null, 500)).toBe(false);
    expect(shouldCreateSnapshot(500, null, 500)).toBe(true);
  });

  it('measures growth since the last snapshot, not from zero', () => {
    const snapshot = {
      snapshotId: 's',
      throughSeq: 1000,
      chunkCount: 1,
      rowCount: 1,
      createdAt: 0,
      deviceId: 'd',
    };
    expect(shouldCreateSnapshot(1200, snapshot, 500)).toBe(false);
    expect(shouldCreateSnapshot(1500, snapshot, 500)).toBe(true);
  });

  it('can be disabled with a zero threshold', () => {
    expect(shouldCreateSnapshot(10_000, null, 0)).toBe(false);
  });
});

describe('chunk sizing defaults', () => {
  it('leaves headroom under a 1 MiB server limit after base64 and GCM', () => {
    // base64 inflates by 4/3 and AES-GCM adds a nonce and tag.
    expect(DEFAULT_CHUNK_TARGET_BYTES * (4 / 3) + 28).toBeLessThan(1024 * 1024);
  });
});
