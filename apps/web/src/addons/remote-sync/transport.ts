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
import type { SyncDatabaseAdapter } from '@fluxby/database';
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
import {
  createSnapshot,
  restoreSnapshot,
  shouldCreateSnapshot,
  type CreateSnapshotResult,
} from './snapshot';

export const REMOTE_SYNC_TRANSPORT_ID = 'remote-server';

/**
 * Batches to accumulate past the last snapshot before taking a new one.
 *
 * Low enough that a new device never replays a long tail, high enough that
 * snapshotting stays rare relative to ordinary syncing.
 */
export const DEFAULT_SNAPSHOT_THRESHOLD = 500;

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
  /** The app's encryption key, needed to unwrap stored sync keys. */
  private masterKey: Uint8Array | null = null;

  constructor(private options: RemoteSyncTransportOptions = {}) {}

  /**
   * Supply (or clear) the app's encryption key.
   *
   * Stored keys are wrapped with it, so syncing cannot resume while the app is
   * locked. Clearing drops the connection immediately.
   */
  setMasterKey(masterKey: Uint8Array | null): void {
    this.masterKey = masterKey;
  }

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
      this.keys = await deserializeVaultKeys(config.keys, this.masterKey);
      this.client = new RemoteSyncClient({
        serverUrl: config.serverUrl,
        vaultId: this.keys.vaultId,
        authToken: this.keys.authToken,
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

      // Before replaying the log, see whether a snapshot can get us further in
      // one step. This covers two cases with the same code path: a brand-new
      // device starting at 0, and a device that fell so far behind that the
      // batches it still needs have been compacted away.
      const snapshot = await client.getSnapshot();
      if (snapshot && snapshot.throughSeq > cursor) {
        await restoreSnapshot({
          client,
          keys,
          manifest: snapshot,
          applyChanges: async (changes) => {
            await this.host?.onChangesReceived(changes);
          },
        });
        // Only advance once every chunk applied; restoreSnapshot throws
        // otherwise, leaving the cursor where it was so the next pull retries.
        cursor = snapshot.throughSeq;
        await saveCursor(keys.vaultId, cursor);
      }

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
          // Awaited so the cursor only advances once the changes are durably
          // applied. If this throws, the batch is retried on the next pull.
          await this.host?.onChangesReceived(changes);
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

  /**
   * Publish a snapshot if the log has grown enough to be worth replacing.
   *
   * `throughSeq` is this device's own applied cursor, never the server's
   * latest sequence: a device that has not applied batch N cannot produce a
   * snapshot standing in for batch N, and publishing one would drop those rows
   * for every device that later restores from it.
   *
   * Returns null when no snapshot was needed or possible.
   */
  async maybeCreateSnapshot(
    adapter: SyncDatabaseAdapter,
    threshold = DEFAULT_SNAPSHOT_THRESHOLD
  ): Promise<CreateSnapshotResult | null> {
    const client = this.client;
    const keys = this.keys;
    if (!client || !keys) return null;

    try {
      const [snapshot, cursor] = await Promise.all([
        client.getSnapshot(),
        loadCursor(keys.vaultId),
      ]);

      // Only a caught-up device may snapshot, and only once the log has grown.
      const { latestSeq } = await client.pullBatches(cursor, 1);
      if (cursor < latestSeq) return null;
      if (!shouldCreateSnapshot(cursor, snapshot, threshold)) return null;

      return await createSnapshot({
        adapter,
        client,
        keys,
        deviceId: this.deviceId,
        throughSeq: cursor,
      });
    } catch (error) {
      // A failed snapshot costs nothing: the log is still authoritative.
      console.warn('[remote-sync] Snapshot creation failed:', error);
      return null;
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

    // A locked app is an expected resting state, not a failure to report.
    if (err.message.includes('locked')) {
      this.setStatus({
        state: 'idle',
        connectedPeers: 0,
        lastError: err.message,
      });
      return;
    }
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
