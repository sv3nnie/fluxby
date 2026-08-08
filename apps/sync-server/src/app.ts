/**
 * Fluxby Remote Sync server.
 *
 * Implements the contract in apps/web/src/addons/remote-sync/protocol.ts.
 *
 * The server sees vault ids, device ids, sequence numbers and payload sizes.
 * It cannot see table names, row ids, amounts or anything else about the data,
 * because every payload is AES-GCM encrypted on the device before it is sent.
 */

import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import {
  AuthError,
  InvalidSnapshotError,
  NotFoundError,
  QuotaExceededError,
  VaultStore,
  type VaultQuota,
} from './store.js';

export const MAX_PAGE_SIZE = 200;
const VAULT_ID_PATTERN = /^[0-9a-f]{32}$/;

export interface AppOptions {
  store: VaultStore;
  /** Requests per window per IP. Set to 0 to disable (tests). */
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  /** Largest accepted JSON body */
  bodyLimit?: string;
  /**
   * Number of reverse proxies in front of the server. Without this every
   * request appears to come from the proxy and rate limiting throttles all
   * clients as one.
   */
  trustProxy?: number | boolean;
  quota?: VaultQuota;
}

function bearerToken(req: Request): string {
  const header = req.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export function createApp({
  store,
  rateLimitMax = 120,
  rateLimitWindowMs = 60_000,
  bodyLimit = '2mb',
  trustProxy = false,
}: AppOptions) {
  const app = express();

  if (trustProxy !== false) app.set('trust proxy', trustProxy);

  app.use(cors());
  app.use(express.json({ limit: bodyLimit }));

  // Health is deliberately unauthenticated: clients probe it before they have
  // proven anything, and it reveals nothing about any vault.
  app.get('/v1/health', (_req, res) => {
    res.json({ ok: true, service: 'fluxby-sync', protocol: 1 });
  });

  if (rateLimitMax > 0) {
    app.use(
      '/v1/vaults',
      rateLimit({
        windowMs: rateLimitWindowMs,
        limit: rateLimitMax,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'rate_limited', message: 'Too many requests' },
      })
    );
  }

  /** Reject malformed vault ids before they reach storage. */
  const validateVaultId = (
    req: Request,
    res: Response,
    next: NextFunction
  ): void => {
    if (!VAULT_ID_PATTERN.test(req.params.vaultId ?? '')) {
      res.status(400).json({
        error: 'invalid_vault_id',
        message: 'Vault id must be 32 lowercase hex characters',
      });
      return;
    }
    next();
  };

  const authenticate = (
    req: Request,
    res: Response,
    next: NextFunction
  ): void => {
    try {
      store.authenticate(req.params.vaultId, bearerToken(req));
      next();
    } catch (error) {
      if (error instanceof AuthError) {
        res.status(401).json({ error: 'unauthorized', message: error.message });
        return;
      }
      next(error);
    }
  };

  app.post(
    '/v1/vaults/:vaultId/batches',
    validateVaultId,
    authenticate,
    (req: Request, res: Response) => {
      const { deviceId, payload } = req.body ?? {};

      if (typeof deviceId !== 'string' || !deviceId) {
        res
          .status(400)
          .json({ error: 'invalid_request', message: 'deviceId is required' });
        return;
      }
      if (typeof payload !== 'string' || !payload) {
        res
          .status(400)
          .json({ error: 'invalid_request', message: 'payload is required' });
        return;
      }

      try {
        const seq = store.append(req.params.vaultId, deviceId, payload);
        res.json({ seq });
      } catch (error) {
        if (error instanceof QuotaExceededError) {
          res
            .status(413)
            .json({ error: 'quota_exceeded', message: error.message });
          return;
        }
        throw error;
      }
    }
  );

  app.get(
    '/v1/vaults/:vaultId/batches',
    validateVaultId,
    authenticate,
    (req: Request, res: Response) => {
      const since = Number.parseInt(String(req.query.since ?? '0'), 10);
      const requested = Number.parseInt(
        String(req.query.limit ?? MAX_PAGE_SIZE),
        10
      );

      if (!Number.isFinite(since) || since < 0) {
        res
          .status(400)
          .json({ error: 'invalid_request', message: 'since must be >= 0' });
        return;
      }

      // Clamp rather than reject: a client asking for too much should still
      // make progress, one page at a time.
      const limit = Math.min(
        Number.isFinite(requested) && requested > 0 ? requested : MAX_PAGE_SIZE,
        MAX_PAGE_SIZE
      );

      res.json({
        batches: store.list(req.params.vaultId, since, limit),
        latestSeq: store.latestSeq(req.params.vaultId),
      });
    }
  );

  /**
   * Compaction. A client that has uploaded a snapshot covering the log through
   * `throughSeq` can drop the batches it supersedes.
   */
  app.post(
    '/v1/vaults/:vaultId/compact',
    validateVaultId,
    authenticate,
    (req: Request, res: Response) => {
      const throughSeq = Number.parseInt(
        String(req.body?.throughSeq ?? ''),
        10
      );

      if (!Number.isFinite(throughSeq) || throughSeq < 0) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'throughSeq must be a non-negative integer',
        });
        return;
      }

      // Never discard the head: a vault with no batches at all would leave
      // other devices unable to tell an empty log from a truncated one.
      const latest = store.latestSeq(req.params.vaultId);
      const safeThrough = Math.min(throughSeq, Math.max(latest - 1, 0));

      res.json({
        removed: store.truncate(req.params.vaultId, safeThrough),
        latestSeq: latest,
      });
    }
  );

  // ---------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------

  app.get(
    '/v1/vaults/:vaultId/snapshot',
    validateVaultId,
    authenticate,
    (req: Request, res: Response) => {
      res.json({ snapshot: store.getSnapshot(req.params.vaultId) });
    }
  );

  app.post(
    '/v1/vaults/:vaultId/snapshots',
    validateVaultId,
    authenticate,
    (req: Request, res: Response) => {
      const snapshotId = randomUUID();
      store.beginSnapshot(req.params.vaultId, snapshotId);
      res.json({ snapshotId });
    }
  );

  app.put(
    '/v1/vaults/:vaultId/snapshots/:snapshotId/chunks/:index',
    validateVaultId,
    authenticate,
    (req: Request, res: Response) => {
      const index = Number.parseInt(req.params.index, 10);
      const payload = req.body?.payload;

      if (!Number.isFinite(index) || index < 0) {
        res
          .status(400)
          .json({ error: 'invalid_request', message: 'index must be >= 0' });
        return;
      }
      if (typeof payload !== 'string' || !payload) {
        res
          .status(400)
          .json({ error: 'invalid_request', message: 'payload is required' });
        return;
      }

      store.putSnapshotChunk(
        req.params.vaultId,
        req.params.snapshotId,
        index,
        payload
      );
      res.json({ ok: true });
    }
  );

  app.post(
    '/v1/vaults/:vaultId/snapshots/:snapshotId/commit',
    validateVaultId,
    authenticate,
    (req: Request, res: Response) => {
      const throughSeq = Number.parseInt(
        String(req.body?.throughSeq ?? ''),
        10
      );
      const chunkCount = Number.parseInt(
        String(req.body?.chunkCount ?? ''),
        10
      );
      const rowCount = Number.parseInt(String(req.body?.rowCount ?? '0'), 10);
      const deviceId = String(req.body?.deviceId ?? '');

      if (
        !Number.isFinite(throughSeq) ||
        throughSeq < 0 ||
        !Number.isFinite(chunkCount) ||
        chunkCount < 0
      ) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'throughSeq and chunkCount must be non-negative integers',
        });
        return;
      }

      // A snapshot may not claim a position the log has not reached, or every
      // device restoring from it would skip batches that were never covered.
      if (throughSeq > store.latestSeq(req.params.vaultId)) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'throughSeq is ahead of the log',
        });
        return;
      }

      store.commitSnapshot(req.params.vaultId, req.params.snapshotId, {
        throughSeq,
        chunkCount,
        rowCount,
        deviceId,
      });
      res.json({ ok: true });
    }
  );

  app.get(
    '/v1/vaults/:vaultId/snapshots/:snapshotId/chunks/:index',
    validateVaultId,
    authenticate,
    (req: Request, res: Response) => {
      const index = Number.parseInt(req.params.index, 10);
      const payload = store.getSnapshotChunk(
        req.params.vaultId,
        req.params.snapshotId,
        index
      );

      if (payload === null) {
        res.status(404).json({ error: 'not_found', message: 'Unknown chunk' });
        return;
      }
      res.json({ index, payload });
    }
  );

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use(
    (
      error: Error,
      _req: Request,
      res: Response,

      _next: NextFunction
    ) => {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: 'not_found', message: error.message });
        return;
      }
      if (error instanceof InvalidSnapshotError) {
        res
          .status(409)
          .json({ error: 'invalid_snapshot', message: error.message });
        return;
      }
      if (error instanceof QuotaExceededError) {
        res
          .status(413)
          .json({ error: 'quota_exceeded', message: error.message });
        return;
      }
      console.error('[sync-server]', error);
      res.status(500).json({ error: 'internal_error' });
    }
  );

  return app;
}
