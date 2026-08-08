/**
 * Settings panel for the Remote Sync add-on.
 *
 * Deriving the vault keys is deliberately slow (600k PBKDF2 rounds), so it
 * happens once here on connect and the result is cached; it is never done per
 * request.
 */

import { useCallback, useEffect, useState } from 'react';
import { Cloud, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/contexts/ToastContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useProfile } from '@/contexts/ProfileContext';
import { useEncryption } from '@/contexts/EncryptionContext';
import { deriveVaultKeys, serializeVaultKeys } from './crypto';
import { remoteSyncStrings } from './strings';
import {
  DEFAULT_REMOTE_SYNC_CONFIG,
  clearRemoteSyncConfig,
  loadRemoteSyncConfig,
  saveRemoteSyncConfig,
  type RemoteSyncConfig,
} from './config';
import { remoteSyncTransport } from './instance';

export function RemoteSyncSettings() {
  const toast = useToast();
  const { language } = useLanguage();
  const { activeProfileId, profiles } = useProfile();
  const { encryptionKey, isUnlocked, isEncryptionEnabled } = useEncryption();
  const s = remoteSyncStrings(language);

  const [config, setConfig] = useState<RemoteSyncConfig>(
    DEFAULT_REMOTE_SYNC_CONFIG
  );
  const [passphrase, setPassphrase] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [status, setStatus] = useState(remoteSyncTransport.getStatus());

  useEffect(() => {
    let active = true;
    loadRemoteSyncConfig()
      .then((loaded) => {
        if (active) setConfig(loaded);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // The transport reports status through the sync host, not through React, so
  // poll it while this panel is open.
  useEffect(() => {
    const timer = setInterval(
      () => setStatus(remoteSyncTransport.getStatus()),
      1000
    );
    return () => clearInterval(timer);
  }, []);

  const handleConnect = useCallback(async () => {
    if (!config.serverUrl.trim() || !config.vaultLabel.trim()) {
      toast.error(s.errServerAndLabel);
      return;
    }
    if (!passphrase) {
      toast.error(s.errPassphrase);
      return;
    }
    // The vault is bound to one profile; without one there is nothing to sync.
    if (!activeProfileId) {
      toast.error(s.errNoProfile);
      return;
    }

    setIsConnecting(true);
    try {
      const keys = await deriveVaultKeys(passphrase, config.vaultLabel);
      const next: RemoteSyncConfig = {
        ...config,
        enabled: true,
        serverUrl: config.serverUrl.trim(),
        vaultLabel: config.vaultLabel.trim(),
        profileId: activeProfileId,
        // Wrapped with the app's encryption key when one exists, so the stored
        // key is unreadable while the app is locked.
        keys: await serializeVaultKeys(keys, isUnlocked ? encryptionKey : null),
      };

      await saveRemoteSyncConfig(next);
      setConfig(next);
      // Drop the passphrase from component state as soon as it is consumed.
      setPassphrase('');

      await remoteSyncTransport.reconfigure(next);
      const result = remoteSyncTransport.getStatus();
      setStatus(result);

      if (result.state === 'connected') {
        toast.success(s.okConnected);
      } else {
        toast.error(result.lastError ?? s.errUnreachable);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : s.errGeneric);
    } finally {
      setIsConnecting(false);
    }
  }, [
    config,
    passphrase,
    toast,
    s,
    activeProfileId,
    encryptionKey,
    isUnlocked,
  ]);

  const handleDisconnect = useCallback(async () => {
    await clearRemoteSyncConfig();
    const next = { ...DEFAULT_REMOTE_SYNC_CONFIG };
    setConfig(next);
    setPassphrase('');
    await remoteSyncTransport.reconfigure(next);
    setStatus(remoteSyncTransport.getStatus());
    toast.success(s.okDisconnected);
  }, [toast, s]);

  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      const next = { ...config, enabled };
      setConfig(next);
      await saveRemoteSyncConfig(next);
      await remoteSyncTransport.reconfigure(next);
      setStatus(remoteSyncTransport.getStatus());
    },
    [config]
  );

  if (isLoading) {
    return (
      <div className='flex items-center gap-2 p-6 text-muted-foreground'>
        <Loader2 className='h-4 w-4 animate-spin' />
        {s.loading}
      </div>
    );
  }

  const isSetUp = Boolean(config.keys);
  const boundProfile = profiles.find((p) => p.id === config.profileId);
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  // Wrapped keys cannot be read while the app is locked.
  const isKeyLocked = isSetUp && isEncryptionEnabled && !isUnlocked;

  return (
    <div className='space-y-6'>
      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2'>
            <Cloud className='h-5 w-5' />
            {s.title}
          </CardTitle>
          <CardDescription>{s.description}</CardDescription>
        </CardHeader>

        <CardContent className='space-y-4'>
          <div className='space-y-2'>
            <Label htmlFor='remote-sync-url'>{s.serverUrl}</Label>
            <Input
              id='remote-sync-url'
              placeholder={s.serverUrlPlaceholder}
              value={config.serverUrl}
              disabled={isSetUp}
              onChange={(e) =>
                setConfig({ ...config, serverUrl: e.target.value })
              }
            />
          </div>

          <div className='space-y-2'>
            <Label htmlFor='remote-sync-label'>{s.vaultLabel}</Label>
            <Input
              id='remote-sync-label'
              placeholder={s.vaultLabelPlaceholder}
              value={config.vaultLabel}
              disabled={isSetUp}
              onChange={(e) =>
                setConfig({ ...config, vaultLabel: e.target.value })
              }
            />
            <p className='text-xs text-muted-foreground'>{s.vaultLabelHint}</p>
          </div>

          {!isSetUp && (
            <>
              <div className='space-y-2'>
                <Label htmlFor='remote-sync-passphrase'>{s.passphrase}</Label>
                <Input
                  id='remote-sync-passphrase'
                  type='password'
                  autoComplete='new-password'
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
                <p className='flex items-start gap-1.5 text-xs text-muted-foreground'>
                  <TriangleAlert className='mt-0.5 h-3.5 w-3.5 shrink-0' />
                  <span>{s.passphraseWarning}</span>
                </p>
              </div>

              {activeProfile && (
                <p className='rounded-md bg-muted p-3 text-xs text-muted-foreground'>
                  {s.profileNotice(activeProfile.name)}
                </p>
              )}
            </>
          )}

          <div className='flex flex-wrap items-center gap-2'>
            {!isSetUp ? (
              <Button onClick={handleConnect} disabled={isConnecting}>
                {isConnecting && (
                  <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                )}
                {isConnecting ? s.connecting : s.connect}
              </Button>
            ) : (
              <Button variant='destructive' onClick={handleDisconnect}>
                {s.disconnect}
              </Button>
            )}
          </div>

          {isSetUp && (
            <p className='flex items-start gap-1.5 text-xs text-muted-foreground'>
              <TriangleAlert className='mt-0.5 h-3.5 w-3.5 shrink-0' />
              <span>{s.rotationWarning}</span>
            </p>
          )}
        </CardContent>
      </Card>

      {isSetUp && (
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>{s.status}</CardTitle>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='flex items-center justify-between'>
              <div>
                <p className='text-sm font-medium'>{s.syncEnabled}</p>
                <p className='text-xs text-muted-foreground'>
                  {s.syncEnabledHint}
                </p>
              </div>
              <Switch
                checked={config.enabled}
                onCheckedChange={handleToggleEnabled}
              />
            </div>

            {boundProfile && (
              <p className='text-xs text-muted-foreground'>
                {s.profileNotice(boundProfile.name)}
              </p>
            )}

            <div className='flex items-center gap-2 text-sm'>
              <ShieldCheck className='h-4 w-4 text-muted-foreground' />
              <span className='text-muted-foreground'>{s.connection}:</span>
              <span className='font-medium'>{status.state}</span>
            </div>

            {isKeyLocked ? (
              <p className='text-sm text-muted-foreground'>{s.lockedNotice}</p>
            ) : (
              status.lastError && (
                <p className='text-sm text-destructive'>{status.lastError}</p>
              )
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
