/**
 * Feeds the app's encryption key into the remote sync transport.
 *
 * Stored sync keys are wrapped with the app's own encryption key, so the
 * transport cannot read them until the app is unlocked. This provider watches
 * the lock state and reconnects or disconnects accordingly -- locking the app
 * therefore also stops remote sync.
 */

import { useEffect, type ReactNode } from 'react';
import { useEncryption } from '@/contexts/EncryptionContext';
import { remoteSyncTransport } from './instance';

export function RemoteSyncProvider({ children }: { children: ReactNode }) {
  const { encryptionKey, isUnlocked } = useEncryption();

  useEffect(() => {
    let cancelled = false;

    const key = isUnlocked ? encryptionKey : null;
    remoteSyncTransport.setMasterKey(key);

    // Re-run initialize so the transport picks up (or loses) the ability to
    // unwrap its stored keys.
    void remoteSyncTransport.reconfigure().catch((error) => {
      if (!cancelled) {
        console.warn(
          '[remote-sync] Reconfigure after lock change failed:',
          error
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [encryptionKey, isUnlocked]);

  return <>{children}</>;
}
