import { describe, it, expect, beforeAll } from 'vitest';
import {
  deriveVaultKeys,
  serializeVaultKeys,
  deserializeVaultKeys,
  encryptPayload,
  decryptPayload,
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

describe('vault key serialization', () => {
  it('round-trips through storage and still decrypts', async () => {
    const payload = await encryptPayload(keys, { hello: 'world' });

    const stored = await serializeVaultKeys(keys);
    const restored = await deserializeVaultKeys(stored);

    expect(restored.vaultId).toBe(keys.vaultId);
    expect(await decryptPayload(restored, payload)).toEqual({ hello: 'world' });
  });

  it('stores the key material without the passphrase', async () => {
    const stored = await serializeVaultKeys(keys);
    expect(JSON.stringify(stored)).not.toContain('correct horse');
    expect(stored.version).toBe(1);
  });
});
