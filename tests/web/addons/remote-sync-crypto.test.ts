import { describe, it, expect, beforeAll } from 'vitest';
import {
  deriveVaultKeys,
  serializeVaultKeys,
  deserializeVaultKeys,
  encryptPayload,
  decryptPayload,
  isWrapped,
  type VaultKeys,
} from '@/addons/remote-sync/crypto';

// Key derivation is deliberately expensive (600k PBKDF2 rounds), so derive
// once and share across assertions.
let keys: VaultKeys;

beforeAll(async () => {
  keys = await deriveVaultKeys(
    'correct horse battery staple',
    'sven@example.com'
  );
}, 30_000);

describe('deriveVaultKeys', () => {
  it('is deterministic for the same passphrase and label', async () => {
    const again = await deriveVaultKeys(
      'correct horse battery staple',
      'sven@example.com'
    );
    // Two devices with the same credentials must land on the same vault.
    expect(again.vaultId).toBe(keys.vaultId);
  });

  it('normalises the label so casing and padding do not fork the vault', async () => {
    const padded = await deriveVaultKeys(
      'correct horse battery staple',
      '  SVEN@Example.com  '
    );
    expect(padded.vaultId).toBe(keys.vaultId);
  });

  it('produces a different vault for a different label', async () => {
    const other = await deriveVaultKeys(
      'correct horse battery staple',
      'someone-else@example.com'
    );
    expect(other.vaultId).not.toBe(keys.vaultId);
  });

  it('produces a different vault for a different passphrase', async () => {
    const other = await deriveVaultKeys(
      'a different passphrase',
      'sven@example.com'
    );
    expect(other.vaultId).not.toBe(keys.vaultId);
  });

  it('rejects an empty passphrase or label', async () => {
    await expect(deriveVaultKeys('', 'label')).rejects.toThrow(
      'Passphrase is required'
    );
    await expect(deriveVaultKeys('pass', '   ')).rejects.toThrow(
      'Vault label is required'
    );
  });

  it('derives a vault id that leaks neither passphrase nor label', () => {
    expect(keys.vaultId).toMatch(/^[0-9a-f]{32}$/);
    expect(keys.vaultId).not.toContain('sven');
  });
});

describe('encryptPayload / decryptPayload', () => {
  it('round-trips structured data', async () => {
    const value = {
      version: 1,
      changes: [
        { table: 'transactions', row: { id: 'a', amount: -42.5 } },
        { table: 'accounts', row: { id: 'b', name: 'Checking' } },
      ],
    };

    const payload = await encryptPayload(keys, value);
    expect(await decryptPayload(keys, payload)).toEqual(value);
  });

  it('never emits plaintext in the payload', async () => {
    const payload = await encryptPayload(keys, {
      merchant: 'VERY_SECRET_MERCHANT',
    });
    // Payload is base64; the marker must not survive in any readable form.
    expect(payload).not.toContain('VERY_SECRET_MERCHANT');
    expect(atob(payload)).not.toContain('VERY_SECRET_MERCHANT');
  });

  it('uses a fresh nonce so identical input yields different ciphertext', async () => {
    const a = await encryptPayload(keys, { same: 'value' });
    const b = await encryptPayload(keys, { same: 'value' });
    expect(a).not.toBe(b);
    expect(await decryptPayload(keys, b)).toEqual({ same: 'value' });
  });

  it('fails to decrypt under a different passphrase', async () => {
    const payload = await encryptPayload(keys, { secret: true });
    const wrong = await deriveVaultKeys('wrong passphrase', 'sven@example.com');
    await expect(decryptPayload(wrong, payload)).rejects.toThrow();
  }, 30_000);

  it('rejects a tampered payload', async () => {
    const payload = await encryptPayload(keys, { secret: true });
    const bytes = atob(payload).split('');
    // Flip a bit in the ciphertext; GCM's auth tag must catch it.
    const target = bytes.length - 5;
    bytes[target] = String.fromCharCode(bytes[target].charCodeAt(0) ^ 0x01);
    const tampered = btoa(bytes.join(''));

    await expect(decryptPayload(keys, tampered)).rejects.toThrow();
  });

  it('rejects a truncated payload', async () => {
    await expect(decryptPayload(keys, btoa('short'))).rejects.toThrow(
      'too short'
    );
  });
});

describe('auth token', () => {
  it('is deterministic for the same credentials', async () => {
    const again = await deriveVaultKeys(
      'correct horse battery staple',
      'sven@example.com'
    );
    expect(again.authToken).toBe(keys.authToken);
    expect(keys.authToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of the encryption key and vault id', async () => {
    const raw = await crypto.subtle.exportKey('raw', keys.encKey);
    const encKeyHex = [...new Uint8Array(raw)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Disclosing the token to the server must not reveal anything else.
    expect(keys.authToken).not.toBe(encKeyHex);
    expect(keys.authToken).not.toContain(keys.vaultId);
    expect(encKeyHex).not.toContain(keys.authToken);
  });

  it('differs for a different passphrase', async () => {
    const other = await deriveVaultKeys(
      'another passphrase',
      'sven@example.com'
    );
    expect(other.authToken).not.toBe(keys.authToken);
  });
});

describe('vault key serialization', () => {
  it('round-trips unwrapped when no app password is set', async () => {
    const payload = await encryptPayload(keys, { hello: 'world' });

    const stored = await serializeVaultKeys(keys);
    expect(stored.version).toBe(1);
    expect(isWrapped(stored)).toBe(false);

    const restored = await deserializeVaultKeys(stored);
    expect(restored.vaultId).toBe(keys.vaultId);
    expect(restored.authToken).toBe(keys.authToken);
    expect(await decryptPayload(restored, payload)).toEqual({ hello: 'world' });
  });

  it('stores the key material without the passphrase', async () => {
    const stored = await serializeVaultKeys(keys);
    expect(JSON.stringify(stored)).not.toContain('correct horse');
  });

  it('wraps the key when an app encryption key is supplied', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    const stored = await serializeVaultKeys(keys, masterKey);

    expect(stored.version).toBe(2);
    expect(isWrapped(stored)).toBe(true);
    // The raw key must not be recoverable from storage alone. This matters on
    // Tauri, where settings fall back to base64 in localStorage.
    expect(stored.encKeyRaw).toBeUndefined();

    const raw = new Uint8Array(
      await crypto.subtle.exportKey('raw', keys.encKey)
    );
    expect(stored.wrapped).toBeDefined();
    expect(atob(stored.wrapped ?? '')).not.toContain(
      String.fromCharCode(...raw)
    );
  });

  it('unwraps and still decrypts with the right app key', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    const payload = await encryptPayload(keys, { hello: 'wrapped' });

    const stored = await serializeVaultKeys(keys, masterKey);
    const restored = await deserializeVaultKeys(stored, masterKey);

    expect(restored.vaultId).toBe(keys.vaultId);
    expect(await decryptPayload(restored, payload)).toEqual({
      hello: 'wrapped',
    });
  });

  it('refuses to unwrap without the app key, as when the app is locked', async () => {
    const masterKey = crypto.getRandomValues(new Uint8Array(32));
    const stored = await serializeVaultKeys(keys, masterKey);

    await expect(deserializeVaultKeys(stored)).rejects.toThrow('locked');
    await expect(
      deserializeVaultKeys(stored, new Uint8Array(0))
    ).rejects.toThrow('locked');
  });

  it('fails to unwrap with the wrong app key', async () => {
    const stored = await serializeVaultKeys(
      keys,
      crypto.getRandomValues(new Uint8Array(32))
    );
    await expect(
      deserializeVaultKeys(stored, crypto.getRandomValues(new Uint8Array(32)))
    ).rejects.toThrow();
  });

  it('still reads legacy v1 records written before wrapping existed', async () => {
    const payload = await encryptPayload(keys, { legacy: true });
    const legacy = await serializeVaultKeys(keys);

    const restored = await deserializeVaultKeys(legacy, null);
    expect(await decryptPayload(restored, payload)).toEqual({ legacy: true });
  });
});
