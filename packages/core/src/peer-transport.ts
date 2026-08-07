/**
 * Peer Sync Transport
 *
 * Adapts the existing WebRTC `PeerSync` implementation to the generic
 * `SyncTransport` interface so it can sit alongside other transports in a
 * `SyncTransportRegistry`.
 *
 * This is a wrapper only -- pairing, encryption and connection handling all
 * still live in `peer.ts`. Pairing is peer-specific and has no equivalent on
 * other transports, so it stays reachable through `getPeerSync()`.
 */

import {
  createPeerSync,
  type PeerSync,
  type PeerDevice,
  type IceServerConfig,
  type PeerServerConfig,
} from './peer.js';
import type { SyncChange, SyncableRow } from './sync.js';
import {
  IDLE_TRANSPORT_STATUS,
  type SyncTransport,
  type SyncTransportHost,
  type SyncTransportStatus,
} from './sync-transport.js';

export const PEER_TRANSPORT_ID = 'peer';

export interface PeerSyncTransportOptions {
  deviceId: string;
  deviceName: string;
  iceServers?: IceServerConfig[];
  peerServer?: PeerServerConfig;
  /** A new device wants to pair with us */
  onPairingRequest?: (
    deviceName: string,
    accept: () => void,
    reject: () => void
  ) => void;
  /** Pairing completed with a device */
  onPaired?: (device: PeerDevice) => void;
  /** A peer connected or disconnected */
  onConnectionChange?: (peerId: string, connected: boolean) => void;
}

export class PeerSyncTransport implements SyncTransport {
  readonly id = PEER_TRANSPORT_ID;
  readonly name = 'Device-to-device';

  private peer: PeerSync | null = null;
  private host: SyncTransportHost | null = null;
  private status: SyncTransportStatus = { ...IDLE_TRANSPORT_STATUS };
  private destroyed = false;

  constructor(private options: PeerSyncTransportOptions) {}

  /**
   * The underlying PeerSync, for peer-only concerns such as pairing codes.
   * Null until `initialize()` has been called.
   */
  getPeerSync(): PeerSync | null {
    return this.peer;
  }

  async initialize(host: SyncTransportHost): Promise<void> {
    this.host = host;
    this.destroyed = false;
    this.setStatus({ state: 'connecting', lastError: null });

    const peer = createPeerSync({
      deviceId: this.options.deviceId,
      deviceName: this.options.deviceName,
      iceServers: this.options.iceServers,
      peerServer: this.options.peerServer,
      onPairingRequest: this.options.onPairingRequest,
      onPaired: (device) => {
        this.options.onPaired?.(device);
        this.refreshConnectionCount();
      },
      onConnectionChange: (peerId, connected) => {
        this.options.onConnectionChange?.(peerId, connected);
        this.refreshConnectionCount();
      },
      onSyncReceived: (changes) => {
        this.host?.onChangesReceived(changes);
      },
      onSyncRequested: async (peerId) => {
        if (!this.host) return [];
        // peer.ts does not forward the requester's `sinceTimestamp`, so a peer
        // request means a full resync. Passing 0 preserves that behaviour.
        return this.host.onChangesRequested(0, {
          transportId: this.id,
          peerId,
        });
      },
      onError: (error) => {
        this.setStatus({ state: 'error', lastError: error.message });
        this.host?.onError(this.id, error);
      },
    });

    this.peer = peer;

    try {
      await peer.initialize();
      if (this.destroyed) return;
      this.refreshConnectionCount();
    } catch (error) {
      if (this.destroyed) return;
      const err = error instanceof Error ? error : new Error(String(error));
      this.setStatus({ state: 'error', lastError: err.message });
      throw err;
    }
  }

  async push(changes: SyncChange<SyncableRow>[]): Promise<void> {
    if (!this.peer || changes.length === 0) return;
    await this.peer.broadcastChanges(changes);
  }

  async pull(sinceTimestamp: number): Promise<void> {
    const peer = this.peer;
    if (!peer) return;

    const connected = peer.getPairedDevices().filter((d) => d.isConnected);

    // One unreachable device must not abort the rest of the fan-out.
    const results = await Promise.allSettled(
      connected.map((device) => peer.requestSync(device.id, sinceTimestamp))
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        const reason = result.reason;
        this.host?.onError(
          this.id,
          reason instanceof Error ? reason : new Error(String(reason))
        );
      }
    }
  }

  getStatus(): SyncTransportStatus {
    return this.status;
  }

  destroy(): void {
    this.destroyed = true;
    this.peer?.destroy();
    this.peer = null;
    this.host = null;
    this.status = { ...IDLE_TRANSPORT_STATUS };
  }

  /** Recompute connected-peer count from the peer's own device list. */
  private refreshConnectionCount(): void {
    if (!this.peer) return;
    const connected = this.peer
      .getPairedDevices()
      .filter((d) => d.isConnected).length;
    this.setStatus({
      state: connected > 0 ? 'connected' : 'idle',
      connectedPeers: connected,
      lastError: null,
    });
  }

  private setStatus(patch: Partial<SyncTransportStatus>): void {
    this.status = { ...this.status, ...patch };
    this.host?.onStatusChanged(this.id, this.status);
  }
}

export function createPeerSyncTransport(
  options: PeerSyncTransportOptions
): PeerSyncTransport {
  return new PeerSyncTransport(options);
}
