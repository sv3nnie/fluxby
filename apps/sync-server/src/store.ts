/**
 * Vault storage.
 *
 * The server is an append-only log of opaque blobs. It never holds a key and
 * cannot read a payload, so there is deliberately nothing here that inspects
 * or transforms batch contents.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export interface StoredBatch {
  seq: number;
  deviceId: string;
  createdAt: number;
  payload: string;
}

export interface VaultQuota {
  /** Maximum bytes a single batch payload may occupy */
  maxBatchBytes: number;
  /** Maximum total payload bytes retained per vault */
  maxVaultBytes: number;
}

export const DEFAULT_QUOTA: VaultQuota = {
  maxBatchBytes: 1024 * 1024, // 1 MiB
  maxVaultBytes: 256 * 1024 * 1024, // 256 MiB
};

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Auth tokens are only ever stored hashed. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vaults (
  vault_id    TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  bytes_used  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS batches (
  vault_id   TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  device_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (vault_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_batches_vault_seq ON batches (vault_id, seq);
`;

export class VaultStore {
  private db: Database.Database;

  constructor(
    filename = ':memory:',
    private quota: VaultQuota = DEFAULT_QUOTA
  ) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  /**
   * Authenticate a request, registering the vault on first contact.
   *
   * Trust-on-first-use: the first client to present a token for an unknown
   * vault id claims it. Vault ids are 128-bit values derived from a passphrase
   * rather than anything guessable, so claiming someone else's requires
   * already knowing a secret you could not have derived without their
   * passphrase.
   */
  authenticate(vaultId: string, token: string): void {
    if (!token) throw new AuthError('Missing bearer token');

    const tokenHash = hashToken(token);
    const existing = this.db
      .prepare('SELECT token_hash FROM vaults WHERE vault_id = ?')
      .get(vaultId) as { token_hash: string } | undefined;

    if (!existing) {
      this.db
        .prepare(
          'INSERT INTO vaults (vault_id, token_hash, created_at) VALUES (?, ?, ?)'
        )
        .run(vaultId, tokenHash, Date.now());
      return;
    }

    if (!timingSafeEqualHex(existing.token_hash, tokenHash)) {
      throw new AuthError('Invalid token for this vault');
    }
  }

  /** Append a batch and return its assigned sequence number. */
  append(vaultId: string, deviceId: string, payload: string): number {
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes > this.quota.maxBatchBytes) {
      throw new QuotaExceededError(
        `Batch of ${bytes} bytes exceeds the ${this.quota.maxBatchBytes} byte limit`
      );
    }

    const append = this.db.transaction(() => {
      const vault = this.db
        .prepare('SELECT bytes_used FROM vaults WHERE vault_id = ?')
        .get(vaultId) as { bytes_used: number } | undefined;

      const used = vault?.bytes_used ?? 0;
      if (used + bytes > this.quota.maxVaultBytes) {
        throw new QuotaExceededError('Vault storage quota exceeded');
      }

      const row = this.db
        .prepare('SELECT MAX(seq) AS maxSeq FROM batches WHERE vault_id = ?')
        .get(vaultId) as { maxSeq: number | null };
      const seq = (row.maxSeq ?? 0) + 1;

      this.db
        .prepare(
          `INSERT INTO batches (vault_id, seq, device_id, created_at, payload)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(vaultId, seq, deviceId, Date.now(), payload);

      this.db
        .prepare(
          'UPDATE vaults SET bytes_used = bytes_used + ? WHERE vault_id = ?'
        )
        .run(bytes, vaultId);

      return seq;
    });

    return append();
  }

  /** Batches with seq greater than `since`, oldest first. */
  list(vaultId: string, since: number, limit: number): StoredBatch[] {
    const rows = this.db
      .prepare(
        `SELECT seq, device_id AS deviceId, created_at AS createdAt, payload
         FROM batches
         WHERE vault_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`
      )
      .all(vaultId, since, limit) as StoredBatch[];
    return rows;
  }

  latestSeq(vaultId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS maxSeq FROM batches WHERE vault_id = ?')
      .get(vaultId) as { maxSeq: number | null };
    return row.maxSeq ?? 0;
  }

  /**
   * Drop every batch at or below `throughSeq`.
   *
   * Used for compaction: once a device has uploaded a snapshot covering the
   * log up to a point, the batches it replaces are redundant.
   */
  truncate(vaultId: string, throughSeq: number): number {
    const truncate = this.db.transaction(() => {
      const doomed = this.db
        .prepare('SELECT payload FROM batches WHERE vault_id = ? AND seq <= ?')
        .all(vaultId, throughSeq) as { payload: string }[];

      const freed = doomed.reduce(
        (total, b) => total + Buffer.byteLength(b.payload, 'utf8'),
        0
      );

      const result = this.db
        .prepare('DELETE FROM batches WHERE vault_id = ? AND seq <= ?')
        .run(vaultId, throughSeq);

      this.db
        .prepare(
          'UPDATE vaults SET bytes_used = MAX(0, bytes_used - ?) WHERE vault_id = ?'
        )
        .run(freed, vaultId);

      return result.changes;
    });

    return truncate();
  }

  close(): void {
    this.db.close();
  }
}

/** Constant-time comparison of two equal-length hex digests. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
