/**
 * Remote Sync transport
 *
 * A `SyncTransport` that pushes encrypted change batches to a remote server
 * and pulls back whatever other devices have appended since this device last
 * looked.
 *
 * It reuses the app's existing sync machinery wholesale: batches carry plain
 * `SyncChange` records, and merging is left to SyncService's Last-Write-Wins
 * rules. Nothing here knows about accounts, transactions or budgets.
 */

import {
  IDLE_TRANSPORT_STATUS,
  type SyncChange,
  type SyncTransport,
  type SyncTransportHost,
  type SyncTransportStatus,
  type SyncableRow,
} from '@fluxby/core';
import { RemoteSyncClient, RemoteSyncError } from './client';
import {
  deserializeVaultKeys,
  decryptPayload,
  encryptPayload,
  type VaultKeys,
} from './crypto';
import {
  isConfigured,
  loadCursor,
  loadRemoteSyncConfig,
  saveCursor,
  type RemoteSyncConfig,
} from './config';
import {
  REMOTE_SYNC_PROTOCOL_VERSION,
  type RemoteBatchContents,
} from './protocol';

export const REMOTE_SYNC_TRANSPORT_ID = 'remote-server';

export interface RemoteSyncTransportOptions {
  /** Overrides the OPFS-stored config; mainly for tests */
  config?: RemoteSyncConfig;
}

export class RemoteSyncTransport implements SyncTransport {
  readonly id = REMOTE_SYNC_TRANSPORT_ID;
  readonly name = 'Remote server';

  private host: SyncTransportHost | null = null;
  private client: RemoteSyncClient | null = null;
  private keys: VaultKeys | null = null;
  private status: SyncTransportStatus = { ...IDLE_TRANSPORT_STATUS };
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  /** Guards against overlapping pulls when a poll and a force-sync collide. */
  private pulling: Promise<void> | null = null;
  /** This device's id, supplied by the host so our own batches can be skipped. */
  private deviceId = '';

  constructor(private options: RemoteSyncTransportOptions = {}) {}

  async initialize(host: SyncTransportHost): Promise<void> {
    this.host = host;
    this.deviceId = host.deviceId;
    this.destroyed = false;

    const config = this.options.config ?? (await loadRemoteSyncConfig());

    // Not set up yet is a normal state, not an error. Stay idle and let the
    // settings UI call reconfigure() once the user finishes.
    if (!isConfigured(config) || !config.keys) {
      this.setStatus({ ...IDLE_TRANSPORT_STATUS });
      return;
    }

    this.setStatus({ state: 'connecting', lastError: null });

    try {
      this.keys = await deserializeVaultKeys(config.keys);
      this.client = new RemoteSyncClient({
        serverUrl: config.serverUrl,
        vaultId: this.keys.vaultId,
        accessToken: config.accessToken,
      });

      await this.client.checkHealth();
      if (this.destroyed) return;

      this.setStatus({
        state: 'connected',
        connectedPeers: 1,
        lastError: null,
      });
      this.startPolling(config.pollIntervalMs);

      // Catch up immediately rather than waiting for the first poll tick.
      await this.pull(0);
    } catch (error) {
      if (this.destroyed) return;
      this.reportFailure(error);
    }
  }

  /**
   * Re-read configuration and reconnect. Called by the settings UI after the
   * user changes the server, label or passphrase.
   */
  async reconfigure(config?: RemoteSyncConfig): Promise<void> {
    const host = this.host;
    this.teardownConnection();
    if (config) this.options = { ...this.options, config };
    if (host) await this.initialize(host);
  }

  async push(changes: SyncChange<SyncableRow>[]): Promise<void> {
    if (!this.client || !this.keys || changes.length === 0) return;

    const contents: RemoteBatchContents = {
      version: REMOTE_SYNC_PROTOCOL_VERSION,
      pushedAt: Date.now(),
      changes,
    };

    try {
      const payload = await encryptPayload(this.keys, contents);
      const { seq } = await this.client.pushBatch(this.deviceId, payload);
      // Our own batch is already applied locally, so skip past it.
      await saveCursor(this.keys.vaultId, seq);
      this.setStatus({
        state: 'connected',
        connectedPeers: 1,
        lastError: null,
      });
    } catch (error) {
      this.reportFailure(error);
      throw error;
    }
  }

  /**
   * `sinceTimestamp` is ignored on purpose: the server log is ordered by
   * sequence number, which is exact, rather than by device clocks, which drift.
   */
  async pull(_sinceTimestamp: number): Promise<void> {
    if (!this.client || !this.keys) return;
    // Collapse concurrent callers onto the in-flight request.
    if (this.pulling) return this.pulling;

    this.pulling = this.doPull().finally(() => {
      this.pulling = null;
    });
    return this.pulling;
  }

  private async doPull(): Promise<void> {
    const client = this.client;
    const keys = this.keys;
    if (!client || !keys) return;

    try {
      let cursor = await loadCursor(keys.vaultId);
      let hasMore = true;

      // The server caps page size, so drain until we reach the head.
      while (hasMore && !this.destroyed) {
        const { batches, latestSeq } = await client.pullBatches(cursor);
        if (batches.length === 0) break;

        const changes: SyncChange<SyncableRow>[] = [];
        let highestSeq = cursor;

        for (const batch of batches) {
          highestSeq = Math.max(highestSeq, batch.seq);
          // Our own writes are already in the local database.
          if (batch.deviceId === this.deviceId) continue;

          try {
            const contents = await decryptPayload<RemoteBatchContents>(
              keys,
              batch.payload
            );
            changes.push(...(contents.changes as SyncChange<SyncableRow>[]));
          } catch (error) {
            // A batch we cannot decrypt is almost always a passphrase
            // mismatch. Skip it rather than stalling the whole log.
            console.warn(
              `[remote-sync] Skipping undecryptable batch ${batch.seq}:`,
              error
            );
          }
        }

        if (changes.length > 0) {
          this.host?.onChangesReceived(changes);
        }

        cursor = highestSeq;
        await saveCursor(keys.vaultId, cursor);
        hasMore = cursor < latestSeq;
      }

      if (!this.destroyed) {
        this.setStatus({
          state: 'connected',
          connectedPeers: 1,
          lastError: null,
        });
      }
    } catch (error) {
      if (!this.destroyed) this.reportFailure(error);
    }
  }

  getStatus(): SyncTransportStatus {
    return this.status;
  }

  destroy(): void {
    this.destroyed = true;
    this.teardownConnection();
    this.host = null;
    this.status = { ...IDLE_TRANSPORT_STATUS };
  }

  private teardownConnection(): void {
    this.stopPolling();
    this.client = null;
    this.keys = null;
  }

  private startPolling(intervalMs: number): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.pull(0);
    }, intervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private reportFailure(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    const offline =
      typeof navigator !== 'undefined' && navigator.onLine === false;

    this.setStatus({
      // Being offline is expected in a local-first app; do not flag it as an error.
      state: offline ? 'offline' : 'error',
      connectedPeers: 0,
      lastError: err.message,
    });

    // 4xx means the config is wrong and polling will not fix it; surface it.
    // Network blips stay quiet since the next poll usually recovers.
    const status = err instanceof RemoteSyncError ? err.status : undefined;
    if (status !== undefined && status >= 400 && status < 500) {
      this.host?.onError(this.id, err);
    }
  }

  private setStatus(patch: Partial<SyncTransportStatus>): void {
    this.status = { ...this.status, ...patch };
    this.host?.onStatusChanged(this.id, this.status);
  }
}

export function createRemoteSyncTransport(
  options: RemoteSyncTransportOptions = {}
): RemoteSyncTransport {
  return new RemoteSyncTransport(options);
}
