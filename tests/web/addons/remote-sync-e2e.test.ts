/**
 * End-to-end remote sync: two devices, one real server, real encryption.
 *
 * This exercises the whole chain that moves a transaction between devices --
 * collectLocalChanges -> encrypt -> HTTP -> server storage -> HTTP ->
 * decrypt -> applyIncomingChanges -> SQLite -- with only the browser and the
 * network faked. The pieces mocked out elsewhere (the server in the transport
 * tests, the transport in the server tests) are all real here.
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
import type { SyncTransportHost } from '@fluxby/core';
import { createApp } from '../../../apps/sync-server/src/app.js';
import { VaultStore } from '../../../apps/sync-server/src/store.js';
import { createFakeAdapter, TEST_PROFILE } from '../helpers/fake-sync-db';

/**
 * Cursors live in OPFS, which does not exist under Node. Each device has its
 * own OPFS in reality, so the double must key by device as well as vault --
 * sharing one cursor would let one device consume another's batches.
 */
const cursors = new Map<string, number>();
let activeDevice = 'unknown';
const cursorKey = (vaultId: string) => `${activeDevice}:${vaultId}`;

vi.mock('@/addons/remote-sync/config', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/addons/remote-sync/config')>();
  return {
    ...actual,
    loadCursor: async (vaultId: string) => cursors.get(cursorKey(vaultId)) ?? 0,
    saveCursor: async (vaultId: string, seq: number) => {
      const key = cursorKey(vaultId);
      if ((cursors.get(key) ?? 0) < seq) cursors.set(key, seq);
    },
  };
});

const { deriveVaultKeys, serializeVaultKeys } =
  await import('@/addons/remote-sync/crypto');
const { RemoteSyncTransport } = await import('@/addons/remote-sync/transport');
const { applyIncomingChanges, collectLocalChanges } =
  await import('@/lib/sync-data');

import type { RemoteSyncConfig } from '@/addons/remote-sync/config';

const PASSPHRASE = 'a shared vault passphrase';
const LABEL = 'household@example.com';

let store: VaultStore;
let app: ReturnType<typeof createApp>;
let baseConfig: RemoteSyncConfig;

/** Route the transport's fetch at the in-process Express app via supertest. */
function installServerBridge() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      const path = target.pathname + target.search;
      const headers = (init?.headers ?? {}) as Record<string, string>;

      const call =
        init?.method === 'POST'
          ? request(app)
              .post(path)
              .send(JSON.parse(String(init.body)))
          : request(app).get(path);

      for (const [key, value] of Object.entries(headers)) {
        call.set(key, value);
      }

      const res = await call;
      return new Response(JSON.stringify(res.body), {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      });
    })
  );
}

/**
 * A device: its own database, its own transport, wired together exactly as
 * SyncDataBridge wires them in the app.
 */
function createDevice(deviceId: string, seed = {}) {
  const fake = createFakeAdapter(seed);
  const transport = new RemoteSyncTransport({ config: baseConfig });

  const host: SyncTransportHost = {
    deviceId,
    onChangesReceived: async (changes) => {
      await applyIncomingChanges(fake.adapter, deviceId, changes);
    },
    onChangesRequested: async () => collectLocalChanges(fake.adapter, 0),
    onStatusChanged: vi.fn(),
    onError: vi.fn(),
  };

  const device = {
    deviceId,
    tables: fake.tables,
    adapter: fake.adapter,
    transport,
    host,
    /** Every entry point claims the cursor namespace for this device first. */
    connect: async () => {
      activeDevice = deviceId;
      await device.transport.initialize(host);
    },
    pull: async () => {
      activeDevice = deviceId;
      await device.transport.pull(0);
    },
    /** Collect local rows and push them, as the push sweeper does. */
    pushAll: async () => {
      activeDevice = deviceId;
      const changes = await collectLocalChanges(fake.adapter, 0);
      if (changes.length > 0) await device.transport.push(changes);
      return changes.length;
    },
  };

  return device;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'txn-1',
    updated_at: 1000,
    is_deleted: 0,
    device_id: 'device-a',
    profile_id: TEST_PROFILE,
    amount: -42.5,
    description: 'Coffee',
    ...overrides,
  };
}

beforeAll(async () => {
  const keys = await deriveVaultKeys(PASSPHRASE, LABEL);
  baseConfig = {
    enabled: true,
    serverUrl: 'http://sync.test',
    vaultLabel: LABEL,
    profileId: TEST_PROFILE,
    pollIntervalMs: 3_600_000, // effectively off; tests pull explicitly
    keys: await serializeVaultKeys(keys),
  };
}, 30_000);

beforeEach(() => {
  cursors.clear();
  store = new VaultStore(':memory:');
  app = createApp({ store, rateLimitMax: 0 });
  installServerBridge();
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.close();
});

describe('two devices sharing a vault', () => {
  it('moves a transaction from one device to the other', async () => {
    const deviceA = createDevice('device-a', {
      transactions: [row({ id: 'txn-1', description: 'Coffee' })],
    });
    const deviceB = createDevice('device-b', { transactions: [] });

    await deviceA.connect();
    await deviceB.connect();

    await deviceA.pushAll();
    await deviceB.pull();

    expect(deviceB.tables.transactions).toHaveLength(1);
    expect(deviceB.tables.transactions[0]).toMatchObject({
      id: 'txn-1',
      description: 'Coffee',
      amount: -42.5,
      is_deleted: 0,
    });

    deviceA.transport.destroy();
    deviceB.transport.destroy();
  });

  it('stores nothing the server can read', async () => {
    const deviceA = createDevice('device-a', {
      transactions: [row({ description: 'VERY_SECRET_MERCHANT' })],
    });
    await deviceA.connect();
    await deviceA.pushAll();

    const vaultId = (await deriveVaultKeys(PASSPHRASE, LABEL)).vaultId;
    const stored = store.list(vaultId, 0, 100);

    expect(stored).toHaveLength(1);
    expect(stored[0].payload).not.toContain('VERY_SECRET_MERCHANT');
    expect(atob(stored[0].payload)).not.toContain('VERY_SECRET_MERCHANT');
    // Table names leak nothing either.
    expect(atob(stored[0].payload)).not.toContain('transactions');

    deviceA.transport.destroy();
  }, 30_000);

  it('resolves a conflict by last-write-wins across the wire', async () => {
    const deviceA = createDevice('device-a', {
      transactions: [
        row({ id: 'shared', description: 'newer', updated_at: 9000 }),
      ],
    });
    const deviceB = createDevice('device-b', {
      transactions: [
        row({
          id: 'shared',
          description: 'older',
          updated_at: 1000,
          device_id: 'device-b',
        }),
      ],
    });

    await deviceA.connect();
    await deviceB.connect();
    await deviceA.pushAll();
    await deviceB.pull();

    expect(deviceB.tables.transactions[0].description).toBe('newer');

    deviceA.transport.destroy();
    deviceB.transport.destroy();
  });

  it('does not overwrite a newer local row with an older remote one', async () => {
    const deviceA = createDevice('device-a', {
      transactions: [
        row({ id: 'shared', description: 'older', updated_at: 1000 }),
      ],
    });
    const deviceB = createDevice('device-b', {
      transactions: [
        row({
          id: 'shared',
          description: 'newer',
          updated_at: 9000,
          device_id: 'device-b',
        }),
      ],
    });

    await deviceA.connect();
    await deviceB.connect();
    await deviceA.pushAll();
    await deviceB.pull();

    expect(deviceB.tables.transactions[0].description).toBe('newer');

    deviceA.transport.destroy();
    deviceB.transport.destroy();
  });

  it('propagates a deletion', async () => {
    const deviceA = createDevice('device-a', {
      transactions: [row({ id: 'gone', updated_at: 5000, is_deleted: 1 })],
    });
    const deviceB = createDevice('device-b', {
      transactions: [row({ id: 'gone', updated_at: 1000, is_deleted: 0 })],
    });

    await deviceA.connect();
    await deviceB.connect();
    await deviceA.pushAll();
    await deviceB.pull();

    expect(deviceB.tables.transactions[0].is_deleted).toBe(1);

    deviceA.transport.destroy();
    deviceB.transport.destroy();
  });

  it('syncs in both directions', async () => {
    const deviceA = createDevice('device-a', {
      transactions: [row({ id: 'from-a', device_id: 'device-a' })],
    });
    const deviceB = createDevice('device-b', {
      transactions: [row({ id: 'from-b', device_id: 'device-b' })],
    });

    await deviceA.connect();
    await deviceB.connect();

    await deviceA.pushAll();
    await deviceB.pull();
    await deviceB.pushAll();
    await deviceA.pull();

    expect(deviceA.tables.transactions.map((r) => r.id).sort()).toEqual([
      'from-a',
      'from-b',
    ]);
    expect(deviceB.tables.transactions.map((r) => r.id).sort()).toEqual([
      'from-a',
      'from-b',
    ]);

    deviceA.transport.destroy();
    deviceB.transport.destroy();
  });

  it('lets a brand-new device bootstrap the whole history', async () => {
    const deviceA = createDevice('device-a', {
      transactions: [
        row({ id: 't1', updated_at: 1000 }),
        row({ id: 't2', updated_at: 2000 }),
        row({ id: 't3', updated_at: 3000 }),
      ],
    });
    await deviceA.connect();
    await deviceA.pushAll();

    // A device that has never synced starts from an empty log position.
    const fresh = createDevice('device-c', { transactions: [] });
    await fresh.connect();
    await fresh.pull();

    expect(fresh.tables.transactions.map((r) => r.id).sort()).toEqual([
      't1',
      't2',
      't3',
    ]);

    deviceA.transport.destroy();
    fresh.transport.destroy();
  });

  it('shuts a device out when its passphrase does not match', async () => {
    const deviceA = createDevice('device-a', {
      transactions: [row({ id: 'txn-1' })],
    });
    await deviceA.connect();
    await deviceA.pushAll();

    const wrongKeys = await deriveVaultKeys('the wrong passphrase', LABEL);
    const intruder = createDevice('device-x', { transactions: [] });
    intruder.transport = new RemoteSyncTransport({
      config: { ...baseConfig, keys: await serializeVaultKeys(wrongKeys) },
    });

    await intruder.transport.initialize(intruder.host);
    await intruder.transport.pull(0);

    // A different passphrase derives a different vault entirely.
    expect(intruder.tables.transactions).toHaveLength(0);

    deviceA.transport.destroy();
    intruder.transport.destroy();
  }, 30_000);
});
