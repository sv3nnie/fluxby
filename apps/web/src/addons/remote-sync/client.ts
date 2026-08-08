/**
 * HTTP client for a Fluxby remote sync server.
 *
 * Transport-level only: it moves already-encrypted payloads and never sees a
 * key. Encryption happens in `crypto.ts`, orchestration in `transport.ts`.
 */

import type {
  BeginSnapshotResponse,
  CommitSnapshotRequest,
  GetSnapshotChunkResponse,
  GetSnapshotResponse,
  PullBatchesResponse,
  PushBatchRequest,
  PushBatchResponse,
  PutSnapshotChunkRequest,
  RemoteSyncErrorBody,
  SnapshotManifest,
} from './protocol';

export interface RemoteSyncClientOptions {
  /** Base URL of the sync server, e.g. https://sync.example.com */
  serverUrl: string;
  /** Derived, server-visible vault identifier */
  vaultId: string;
  /**
   * Derived bearer token proving ownership of this vault. The server stores
   * only its hash, so this authenticates without protecting any data.
   */
  authToken: string;
  /** Per-request timeout in ms (default 15000) */
  timeoutMs?: number;
}

export class RemoteSyncError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'RemoteSyncError';
  }
}

export class RemoteSyncClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private options: RemoteSyncClientOptions) {
    // Normalise so path joining is predictable regardless of what was typed.
    this.baseUrl = options.serverUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  get vaultId(): string {
    return this.options.vaultId;
  }

  /** Append an encrypted batch to the vault log. */
  async pushBatch(
    deviceId: string,
    payload: string
  ): Promise<PushBatchResponse> {
    const body: PushBatchRequest = { deviceId, payload };
    return this.request<PushBatchResponse>(`${this.vaultPath}/batches`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /** Fetch batches with `seq` greater than `since`. */
  async pullBatches(since: number, limit = 200): Promise<PullBatchesResponse> {
    const query = new URLSearchParams({
      since: String(since),
      limit: String(limit),
    });
    return this.request<PullBatchesResponse>(
      `${this.vaultPath}/batches?${query}`,
      { method: 'GET' }
    );
  }

  /** Cheap reachability probe used by the settings UI. */
  async checkHealth(): Promise<void> {
    await this.request<unknown>('/v1/health', { method: 'GET' });
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  /** The live snapshot, or null when the vault has never been snapshotted. */
  async getSnapshot(): Promise<SnapshotManifest | null> {
    const { snapshot } = await this.request<GetSnapshotResponse>(
      `${this.vaultPath}/snapshot`,
      { method: 'GET' }
    );
    return snapshot;
  }

  /** Reserve a snapshot id. Chunks stay invisible until commit. */
  async beginSnapshot(): Promise<BeginSnapshotResponse> {
    return this.request<BeginSnapshotResponse>(`${this.vaultPath}/snapshots`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async putSnapshotChunk(
    snapshotId: string,
    index: number,
    payload: string
  ): Promise<void> {
    const body: PutSnapshotChunkRequest = { payload };
    await this.request<unknown>(
      `${this.vaultPath}/snapshots/${encodeURIComponent(snapshotId)}/chunks/${index}`,
      { method: 'PUT', body: JSON.stringify(body) }
    );
  }

  /** Publish the snapshot and compact the batches it supersedes. */
  async commitSnapshot(
    snapshotId: string,
    request: CommitSnapshotRequest
  ): Promise<void> {
    await this.request<unknown>(
      `${this.vaultPath}/snapshots/${encodeURIComponent(snapshotId)}/commit`,
      { method: 'POST', body: JSON.stringify(request) }
    );
  }

  async getSnapshotChunk(
    snapshotId: string,
    index: number
  ): Promise<GetSnapshotChunkResponse> {
    return this.request<GetSnapshotChunkResponse>(
      `${this.vaultPath}/snapshots/${encodeURIComponent(snapshotId)}/chunks/${index}`,
      { method: 'GET' }
    );
  }

  private get vaultPath(): string {
    return `/v1/vaults/${encodeURIComponent(this.options.vaultId)}`;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.authToken}`,
          ...init.headers,
        },
      });

      if (!response.ok) {
        throw new RemoteSyncError(
          await this.describeFailure(response),
          response.status
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof RemoteSyncError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new RemoteSyncError(
          `Request to ${this.baseUrl} timed out after ${this.timeoutMs}ms`
        );
      }
      throw new RemoteSyncError(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Best-effort extraction of a useful message from an error response. */
  private async describeFailure(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as RemoteSyncErrorBody;
      if (body?.message) return body.message;
      if (body?.error) return body.error;
    } catch {
      // Body was not JSON; fall through to the status line.
    }
    return `Server responded ${response.status} ${response.statusText}`;
  }
}
