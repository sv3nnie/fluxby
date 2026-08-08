/**
 * Remote Sync configuration, persisted in OPFS alongside the app's other
 * device-level settings.
 *
 * On key storage: the derived AES key is cached here so sync can resume after
 * a reload without re-entering the passphrase. That is the same trust boundary
 * as the local database itself -- anyone who can read OPFS can already read the
 * plaintext data. The passphrase itself is never written anywhere.
 */

import {
  readFromOPFS,
  writeToOPFS,
  deleteFromOPFSWithCache,
} from '@fluxby/database';
import type { SerializedVaultKeys } from './crypto';

const CONFIG_KEY = 'fluxby.addons.remoteSync.config';
const CURSOR_KEY = 'fluxby.addons.remoteSync.cursor';

export interface RemoteSyncConfig {
  enabled: boolean;
  serverUrl: string;
  /** User-chosen label that salts the key derivation; must match across devices */
  vaultLabel: string;
  /**
   * The local profile this vault syncs.
   *
   * Bound once at connect time rather than following the active profile:
   * profile ids are generated per device and the `profiles` table is not
   * syncable, so "whatever profile is selected" would merge unrelated
   * finances into each other on a profile switch.
   */
  profileId?: string;
  /** Cached key material; absent until the vault is set up once */
  keys?: SerializedVaultKeys;
  /** How often to poll the server for new batches */
  pollIntervalMs: number;
}

export const DEFAULT_REMOTE_SYNC_CONFIG: RemoteSyncConfig = {
  enabled: false,
  serverUrl: '',
  vaultLabel: '',
  pollIntervalMs: 30_000,
};

export async function loadRemoteSyncConfig(): Promise<RemoteSyncConfig> {
  try {
    const stored = await readFromOPFS<Partial<RemoteSyncConfig>>(CONFIG_KEY);
    if (!stored) return { ...DEFAULT_REMOTE_SYNC_CONFIG };
    return { ...DEFAULT_REMOTE_SYNC_CONFIG, ...stored };
  } catch (error) {
    console.warn('[remote-sync] Failed to read config:', error);
    return { ...DEFAULT_REMOTE_SYNC_CONFIG };
  }
}

export async function saveRemoteSyncConfig(
  config: RemoteSyncConfig
): Promise<void> {
  await writeToOPFS(CONFIG_KEY, config);
}

export async function clearRemoteSyncConfig(): Promise<void> {
  await deleteFromOPFSWithCache(CONFIG_KEY);
  await deleteFromOPFSWithCache(CURSOR_KEY);
}

/**
 * Read the highest server sequence number this device has applied.
 *
 * Kept separate from the config so a settings save can never roll the cursor
 * backwards and cause the whole log to be replayed.
 */
export async function loadCursor(vaultId: string): Promise<number> {
  try {
    const cursors = await readFromOPFS<Record<string, number>>(CURSOR_KEY);
    return cursors?.[vaultId] ?? 0;
  } catch {
    return 0;
  }
}

export async function saveCursor(vaultId: string, seq: number): Promise<void> {
  const cursors =
    (await readFromOPFS<Record<string, number>>(CURSOR_KEY)) ?? {};
  // Never move the cursor backwards.
  if ((cursors[vaultId] ?? 0) >= seq) return;
  cursors[vaultId] = seq;
  await writeToOPFS(CURSOR_KEY, cursors);
}

/** True when the config has everything needed to actually sync. */
export function isConfigured(config: RemoteSyncConfig): boolean {
  return Boolean(
    config.enabled &&
    config.serverUrl &&
    config.vaultLabel &&
    config.profileId &&
    config.keys
  );
}
