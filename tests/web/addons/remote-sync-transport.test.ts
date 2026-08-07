import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
  afterEach,
} from 'vitest';
import type { SyncTransportHost, SyncChange, SyncableRow } from '@fluxby/core';

// The cursor helpers hit OPFS, which does not exist under Node. Everything
// else in the config module is pure and kept as-is.
const cursors = new Map<string, number>();
vi.mock('@/addons/remote-sync/config', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/addons/remote-sync/config')>();
  return {
    ...actual,
    loadCursor: async (vaultId: string) => cursors.get(vaultId) ?? 0,
    saveCursor: async (vaultId: string, seq: number) => {
      if ((cursors.get(vaultId) ?? 0) < seq) cursors.set(vaultId, seq);
    },
  };
});

const { deriveVaultKeys, serializeVaultKeys, encryptPayload, decryptPayload } =
  await import('@/addons/remote-sync/crypto');
const { RemoteSyncTransport } = await import('@/addons/remote-sync/transport');
const { REMOTE_SYNC_PROTOCOL_VERSION } =
  await import('@/addons/remote-sync/protocol');
import type { RemoteSyncConfig } from '@/addons/remote-sync/config';
import type { VaultKeys } from '@/addons/remote-sync/crypto';

const THIS_DEVICE = 'device-local';
const OTHER_DEVICE = 'device-remote';

let keys: VaultKeys;
let config: RemoteSyncConfig;

/** In-memory stand-in for the sync server. */
interface StoredBatch {
  seq: number;
  deviceId: string;
  createdAt: number;
  payload: string;
}
let serverBatches: StoredBatch[] = [];
let pageLimit = 200;
let healthFails = false;

function installFakeServer() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));

      if (target.pathname.endsWith('/v1/health')) {
        if (healthFails) {
          return new Response(JSON.stringify({ error: 'nope' }), {
            status: 500,
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          deviceId: string;
          payload: string;
        };
        const seq = serverBatches.length + 1;
        serverBatches.push({
          seq,
          deviceId: body.deviceId,
          createdAt: 1_700_000_000_000,
          payload: body.payload,
        });
        return new Response(JSON.stringify({ seq }), { status: 200 });
      }

      const since = Number(target.searchParams.get('since') ?? 0);
      const matching = serverBatches.filter((b) => b.seq > since);
      const latestSeq = serverBatches.length;
      return new Response(
        JSON.stringify({ batches: matching.slice(0, pageLimit), latestSeq }),
        { status: 200 }
      );
    })
  );
}

function makeHost(): SyncTransportHost & {
  received: SyncChange<SyncableRow>[];
  errors: Error[];
} {
  const received: SyncChange<SyncableRow>[] = [];
  const errors: Error[] = [];
  return {
    deviceId: THIS_DEVICE,
    received,
    errors,
    onChangesReceived: (changes) => received.push(...changes),
    onChangesRequested: async () => [],
    onStatusChanged: vi.fn(),
    onError: (_id, error) => errors.push(error),
  };
}

function makeChange(id: string): SyncChange<SyncableRow> {
  return {
    table: 'transactions',
    row: { id, updated_at: 1000, is_deleted: false, device_id: OTHER_DEVICE },
  };
}

/** Append a batch as though another device had pushed it. */
async function seedRemoteBatch(
  changes: SyncChange<SyncableRow>[],
  deviceId = OTHER_DEVICE
) {
  const payload = await encryptPayload(keys, {
    version: REMOTE_SYNC_PROTOCOL_VERSION,
    pushedAt: 1_700_000_000_000,
    changes,
  });
  serverBatches.push({
    seq: serverBatches.length + 1,
    deviceId,
    createdAt: 1_700_000_000_000,
    payload,
  });
}

beforeAll(async () => {
  keys = await deriveVaultKeys('test passphrase', 'vault@example.com');
  config = {
    enabled: true,
    serverUrl: 'https://sync.example.com',
    vaultLabel: 'vault@example.com',
    pollIntervalMs: 60_000,
    keys: await serializeVaultKeys(keys),
  };
}, 30_000);

beforeEach(() => {
  serverBatches = [];
  cursors.clear();
  pageLimit = 200;
  healthFails = false;
  installFakeServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RemoteSyncTransport', () => {
  it('stays idle and inert when not configured', async () => {
    const transport = new RemoteSyncTransport({
      config: { ...config, enabled: false },
    });
    const host = makeHost();
    await transport.initialize(host);

    expect(transport.getStatus().state).toBe('idle');

    // Must not talk to the network at all.
    await transport.push([makeChange('a')]);
    await transport.pull(0);
    expect(serverBatches).toHaveLength(0);
    transport.destroy();
  });

  it('connects and reports connected status', async () => {
    const transport = new RemoteSyncTransport({ config });
    await transport.initialize(makeHost());

    expect(transport.getStatus().state).toBe('connected');
    transport.destroy();
  });

  it('reports an error when the server is unreachable', async () => {
    healthFails = true;
    const transport = new RemoteSyncTransport({ config });
    await transport.initialize(makeHost());

    expect(transport.getStatus().state).toBe('error');
    expect(transport.getStatus().lastError).toBeTruthy();
    transport.destroy();
  });

  it('pushes an encrypted batch the server cannot read', async () => {
    const transport = new RemoteSyncTransport({ config });
    await transport.initialize(makeHost());

    await transport.push([makeChange('secret-row')]);

    expect(serverBatches).toHaveLength(1);
    expect(serverBatches[0].deviceId).toBe(THIS_DEVICE);
    expect(serverBatches[0].payload).not.toContain('secret-row');
    expect(atob(serverBatches[0].payload)).not.toContain('transactions');

    // ...but a device holding the key can.
    const contents = await decryptPayload<{
      changes: SyncChange<SyncableRow>[];
    }>(keys, serverBatches[0].payload);
    expect(contents.changes[0].row.id).toBe('secret-row');
    transport.destroy();
  });

  it('pulls and decrypts batches from other devices', async () => {
    await seedRemoteBatch([makeChange('remote-1'), makeChange('remote-2')]);

    const transport = new RemoteSyncTransport({ config });
    const host = makeHost();
    await transport.initialize(host);

    expect(host.received.map((c) => c.row.id)).toEqual([
      'remote-1',
      'remote-2',
    ]);
    transport.destroy();
  });

  it('skips batches this device pushed itself', async () => {
    await seedRemoteBatch([makeChange('mine')], THIS_DEVICE);
    await seedRemoteBatch([makeChange('theirs')], OTHER_DEVICE);

    const transport = new RemoteSyncTransport({ config });
    const host = makeHost();
    await transport.initialize(host);

    // Our own writes are already in the local database.
    expect(host.received.map((c) => c.row.id)).toEqual(['theirs']);
    transport.destroy();
  });

  it('does not replay batches it has already applied', async () => {
    await seedRemoteBatch([makeChange('remote-1')]);

    const transport = new RemoteSyncTransport({ config });
    const host = makeHost();
    await transport.initialize(host);
    expect(host.received).toHaveLength(1);

    await transport.pull(0);
    expect(host.received).toHaveLength(1);

    // A genuinely new batch still arrives.
    await seedRemoteBatch([makeChange('remote-2')]);
    await transport.pull(0);
    expect(host.received.map((c) => c.row.id)).toEqual([
      'remote-1',
      'remote-2',
    ]);
    transport.destroy();
  });

  it('pages through a log longer than one server response', async () => {
    for (let i = 1; i <= 7; i++) {
      await seedRemoteBatch([makeChange(`row-${i}`)]);
    }
    pageLimit = 2;

    const transport = new RemoteSyncTransport({ config });
    const host = makeHost();
    await transport.initialize(host);

    expect(host.received).toHaveLength(7);
    expect(cursors.get(keys.vaultId)).toBe(7);
    transport.destroy();
  });

  it('skips an undecryptable batch instead of stalling the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

    const foreign = await deriveVaultKeys(
      'other passphrase',
      'other@example.com'
    );
    await seedRemoteBatch([makeChange('before')]);
    serverBatches.push({
      seq: serverBatches.length + 1,
      deviceId: OTHER_DEVICE,
      createdAt: 1_700_000_000_000,
      // Encrypted under a passphrase this device does not have.
      payload: await encryptPayload(foreign, { version: 1, changes: [] }),
    });
    await seedRemoteBatch([makeChange('after')]);

    const transport = new RemoteSyncTransport({ config });
    const host = makeHost();
    await transport.initialize(host);

    // The poisoned batch is skipped but the log still drains past it.
    expect(host.received.map((c) => c.row.id)).toEqual(['before', 'after']);
    expect(cursors.get(keys.vaultId)).toBe(3);
    warn.mockRestore();
    transport.destroy();
  }, 30_000);

  it('collapses concurrent pulls onto one in-flight request', async () => {
    await seedRemoteBatch([makeChange('remote-1')]);

    const transport = new RemoteSyncTransport({ config });
    const host = makeHost();
    await transport.initialize(host);
    const callsAfterInit = (fetch as unknown as { mock: { calls: unknown[] } })
      .mock.calls.length;

    await Promise.all([
      transport.pull(0),
      transport.pull(0),
      transport.pull(0),
    ]);

    const added =
      (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length -
      callsAfterInit;
    // Three callers, one round trip.
    expect(added).toBe(1);
    transport.destroy();
  });

  it('stops polling once destroyed', async () => {
    vi.useFakeTimers();
    const transport = new RemoteSyncTransport({
      config: { ...config, pollIntervalMs: 1000 },
    });
    await transport.initialize(makeHost());
    transport.destroy();

    const before = (fetch as unknown as { mock: { calls: unknown[] } }).mock
      .calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    const after = (fetch as unknown as { mock: { calls: unknown[] } }).mock
      .calls.length;

    expect(after).toBe(before);
    vi.useRealTimers();
  });
});
