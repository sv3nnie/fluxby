/**
 * Snapshot creation and restore.
 *
 * Without snapshots the log grows without bound and every new device replays
 * all of history. A snapshot is a complete encrypted copy of the dataset at
 * one log position; publishing it lets the server discard the batches it
 * supersedes, and lets a new device start from a single recent state.
 *
 * Everything here streams. Rows are read a page at a time, packed into chunks
 * sized to stay inside the server's per-payload limit, and encrypted and
 * uploaded one chunk at a time. Restore is the mirror image: each chunk is
 * applied as it arrives. Peak memory is a function of chunk size, never of
 * dataset size, which is the whole point for a large history.
 */

import type { SyncChange, SyncableRow } from '@fluxby/core';
import type { SyncDatabaseAdapter } from '@fluxby/database';
import { iterateProfileRows } from '@/lib/sync-data';
import type { RemoteSyncClient } from './client';
import { encryptPayload, decryptPayload, type VaultKeys } from './crypto';
import {
  REMOTE_SYNC_PROTOCOL_VERSION,
  type SnapshotChunkContents,
  type SnapshotManifest,
} from './protocol';

/**
 * Target plaintext bytes per chunk.
 *
 * Base64 inflates by 4/3 and AES-GCM adds a nonce and tag, so a 512 KiB
 * plaintext target lands comfortably under a 1 MiB server payload limit.
 */
export const DEFAULT_CHUNK_TARGET_BYTES = 512 * 1024;

/** Rows read from SQLite per page while building a snapshot. */
export const DEFAULT_PAGE_SIZE = 500;

export interface CreateSnapshotOptions {
  adapter: SyncDatabaseAdapter;
  client: RemoteSyncClient;
  keys: VaultKeys;
  deviceId: string;
  /**
   * Log position this snapshot is equivalent to.
   *
   * Must be the creating device's own applied cursor, never the server's
   * latest sequence number: a device that has not yet applied batch N cannot
   * produce a snapshot that stands in for batch N, and publishing one would
   * silently drop those rows for every device that restores from it.
   */
  throughSeq: number;
  chunkTargetBytes?: number;
  pageSize?: number;
  onProgress?: (rowsWritten: number) => void;
}

export interface CreateSnapshotResult {
  snapshotId: string;
  chunkCount: number;
  rowCount: number;
}

/**
 * Build and publish a snapshot.
 *
 * Chunks are uploaded before the manifest is committed, so a partial or
 * abandoned upload is never visible to a reader.
 */
export async function createSnapshot({
  adapter,
  client,
  keys,
  deviceId,
  throughSeq,
  chunkTargetBytes = DEFAULT_CHUNK_TARGET_BYTES,
  pageSize = DEFAULT_PAGE_SIZE,
  onProgress,
}: CreateSnapshotOptions): Promise<CreateSnapshotResult> {
  const { snapshotId } = await client.beginSnapshot();

  let chunkIndex = 0;
  let rowCount = 0;
  let buffer: SyncChange<SyncableRow>[] = [];
  let bufferedBytes = 0;

  const flush = async () => {
    if (buffer.length === 0) return;
    const contents: SnapshotChunkContents = {
      version: REMOTE_SYNC_PROTOCOL_VERSION,
      index: chunkIndex,
      changes: buffer,
    };
    await client.putSnapshotChunk(
      snapshotId,
      chunkIndex,
      await encryptPayload(keys, contents)
    );
    chunkIndex++;
    buffer = [];
    bufferedBytes = 0;
  };

  for await (const page of iterateProfileRows(adapter, pageSize)) {
    for (const change of page) {
      // Measuring the serialized row is more reliable than guessing from
      // column count: descriptions and notes vary enormously in length.
      bufferedBytes += JSON.stringify(change).length;
      buffer.push(change);
      rowCount++;

      if (bufferedBytes >= chunkTargetBytes) await flush();
    }
    onProgress?.(rowCount);
  }

  await flush();

  await client.commitSnapshot(snapshotId, {
    throughSeq,
    chunkCount: chunkIndex,
    rowCount,
    deviceId,
  });

  return { snapshotId, chunkCount: chunkIndex, rowCount };
}

export interface RestoreSnapshotOptions {
  client: RemoteSyncClient;
  keys: VaultKeys;
  manifest: SnapshotManifest;
  /** Applies one chunk's changes; must resolve only once they are persisted. */
  applyChanges: (changes: SyncChange<SyncableRow>[]) => Promise<void>;
  onProgress?: (chunksApplied: number, chunkCount: number) => void;
}

/**
 * Apply a snapshot chunk by chunk.
 *
 * Chunks are fetched and applied strictly in order and one at a time, so a
 * large restore never materialises the whole dataset in memory. Any failure
 * propagates: the caller must not advance its cursor on a partial restore.
 */
export async function restoreSnapshot({
  client,
  keys,
  manifest,
  applyChanges,
  onProgress,
}: RestoreSnapshotOptions): Promise<number> {
  let applied = 0;

  for (let index = 0; index < manifest.chunkCount; index++) {
    const { payload } = await client.getSnapshotChunk(
      manifest.snapshotId,
      index
    );
    const contents = await decryptPayload<SnapshotChunkContents>(keys, payload);
    const changes = contents.changes as SyncChange<SyncableRow>[];

    if (changes.length > 0) await applyChanges(changes);

    applied += changes.length;
    onProgress?.(index + 1, manifest.chunkCount);
  }

  return applied;
}

/**
 * Whether this device should publish a new snapshot.
 *
 * Snapshotting is expensive, so it is worth doing only once the log has grown
 * enough that replaying it costs more than restoring a fresh copy. Any device
 * may do it; a redundant snapshot is wasteful but harmless, since committing
 * one atomically replaces the last.
 */
export function shouldCreateSnapshot(
  latestSeq: number,
  snapshot: SnapshotManifest | null,
  threshold: number
): boolean {
  if (threshold <= 0) return false;
  const base = snapshot?.throughSeq ?? 0;
  return latestSeq - base >= threshold;
}
