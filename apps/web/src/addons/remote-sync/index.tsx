/**
 * Remote Sync add-on
 *
 * Adds an encrypted server-backed sync channel next to Fluxby's built-in
 * device-to-device sync. Both run at once: a change queued locally is pushed
 * over every transport, and changes arriving from either are merged by the
 * existing Last-Write-Wins logic.
 */

import type { FluxbyAddon } from '../types';
import { RemoteSyncSettings } from './RemoteSyncSettings';
import { RemoteSyncProvider } from './RemoteSyncProvider';
import { remoteSyncTransport } from './instance';

export const remoteSyncAddon: FluxbyAddon = {
  id: 'remote-sync',
  name: 'Remote Sync',
  description: 'End-to-end encrypted sync with a remote server you control.',
  Provider: RemoteSyncProvider,
  settingsTabs: [
    {
      id: 'remote-sync',
      label: 'Remote Sync',
      element: <RemoteSyncSettings />,
    },
  ],
  createSyncTransports: () => [remoteSyncTransport],
};

export { remoteSyncTransport };
