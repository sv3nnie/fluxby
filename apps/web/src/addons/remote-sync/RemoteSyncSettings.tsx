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
import { deriveVaultKeys, serializeVaultKeys } from './crypto';
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
      toast.error('Server URL and vault label are both required');
      return;
    }
    if (!passphrase) {
      toast.error('Enter your vault passphrase');
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
        keys: await serializeVaultKeys(keys),
      };

      await saveRemoteSyncConfig(next);
      setConfig(next);
      // Drop the passphrase from component state as soon as it is consumed.
      setPassphrase('');

      await remoteSyncTransport.reconfigure(next);
      const result = remoteSyncTransport.getStatus();
      setStatus(result);

      if (result.state === 'connected') {
        toast.success('Connected to remote sync server');
      } else {
        toast.error(result.lastError ?? 'Could not reach the sync server');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to connect');
    } finally {
      setIsConnecting(false);
    }
  }, [config, passphrase, toast]);

  const handleDisconnect = useCallback(async () => {
    await clearRemoteSyncConfig();
    const next = { ...DEFAULT_REMOTE_SYNC_CONFIG };
    setConfig(next);
    setPassphrase('');
    await remoteSyncTransport.reconfigure(next);
    setStatus(remoteSyncTransport.getStatus());
    toast.success('Disconnected from remote sync');
  }, [toast]);

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
        Loading remote sync settings...
      </div>
    );
  }

  const isSetUp = Boolean(config.keys);

  return (
    <div className='space-y-6'>
      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2'>
            <Cloud className='h-5 w-5' />
            Remote Sync
          </CardTitle>
          <CardDescription>
            Sync this device with a remote server. Everything is encrypted on
            this device first, so the server only ever stores unreadable blobs.
          </CardDescription>
        </CardHeader>

        <CardContent className='space-y-4'>
          <div className='space-y-2'>
            <Label htmlFor='remote-sync-url'>Server URL</Label>
            <Input
              id='remote-sync-url'
              placeholder='https://sync.example.com'
              value={config.serverUrl}
              disabled={isSetUp}
              onChange={(e) =>
                setConfig({ ...config, serverUrl: e.target.value })
              }
            />
          </div>

          <div className='space-y-2'>
            <Label htmlFor='remote-sync-label'>Vault label</Label>
            <Input
              id='remote-sync-label'
              placeholder='e.g. your email address'
              value={config.vaultLabel}
              disabled={isSetUp}
              onChange={(e) =>
                setConfig({ ...config, vaultLabel: e.target.value })
              }
            />
            <p className='text-xs text-muted-foreground'>
              Used to salt your encryption key. Every device on this vault must
              use exactly the same label.
            </p>
          </div>

          {!isSetUp && (
            <div className='space-y-2'>
              <Label htmlFor='remote-sync-passphrase'>Vault passphrase</Label>
              <Input
                id='remote-sync-passphrase'
                type='password'
                autoComplete='new-password'
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
              <p className='flex items-start gap-1.5 text-xs text-muted-foreground'>
                <TriangleAlert className='mt-0.5 h-3.5 w-3.5 shrink-0' />
                <span>
                  This passphrase never leaves your device and cannot be reset.
                  If you lose it, the data on the server is unrecoverable.
                </span>
              </p>
            </div>
          )}

          <div className='flex flex-wrap items-center gap-2'>
            {!isSetUp ? (
              <Button onClick={handleConnect} disabled={isConnecting}>
                {isConnecting && (
                  <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                )}
                {isConnecting ? 'Deriving keys...' : 'Connect'}
              </Button>
            ) : (
              <Button variant='destructive' onClick={handleDisconnect}>
                Disconnect
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {isSetUp && (
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>Status</CardTitle>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='flex items-center justify-between'>
              <div>
                <p className='text-sm font-medium'>Sync enabled</p>
                <p className='text-xs text-muted-foreground'>
                  Pause without losing your keys or server settings.
                </p>
              </div>
              <Switch
                checked={config.enabled}
                onCheckedChange={handleToggleEnabled}
              />
            </div>

            <div className='flex items-center gap-2 text-sm'>
              <ShieldCheck className='h-4 w-4 text-muted-foreground' />
              <span className='text-muted-foreground'>Connection:</span>
              <span className='font-medium'>{status.state}</span>
            </div>

            {status.lastError && (
              <p className='text-sm text-destructive'>{status.lastError}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
