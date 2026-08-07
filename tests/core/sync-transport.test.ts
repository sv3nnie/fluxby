import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SyncTransportRegistry,
  createSyncTransportRegistry,
  aggregateTransportStatus,
  IDLE_TRANSPORT_STATUS,
  type SyncTransport,
  type SyncTransportHost,
  type SyncTransportStatus,
  type SyncChange,
  type SyncableRow,
} from '@fluxby/core';

function makeChange(id: string): SyncChange<SyncableRow> {
  return {
    table: 'transactions',
    row: {
      id,
      updated_at: 1000,
      is_deleted: false,
      device_id: 'device-a',
    },
  };
}

function makeHost(): SyncTransportHost & {
  received: SyncChange<SyncableRow>[][];
  errors: Array<{ id: string; error: Error }>;
  statuses: Array<{ id: string; status: SyncTransportStatus }>;
} {
  const received: SyncChange<SyncableRow>[][] = [];
  const errors: Array<{ id: string; error: Error }> = [];
  const statuses: Array<{ id: string; status: SyncTransportStatus }> = [];

  return {
    received,
    errors,
    statuses,
    onChangesReceived: (changes) => {
      received.push(changes);
    },
    onChangesRequested: async () => [],
    onStatusChanged: (id, status) => {
      statuses.push({ id, status });
    },
    onError: (id, error) => {
      errors.push({ id, error });
    },
  };
}

/** Minimal in-memory transport for exercising the registry. */
class FakeTransport implements SyncTransport {
  pushed: SyncChange<SyncableRow>[][] = [];
  pulled: number[] = [];
  destroyed = false;
  initialized = false;
  host: SyncTransportHost | null = null;
  status: SyncTransportStatus = { ...IDLE_TRANSPORT_STATUS };

  constructor(
    readonly id: string,
    readonly name = id,
    private behaviour: {
      failInit?: boolean;
      failPush?: boolean;
      failDestroy?: boolean;
    } = {}
  ) {}

  async initialize(host: SyncTransportHost): Promise<void> {
    if (this.behaviour.failInit) throw new Error(`${this.id} init failed`);
    this.host = host;
    this.initialized = true;
  }

  async push(changes: SyncChange<SyncableRow>[]): Promise<void> {
    if (this.behaviour.failPush) throw new Error(`${this.id} push failed`);
    this.pushed.push(changes);
  }

  async pull(sinceTimestamp: number): Promise<void> {
    this.pulled.push(sinceTimestamp);
  }

  getStatus(): SyncTransportStatus {
    return this.status;
  }

  destroy(): void {
    if (this.behaviour.failDestroy)
      throw new Error(`${this.id} destroy failed`);
    this.destroyed = true;
  }
}

describe('aggregateTransportStatus', () => {
  it('sums connected endpoints across transports', () => {
    const result = aggregateTransportStatus([
      {
        id: 'peer',
        status: { state: 'connected', connectedPeers: 2, lastError: null },
      },
      {
        id: 'remote',
        status: { state: 'connected', connectedPeers: 1, lastError: null },
      },
    ]);

    expect(result.connectedPeers).toBe(3);
    expect(result.state).toBe('connected');
  });

  it('reports connected when any transport is connected', () => {
    const result = aggregateTransportStatus([
      {
        id: 'peer',
        status: { state: 'error', connectedPeers: 0, lastError: 'boom' },
      },
      {
        id: 'remote',
        status: { state: 'connected', connectedPeers: 1, lastError: null },
      },
    ]);

    // A broken remote server must not make a working P2P link look offline.
    expect(result.state).toBe('connected');
    expect(result.lastError).toBe('boom');
  });

  it('falls back through connecting > error > offline > idle', () => {
    expect(
      aggregateTransportStatus([
        {
          id: 'a',
          status: { state: 'offline', connectedPeers: 0, lastError: null },
        },
        {
          id: 'b',
          status: { state: 'connecting', connectedPeers: 0, lastError: null },
        },
      ]).state
    ).toBe('connecting');

    expect(
      aggregateTransportStatus([
        {
          id: 'a',
          status: { state: 'offline', connectedPeers: 0, lastError: null },
        },
        {
          id: 'b',
          status: { state: 'error', connectedPeers: 0, lastError: 'x' },
        },
      ]).state
    ).toBe('error');
  });

  it('is idle with no transports', () => {
    const result = aggregateTransportStatus([]);
    expect(result).toEqual({
      connectedPeers: 0,
      state: 'idle',
      lastError: null,
      byTransport: {},
    });
  });

  it('exposes a per-transport breakdown', () => {
    const result = aggregateTransportStatus([
      {
        id: 'peer',
        status: { state: 'connected', connectedPeers: 1, lastError: null },
      },
    ]);
    expect(result.byTransport.peer.connectedPeers).toBe(1);
  });
});

describe('SyncTransportRegistry', () => {
  let registry: SyncTransportRegistry;
  let host: ReturnType<typeof makeHost>;

  beforeEach(() => {
    registry = createSyncTransportRegistry();
    host = makeHost();
  });

  it('fans a push out to every registered transport', async () => {
    const a = new FakeTransport('a');
    const b = new FakeTransport('b');
    await registry.register(a);
    await registry.register(b);
    await registry.initializeAll(host);

    const changes = [makeChange('row-1')];
    await registry.push(changes);

    expect(a.pushed).toEqual([changes]);
    expect(b.pushed).toEqual([changes]);
  });

  it('fans a pull out to every registered transport', async () => {
    const a = new FakeTransport('a');
    const b = new FakeTransport('b');
    await registry.register(a);
    await registry.register(b);
    await registry.initializeAll(host);

    await registry.pull(500);

    expect(a.pulled).toEqual([500]);
    expect(b.pulled).toEqual([500]);
  });

  it('skips the fan-out entirely for an empty change set', async () => {
    const a = new FakeTransport('a');
    await registry.register(a);
    await registry.initializeAll(host);

    await registry.push([]);

    expect(a.pushed).toEqual([]);
  });

  it('isolates a failing transport from the others', async () => {
    const good = new FakeTransport('good');
    const bad = new FakeTransport('bad', 'bad', { failPush: true });
    await registry.register(good);
    await registry.register(bad);
    await registry.initializeAll(host);

    const changes = [makeChange('row-1')];
    await expect(registry.push(changes)).resolves.toBeUndefined();

    // The healthy transport still delivered.
    expect(good.pushed).toEqual([changes]);
    expect(host.errors).toHaveLength(1);
    expect(host.errors[0].id).toBe('bad');
    expect(host.errors[0].error.message).toBe('bad push failed');
  });

  it('reports init failure through the host without rejecting', async () => {
    const bad = new FakeTransport('bad', 'bad', { failInit: true });
    const good = new FakeTransport('good');
    await registry.register(bad);
    await registry.register(good);

    await expect(registry.initializeAll(host)).resolves.toBeUndefined();

    expect(good.initialized).toBe(true);
    expect(host.errors.map((e) => e.id)).toEqual(['bad']);
  });

  it('initializes a transport registered after initializeAll', async () => {
    await registry.initializeAll(host);

    const late = new FakeTransport('late');
    await registry.register(late);

    expect(late.initialized).toBe(true);
  });

  it('does not initialize a transport registered before initializeAll', async () => {
    const early = new FakeTransport('early');
    await registry.register(early);

    expect(early.initialized).toBe(false);
  });

  it('replaces and destroys a transport registered under an existing id', async () => {
    const first = new FakeTransport('remote');
    const second = new FakeTransport('remote');
    await registry.register(first);
    await registry.register(second);

    expect(first.destroyed).toBe(true);
    expect(registry.get('remote')).toBe(second);
    expect(registry.list()).toHaveLength(1);
  });

  it('is a no-op when re-registering the identical instance', async () => {
    const only = new FakeTransport('remote');
    await registry.register(only);
    await registry.register(only);

    expect(only.destroyed).toBe(false);
    expect(registry.list()).toHaveLength(1);
  });

  it('destroys on unregister and stops fanning out to it', async () => {
    const a = new FakeTransport('a');
    const b = new FakeTransport('b');
    await registry.register(a);
    await registry.register(b);
    await registry.initializeAll(host);

    registry.unregister('a');
    await registry.push([makeChange('row-1')]);

    expect(a.destroyed).toBe(true);
    expect(a.pushed).toEqual([]);
    expect(b.pushed).toHaveLength(1);
    expect(registry.has('a')).toBe(false);
  });

  it('survives a transport that throws while being destroyed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(vi.fn());
    const bad = new FakeTransport('bad', 'bad', { failDestroy: true });
    const good = new FakeTransport('good');
    await registry.register(bad);
    await registry.register(good);

    expect(() => registry.destroyAll()).not.toThrow();
    expect(good.destroyed).toBe(true);
    expect(registry.list()).toHaveLength(0);
    warn.mockRestore();
  });

  it('aggregates status across registered transports', async () => {
    const a = new FakeTransport('a');
    a.status = { state: 'connected', connectedPeers: 2, lastError: null };
    const b = new FakeTransport('b');
    b.status = { state: 'idle', connectedPeers: 0, lastError: null };
    await registry.register(a);
    await registry.register(b);

    const status = registry.getAggregateStatus();
    expect(status.connectedPeers).toBe(2);
    expect(status.state).toBe('connected');
  });
});
