/**
 * The single RemoteSyncTransport for this app instance.
 *
 * Lives in its own module so the settings UI can reach the live transport
 * without importing the add-on manifest (which imports the settings UI).
 */

import { createRemoteSyncTransport } from './transport';

export const remoteSyncTransport = createRemoteSyncTransport();
