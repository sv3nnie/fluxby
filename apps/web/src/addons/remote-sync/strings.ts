/**
 * Remote Sync copy.
 *
 * Kept add-on local rather than added to lib/i18n/en.ts and nl.ts: those files
 * change often upstream and editing them would put this add-on directly in the
 * path of every merge.
 */

import type { Language } from '@/lib/i18n';

export interface RemoteSyncStrings {
  title: string;
  description: string;
  serverUrl: string;
  serverUrlPlaceholder: string;
  vaultLabel: string;
  vaultLabelPlaceholder: string;
  vaultLabelHint: string;
  passphrase: string;
  passphraseWarning: string;
  profileNotice: (profileName: string) => string;
  connect: string;
  connecting: string;
  disconnect: string;
  status: string;
  connection: string;
  syncEnabled: string;
  syncEnabledHint: string;
  loading: string;
  errServerAndLabel: string;
  errPassphrase: string;
  errNoProfile: string;
  okConnected: string;
  okDisconnected: string;
  errUnreachable: string;
  errGeneric: string;
  lockedNotice: string;
  rotationWarning: string;
}

const en: RemoteSyncStrings = {
  title: 'Remote Sync',
  description:
    'Sync this device with a remote server. Everything is encrypted on this device first, so the server only ever stores unreadable blobs.',
  serverUrl: 'Server URL',
  serverUrlPlaceholder: 'https://sync.example.com',
  vaultLabel: 'Vault label',
  vaultLabelPlaceholder: 'e.g. your email address',
  vaultLabelHint:
    'Used to salt your encryption key. Every device on this vault must use exactly the same label.',
  passphrase: 'Vault passphrase',
  passphraseWarning:
    'This passphrase never leaves your device and cannot be reset. If you lose it, the data on the server is unrecoverable.',
  profileNotice: (profileName) =>
    `This vault will sync the "${profileName}" profile. Sync stays bound to it, so switching profiles later will not mix their data.`,
  connect: 'Connect',
  connecting: 'Deriving keys...',
  disconnect: 'Disconnect',
  status: 'Status',
  connection: 'Connection',
  syncEnabled: 'Sync enabled',
  syncEnabledHint: 'Pause without losing your keys or server settings.',
  loading: 'Loading remote sync settings...',
  errServerAndLabel: 'Server URL and vault label are both required',
  errPassphrase: 'Enter your vault passphrase',
  errNoProfile: 'Select a profile before connecting',
  okConnected: 'Connected to remote sync server',
  okDisconnected: 'Disconnected from remote sync',
  errUnreachable: 'Could not reach the sync server',
  errGeneric: 'Failed to connect',
  lockedNotice:
    'Your sync key is protected by your app password. Remote sync resumes when you unlock the app.',
  rotationWarning:
    'Changing the passphrase or label creates a different vault. Data already on the server stays under the old one and will not be migrated.',
};

const nl: RemoteSyncStrings = {
  title: 'Externe synchronisatie',
  description:
    'Synchroniseer dit apparaat met een externe server. Alles wordt eerst op dit apparaat versleuteld, dus de server bewaart alleen onleesbare gegevens.',
  serverUrl: 'Server-URL',
  serverUrlPlaceholder: 'https://sync.example.com',
  vaultLabel: 'Kluislabel',
  vaultLabelPlaceholder: 'bijv. je e-mailadres',
  vaultLabelHint:
    'Wordt gebruikt om je sleutel te salten. Elk apparaat in deze kluis moet exact hetzelfde label gebruiken.',
  passphrase: 'Kluiswachtwoord',
  passphraseWarning:
    'Dit wachtwoord verlaat je apparaat nooit en kan niet worden hersteld. Ben je het kwijt, dan zijn de gegevens op de server onherstelbaar.',
  profileNotice: (profileName) =>
    `Deze kluis synchroniseert het profiel "${profileName}". De koppeling blijft vast, dus later wisselen van profiel vermengt de gegevens niet.`,
  connect: 'Verbinden',
  connecting: 'Sleutels afleiden...',
  disconnect: 'Verbreken',
  status: 'Status',
  connection: 'Verbinding',
  syncEnabled: 'Synchronisatie aan',
  syncEnabledHint:
    'Pauzeer zonder je sleutels of serverinstellingen te verliezen.',
  loading: 'Instellingen laden...',
  errServerAndLabel: 'Server-URL en kluislabel zijn allebei verplicht',
  errPassphrase: 'Voer je kluiswachtwoord in',
  errNoProfile: 'Kies een profiel voordat je verbindt',
  okConnected: 'Verbonden met de synchronisatieserver',
  okDisconnected: 'Verbinding met externe synchronisatie verbroken',
  errUnreachable: 'Kan de synchronisatieserver niet bereiken',
  errGeneric: 'Verbinden mislukt',
  lockedNotice:
    'Je synchronisatiesleutel is beveiligd met je app-wachtwoord. Externe synchronisatie hervat zodra je de app ontgrendelt.',
  rotationWarning:
    'Een ander wachtwoord of label maakt een andere kluis aan. Gegevens die al op de server staan blijven onder de oude kluis en worden niet meegenomen.',
};

const STRINGS: Record<string, RemoteSyncStrings> = { en, nl };

export function remoteSyncStrings(
  language: Language | string
): RemoteSyncStrings {
  return STRINGS[language] ?? en;
}
