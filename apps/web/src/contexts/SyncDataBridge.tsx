/**
 * Sync Data Bridge
 *
 * Connects the sync layer to the database. Without it the transports pair,
 * encrypt and exchange messages, but nothing is ever read from or written to
 * SQLite -- the merge helpers in @fluxby/database had no caller.
 *
 * It sits between DatabaseProvider and SyncProvider so it can supply the two
 * callbacks SyncProvider expects:
 *   - onSyncReceived:  apply remote changes locally (Last-Write-Wins)
 *   - onSyncRequested: hand our local changes to whoever asked
 *
 * Outbound changes are found by diffing against a stored high-water mark
 * rather than by intercepting every write, so no mutation site has to know
 * that sync exists.
 */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createSyncAdapter, readFromOPFS, writeToOPFS } from '@fluxby/database';
import type { SyncChange, SyncableRow } from '@fluxby/core';
import {
  applyIncomingChanges,
  collectLocalChanges,
  nextPushCursor,
} from '@/lib/sync-data';
import { SyncProvider, useSync } from './SyncContext';
import { useDatabase } from './DatabaseContext';
import { useProfile } from './ProfileContext';
import { addonSyncTransports } from '@/addons/registry';

/** High-water mark of what this device has already handed to the sync layer. */
const PUSH_CURSOR_KEY = 'fluxby.syncPushCursor';
/** Matches the key SyncContext uses, so both agree on this device's identity. */
const DEVICE_ID_KEY = 'fluxby.deviceId';
/** The one profile this device syncs. See getSyncProfileId below. */
const SYNC_PROFILE_KEY = 'fluxby.syncProfileId';
/** How often to sweep the database for changes that still need pushing. */
const PUSH_SWEEP_INTERVAL_MS = 15_000;

/**
 * Resolve which profile takes part in sync, binding it on first use.
 *
 * Sync must not simply follow the active profile. Profile ids are generated
 * per device with crypto.randomUUID and the `profiles` table is not in
 * SYNCABLE_TABLES, so there is no shared notion of profile identity between
 * devices: incoming rows are necessarily stamped with the local profile. If
 * that were whichever profile happened to be selected, switching profiles
 * would merge two unrelated sets of finances into one.
 *
 * Binding once and refusing to sync any other profile keeps the mapping
 * one-to-one until profiles themselves become syncable.
 */
async function getSyncProfileId(
  activeProfileId: string | null
): Promise<string | null> {
  try {
    const bound = await readFromOPFS<string>(SYNC_PROFILE_KEY);
    if (bound) return bound;
    if (!activeProfileId) return null;
    await writeToOPFS(SYNC_PROFILE_KEY, activeProfileId);
    return activeProfileId;
  } catch (error) {
    console.warn('[sync] Could not resolve the bound sync profile:', error);
    return null;
  }
}

async function loadPushCursor(profileId: string): Promise<number> {
  try {
    const cursors = await readFromOPFS<Record<string, number>>(PUSH_CURSOR_KEY);
    return cursors?.[profileId] ?? 0;
  } catch {
    return 0;
  }
}

async function savePushCursor(
  profileId: string,
  timestamp: number
): Promise<void> {
  const cursors =
    (await readFromOPFS<Record<string, number>>(PUSH_CURSOR_KEY)) ?? {};
  if ((cursors[profileId] ?? 0) >= timestamp) return;
  cursors[profileId] = timestamp;
  await writeToOPFS(PUSH_CURSOR_KEY, cursors);
}

export function SyncDataBridge({ children }: { children: ReactNode }) {
  const { db, isReady } = useDatabase();
  const { activeProfileId } = useProfile();

  // Read through refs so the callbacks stay referentially stable: SyncProvider
  // treats them as effect inputs, and new identities would churn transports.
  const dbRef = useRef(db);
  dbRef.current = db;
  const deviceIdRef = useRef<string | null>(null);
  const syncProfileRef = useRef<string | null>(null);

  // Resolve the bound sync profile once the app knows which profile is active.
  useEffect(() => {
    let active = true;
    void getSyncProfileId(activeProfileId).then((bound) => {
      if (active) syncProfileRef.current = bound;
    });
    return () => {
      active = false;
    };
  }, [activeProfileId]);

  /**
   * Adapter for the bound sync profile, or null when sync must not run --
   * including when the user has switched to a different profile.
   */
  const getAdapter = useCallback(() => {
    const database = dbRef.current;
    const profileId = syncProfileRef.current;
    if (!database || !profileId) return null;
    return createSyncAdapter(database, profileId);
  }, []);

  const getDeviceId = useCallback(async () => {
    if (deviceIdRef.current) return deviceIdRef.current;
    const stored = await readFromOPFS<string>(DEVICE_ID_KEY);
    deviceIdRef.current = stored ?? 'unknown-device';
    return deviceIdRef.current;
  }, []);

  /** Apply changes that arrived from another device. */
  const onSyncReceived = useCallback(
    async (changes: SyncChange<SyncableRow>[]) => {
      const adapter = getAdapter();
      if (!adapter || changes.length === 0) return;
      await applyIncomingChanges(adapter, await getDeviceId(), changes);
    },
    [getAdapter, getDeviceId]
  );

  /**
   * A peer asked for our data. peer.ts does not forward a timestamp, so this
   * is a full resync of the active profile.
   */
  const onSyncRequested = useCallback(async () => {
    const adapter = getAdapter();
    if (!adapter) return [];
    return collectLocalChanges(adapter, 0);
  }, [getAdapter]);

  return (
    <SyncProvider
      transports={addonSyncTransports}
      onSyncReceived={onSyncReceived}
      onSyncRequested={onSyncRequested}
    >
      <PushSweeper
        isReady={isReady}
        activeProfileId={activeProfileId}
        getAdapter={getAdapter}
      />
      {children}
    </SyncProvider>
  );
}

/**
 * Periodically queues locally-changed rows for outbound sync.
 *
 * Rendered inside SyncProvider so it can use useSync(); the bridge itself has
 * to render outside the provider it creates.
 */
function PushSweeper({
  isReady,
  activeProfileId,
  getAdapter,
}: {
  isReady: boolean;
  activeProfileId: string | null;
  getAdapter: () => ReturnType<typeof createSyncAdapter> | null;
}) {
  const { queueChanges } = useSync();

  useEffect(() => {
    if (!isReady || !activeProfileId) return;

    let active = true;
    let running = false;

    const sweep = async () => {
      // Skip rather than queue: sweeps must not pile up behind a slow one.
      if (!active || running) return;
      running = true;
      // Captured before the query so nothing written during the sweep can
      // fall into the gap between what was read and where the cursor lands.
      const sweepStartedAt = Date.now();
      try {
        const adapter = getAdapter();
        // Null when no profile is bound yet, or when the user has switched to
        // a profile this device does not sync.
        if (!adapter) return;

        const profileId = adapter.getProfileId();
        const since = await loadPushCursor(profileId);
        const changes = await collectLocalChanges(adapter, since);
        if (!active) return;

        if (changes.length > 0) queueChanges(changes);
        await savePushCursor(profileId, nextPushCursor(sweepStartedAt, since));
      } catch (error) {
        console.warn('[sync] Push sweep failed:', error);
      } finally {
        running = false;
      }
    };

    void sweep();
    const timer = setInterval(() => void sweep(), PUSH_SWEEP_INTERVAL_MS);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [isReady, activeProfileId, getAdapter, queueChanges]);

  return null;
}
