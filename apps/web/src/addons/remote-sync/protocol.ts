/**
 * Remote Sync wire protocol
 *
 * The server is an append-only log of encrypted batches, one log per vault.
 * It performs no merging: it hands back batches in sequence order and the
 * client resolves conflicts locally with the existing Last-Write-Wins rules.
 *
 * What the server can see:
 *   - vault id (a derived, opaque identifier)
 *   - device id
 *   - sequence number and receive timestamp
 *   - payload size
 * What it cannot see:
 *   - any transaction, account, category or amount
 *   - table names, row ids, or row timestamps
 *
 * Keep this file in sync with the server implementation; it is the contract.
 */

export const REMOTE_SYNC_PROTOCOL_VERSION = 1;

/** A batch as stored and returned by the server. */
export interface RemoteBatch {
  /** Monotonic per-vault sequence number, assigned by the server */
  seq: number;
  /** Device that produced the batch, so clients can skip their own */
  deviceId: string;
  /** Server receive time (ms since epoch); advisory only, never trusted for LWW */
  createdAt: number;
  /** base64(nonce || AES-GCM ciphertext) */
  payload: string;
}

/** Decrypted contents of a batch payload. */
export interface RemoteBatchContents {
  version: typeof REMOTE_SYNC_PROTOCOL_VERSION;
  /** Device clock at push time, for diagnostics only */
  pushedAt: number;
  /** The sync changes carried by this batch */
  changes: unknown[];
}

/** POST /v1/vaults/:vaultId/batches */
export interface PushBatchRequest {
  deviceId: string;
  payload: string;
}

export interface PushBatchResponse {
  seq: number;
}

/** GET /v1/vaults/:vaultId/batches?since=<seq>&limit=<n> */
export interface PullBatchesResponse {
  batches: RemoteBatch[];
  /** Highest sequence number in the vault, so clients know if more remain */
  latestSeq: number;
}

export interface RemoteSyncErrorBody {
  error: string;
  message?: string;
}
