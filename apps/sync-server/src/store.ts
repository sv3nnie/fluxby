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

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class InvalidSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSnapshotError';
  }
}

export interface SnapshotRecord {
  snapshotId: string;
  throughSeq: number;
  chunkCount: number;
  rowCount: number;
  deviceId: string;
  createdAt: number;
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
  bytes_used  INTEGER NOT NULL DEFAULT 0,
  -- Sequence high-water mark. Held here rather than derived from MAX(seq) in
  -- batches: compaction can empty that table entirely, and a sequence counter
  -- that restarts would hand out numbers a restored device has already passed,
  -- so those batches would never be delivered.
  last_seq    INTEGER NOT NULL DEFAULT 0
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

-- Snapshots become visible only when committed, so a partial or abandoned
-- upload can never be restored from.
CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id TEXT PRIMARY KEY,
  vault_id    TEXT NOT NULL,
  through_seq INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  row_count   INTEGER NOT NULL DEFAULT 0,
  device_id   TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  committed   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_snapshots_vault ON snapshots (vault_id, committed);

CREATE TABLE IF NOT EXISTS snapshot_chunks (
  snapshot_id TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, idx)
);
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
    this.migrate();
  }

  /** Idempotent column additions for databases created by earlier versions. */
  private migrate(): void {
    const columns = this.db.prepare('PRAGMA table_info(vaults)').all() as {
      name: string;
    }[];

    if (!columns.some((c) => c.name === 'last_seq')) {
      this.db.exec(
        'ALTER TABLE vaults ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0'
      );
      // Seed from whatever is still in the log so numbering continues.
      this.db.exec(`
        UPDATE vaults SET last_seq = COALESCE(
          (SELECT MAX(seq) FROM batches WHERE batches.vault_id = vaults.vault_id), 0
        )
      `);
    }
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
        .prepare('SELECT last_seq AS lastSeq FROM vaults WHERE vault_id = ?')
        .get(vaultId) as { lastSeq: number } | undefined;
      const seq = (row?.lastSeq ?? 0) + 1;

      this.db
        .prepare(
          `INSERT INTO batches (vault_id, seq, device_id, created_at, payload)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(vaultId, seq, deviceId, Date.now(), payload);

      this.db
        .prepare(
          'UPDATE vaults SET bytes_used = bytes_used + ?, last_seq = ? WHERE vault_id = ?'
        )
        .run(bytes, seq, vaultId);

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

  /**
   * Highest sequence number ever issued for this vault, whether or not that
   * batch still exists. Survives compaction so cursors stay meaningful.
   */
  latestSeq(vaultId: string): number {
    const row = this.db
      .prepare('SELECT last_seq AS lastSeq FROM vaults WHERE vault_id = ?')
      .get(vaultId) as { lastSeq: number } | undefined;
    return row?.lastSeq ?? 0;
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

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  /** Reserve a snapshot id. Nothing is visible to readers until commit. */
  beginSnapshot(vaultId: string, snapshotId: string): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (snapshot_id, vault_id, created_at, committed)
         VALUES (?, ?, ?, 0)`
      )
      .run(snapshotId, vaultId, Date.now());
  }

  putSnapshotChunk(
    vaultId: string,
    snapshotId: string,
    index: number,
    payload: string
  ): void {
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes > this.quota.maxBatchBytes) {
      throw new QuotaExceededError(
        `Snapshot chunk of ${bytes} bytes exceeds the ${this.quota.maxBatchBytes} byte limit`
      );
    }

    const owner = this.db
      .prepare(
        'SELECT vault_id, committed FROM snapshots WHERE snapshot_id = ?'
      )
      .get(snapshotId) as { vault_id: string; committed: number } | undefined;

    if (!owner || owner.vault_id !== vaultId) {
      throw new NotFoundError('Unknown snapshot');
    }
    if (owner.committed) {
      // Committed snapshots are immutable; readers may already be using them.
      throw new NotFoundError('Snapshot is already committed');
    }

    this.db
      .prepare(
        `INSERT INTO snapshot_chunks (snapshot_id, idx, payload)
         VALUES (?, ?, ?)
         ON CONFLICT (snapshot_id, idx) DO UPDATE SET payload = excluded.payload`
      )
      .run(snapshotId, index, payload);
  }

  /**
   * Publish a snapshot: replace any previous one and drop the batches it
   * supersedes, all in a single transaction so readers never observe a vault
   * with neither a snapshot nor the batches it replaced.
   */
  commitSnapshot(
    vaultId: string,
    snapshotId: string,
    meta: {
      throughSeq: number;
      chunkCount: number;
      rowCount: number;
      deviceId: string;
    }
  ): void {
    const commit = this.db.transaction(() => {
      const pending = this.db
        .prepare(
          'SELECT vault_id, committed FROM snapshots WHERE snapshot_id = ?'
        )
        .get(snapshotId) as { vault_id: string; committed: number } | undefined;

      if (!pending || pending.vault_id !== vaultId) {
        throw new NotFoundError('Unknown snapshot');
      }

      const uploaded = this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM snapshot_chunks WHERE snapshot_id = ?'
        )
        .get(snapshotId) as { n: number };

      // Refuse to publish something that cannot be fully restored.
      if (uploaded.n !== meta.chunkCount) {
        throw new InvalidSnapshotError(
          `Expected ${meta.chunkCount} chunks but ${uploaded.n} were uploaded`
        );
      }

      const previous = this.db
        .prepare(
          'SELECT snapshot_id FROM snapshots WHERE vault_id = ? AND committed = 1'
        )
        .all(vaultId) as { snapshot_id: string }[];

      this.db
        .prepare(
          `UPDATE snapshots
              SET through_seq = ?, chunk_count = ?, row_count = ?,
                  device_id = ?, committed = 1
            WHERE snapshot_id = ?`
        )
        .run(
          meta.throughSeq,
          meta.chunkCount,
          meta.rowCount,
          meta.deviceId,
          snapshotId
        );

      // The new snapshot stands in for everything the old one covered.
      for (const old of previous) {
        this.db
          .prepare('DELETE FROM snapshot_chunks WHERE snapshot_id = ?')
          .run(old.snapshot_id);
        this.db
          .prepare('DELETE FROM snapshots WHERE snapshot_id = ?')
          .run(old.snapshot_id);
      }

      // Batches at or below throughSeq are now redundant. Unlike bare
      // compaction the head may go too: the snapshot itself is the floor a
      // lagging device falls back to.
      this.truncateWithin(vaultId, meta.throughSeq);
    });

    commit();
  }

  /** The live snapshot for a vault, if one has been committed. */
  getSnapshot(vaultId: string): SnapshotRecord | null {
    const row = this.db
      .prepare(
        `SELECT snapshot_id AS snapshotId, through_seq AS throughSeq,
                chunk_count AS chunkCount, row_count AS rowCount,
                device_id AS deviceId, created_at AS createdAt
           FROM snapshots
          WHERE vault_id = ? AND committed = 1
          ORDER BY through_seq DESC
          LIMIT 1`
      )
      .get(vaultId) as SnapshotRecord | undefined;
    return row ?? null;
  }

  getSnapshotChunk(
    vaultId: string,
    snapshotId: string,
    index: number
  ): string | null {
    const row = this.db
      .prepare(
        `SELECT c.payload AS payload
           FROM snapshot_chunks c
           JOIN snapshots s ON s.snapshot_id = c.snapshot_id
          WHERE c.snapshot_id = ? AND c.idx = ?
            AND s.vault_id = ? AND s.committed = 1`
      )
      .get(snapshotId, index, vaultId) as { payload: string } | undefined;
    return row?.payload ?? null;
  }

  /**
   * Discard uncommitted snapshots older than `olderThanMs`.
   *
   * An upload that is interrupted leaves chunks behind that no reader can ever
   * see, so they have to be swept. A window of 0 purges every uncommitted
   * snapshot, which is why the comparison is inclusive.
   */
  purgeAbandonedSnapshots(olderThanMs = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - olderThanMs;
    const purge = this.db.transaction(() => {
      const stale = this.db
        .prepare(
          'SELECT snapshot_id FROM snapshots WHERE committed = 0 AND created_at <= ?'
        )
        .all(cutoff) as { snapshot_id: string }[];

      for (const s of stale) {
        this.db
          .prepare('DELETE FROM snapshot_chunks WHERE snapshot_id = ?')
          .run(s.snapshot_id);
        this.db
          .prepare('DELETE FROM snapshots WHERE snapshot_id = ?')
          .run(s.snapshot_id);
      }
      return stale.length;
    });
    return purge();
  }

  /** Delete batches through `throughSeq` without the retain-the-head rule. */
  private truncateWithin(vaultId: string, throughSeq: number): number {
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
