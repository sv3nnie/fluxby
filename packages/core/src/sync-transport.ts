/**
 * Sync Transport
 *
 * Abstraction over the *channel* used to move sync changes between this device
 * and somewhere else. It deliberately knows nothing about how changes are
 * produced, merged or persisted -- that stays in SyncService (database logic)
 * and SyncEngine (scheduling, debouncing, status).
 *
 * The peer-to-peer WebRTC implementation lives in `peer-transport.ts`. Other
 * transports (a remote server, a file drop, a LAN bridge) can be added without
 * touching the sync engine or the database layer.
 */

import type { SyncChange, SyncableRow } from './sync.js';

/**
 * Connection state of a single transport.
 */
export type SyncTransportState =
  'idle' | 'connecting' | 'connected' | 'offline' | 'error';

export interface SyncTransportStatus {
  state: SyncTransportState;
  /** Number of live remote endpoints (peers, servers) currently reachable */
  connectedPeers: number;
  lastError: string | null;
}

export const IDLE_TRANSPORT_STATUS: SyncTransportStatus = {
  state: 'idle',
  connectedPeers: 0,
  lastError: null,
};

/**
 * Where an inbound request came from.
 */
export interface SyncRequestSource {
  transportId: string;
  /** Remote endpoint identifier, when the transport has one (e.g. a peer ID) */
  peerId?: string;
}

/**
 * Services the host application exposes to a transport.
 *
 * A transport calls into these when something arrives from the outside world;
 * it never touches the database or the sync engine directly.
 */
export interface SyncTransportHost {
  /** This device's stable id, for transports that must tag or filter by origin */
  readonly deviceId: string;
  /**
   * Remote sent us changes to apply locally.
   *
   * Transports that track a durable read position must await this before
   * advancing it: resolving means the changes are persisted, and rejecting
   * means they must be delivered again.
   */
  onChangesReceived(changes: SyncChange<SyncableRow>[]): void | Promise<void>;
  /**
   * Remote asked what we have changed since `sinceTimestamp`.
   * A `sinceTimestamp` of 0 means "send everything".
   */
  onChangesRequested(
    sinceTimestamp: number,
    source: SyncRequestSource
  ): Promise<SyncChange<SyncableRow>[]>;
  /** Transport connection state changed */
  onStatusChanged(transportId: string, status: SyncTransportStatus): void;
  /** Transport hit an error (non-fatal; the transport stays registered) */
  onError(transportId: string, error: Error): void;
}

/**
 * A channel over which sync changes travel.
 */
export interface SyncTransport {
  /** Stable identifier, unique per registry (e.g. 'peer', 'remote-server') */
  readonly id: string;
  /** Human-readable name for UI */
  readonly name: string;

  /** Connect / start listening. Called once before any push or pull. */
  initialize(host: SyncTransportHost): Promise<void>;

  /** Send local changes to the remote side. */
  push(changes: SyncChange<SyncableRow>[]): Promise<void>;

  /**
   * Ask the remote side for anything changed since `sinceTimestamp`.
   * Results arrive asynchronously via `host.onChangesReceived`.
   */
  pull(sinceTimestamp: number): Promise<void>;

  getStatus(): SyncTransportStatus;

  /** Tear down connections and release resources. */
  destroy(): void;
}

/**
 * Aggregate status across every registered transport.
 */
export interface AggregateTransportStatus {
  /** Total live endpoints across all transports */
  connectedPeers: number;
  /**
   * Rolled-up state. 'connected' if any transport is connected, otherwise the
   * most interesting state present (connecting > error > offline > idle).
   */
  state: SyncTransportState;
  /** First error reported by any transport, if any */
  lastError: string | null;
  /** Per-transport breakdown, keyed by transport id */
  byTransport: Record<string, SyncTransportStatus>;
}

/**
 * Roll up several transport statuses into one.
 *
 * Being connected anywhere counts as connected -- a broken remote server
 * should not make a working P2P link look offline.
 */
export function aggregateTransportStatus(
  statuses: Array<{ id: string; status: SyncTransportStatus }>
): AggregateTransportStatus {
  const byTransport: Record<string, SyncTransportStatus> = {};
  let connectedPeers = 0;
  let lastError: string | null = null;

  for (const { id, status } of statuses) {
    byTransport[id] = status;
    connectedPeers += status.connectedPeers;
    if (!lastError && status.lastError) lastError = status.lastError;
  }

  const states = statuses.map((s) => s.status.state);
  // Priority order: a live connection wins, then in-progress, then problems.
  const state: SyncTransportState = states.includes('connected')
    ? 'connected'
    : states.includes('connecting')
      ? 'connecting'
      : states.includes('error')
        ? 'error'
        : states.includes('offline')
          ? 'offline'
          : 'idle';

  return { connectedPeers, state, lastError, byTransport };
}

/**
 * Holds the set of active transports and fans sync operations out to all of
 * them. One failing transport never blocks or breaks the others.
 */
export class SyncTransportRegistry {
  private transports = new Map<string, SyncTransport>();
  private host: SyncTransportHost | null = null;

  /**
   * Add a transport. If the registry has already been initialized the new
   * transport is initialized immediately.
   *
   * Replaces any existing transport with the same id (the old one is destroyed).
   */
  async register(transport: SyncTransport): Promise<void> {
    const existing = this.transports.get(transport.id);
    if (existing) {
      if (existing === transport) return;
      this.safeDestroy(existing);
    }

    this.transports.set(transport.id, transport);

    if (this.host) {
      await this.initializeOne(transport, this.host);
    }
  }

  unregister(id: string): void {
    const transport = this.transports.get(id);
    if (!transport) return;
    this.safeDestroy(transport);
    this.transports.delete(id);
  }

  get(id: string): SyncTransport | undefined {
    return this.transports.get(id);
  }

  has(id: string): boolean {
    return this.transports.has(id);
  }

  list(): SyncTransport[] {
    return [...this.transports.values()];
  }

  /**
   * Initialize every registered transport. Failures are reported through
   * `host.onError` and do not reject.
   */
  async initializeAll(host: SyncTransportHost): Promise<void> {
    this.host = host;
    await Promise.all(
      this.list().map((transport) => this.initializeOne(transport, host))
    );
  }

  private async initializeOne(
    transport: SyncTransport,
    host: SyncTransportHost
  ): Promise<void> {
    try {
      await transport.initialize(host);
    } catch (error) {
      host.onError(
        transport.id,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /** Broadcast local changes over every transport. */
  async push(changes: SyncChange<SyncableRow>[]): Promise<void> {
    if (changes.length === 0) return;
    await this.forEachTransport((t) => t.push(changes));
  }

  /** Ask every transport for remote changes since `sinceTimestamp`. */
  async pull(sinceTimestamp: number): Promise<void> {
    await this.forEachTransport((t) => t.pull(sinceTimestamp));
  }

  private async forEachTransport(
    fn: (transport: SyncTransport) => Promise<void>
  ): Promise<void> {
    const transports = this.list();
    const results = await Promise.allSettled(
      transports.map((transport) => fn(transport))
    );

    results.forEach((result, index) => {
      if (result.status === 'rejected' && this.host) {
        const reason = result.reason;
        this.host.onError(
          transports[index].id,
          reason instanceof Error ? reason : new Error(String(reason))
        );
      }
    });
  }

  getAggregateStatus(): AggregateTransportStatus {
    return aggregateTransportStatus(
      this.list().map((t) => ({ id: t.id, status: t.getStatus() }))
    );
  }

  destroyAll(): void {
    for (const transport of this.transports.values()) {
      this.safeDestroy(transport);
    }
    this.transports.clear();
    this.host = null;
  }

  private safeDestroy(transport: SyncTransport): void {
    try {
      transport.destroy();
    } catch (error) {
      // Destroying must never throw -- it runs in React cleanup paths.
      console.warn(`Failed to destroy transport "${transport.id}":`, error);
    }
  }
}

export function createSyncTransportRegistry(): SyncTransportRegistry {
  return new SyncTransportRegistry();
}
