/**
 * Remote Sync encryption
 *
 * The server stores opaque blobs and never sees a key. Everything below runs
 * on the device.
 *
 * Why this is not `@fluxby/core`'s sync-encryption: that module uses ephemeral
 * ECDH per connection to get forward secrecy between two live peers. A server
 * stores batches at rest and hands them to a device that connects days later,
 * so the key has to be reproducible on every device that knows the passphrase.
 * Different requirement, different key model.
 *
 * Key derivation:
 *   salt      = SHA-256("fluxby-remote-sync:v1:" + vaultLabel)
 *   master    = PBKDF2-SHA256(passphrase, salt, 600_000)
 *   encKey    = HKDF(master, info="fluxby-remote-sync:enc")   -> AES-256-GCM
 *   vaultId   = HKDF(master, info="fluxby-remote-sync:vault") -> 32 hex chars
 *
 * The vault id is derived rather than chosen so two devices with the same
 * passphrase and label find the same vault without the server ever learning
 * either one.
 */

/** OWASP's current floor for PBKDF2-SHA256. */
export const PBKDF2_ITERATIONS = 600_000;

const NONCE_LENGTH = 12; // 96 bits, the GCM standard
const SALT_PREFIX = 'fluxby-remote-sync:v1:';
const ENC_INFO = 'fluxby-remote-sync:enc';
const VAULT_INFO = 'fluxby-remote-sync:vault';

export interface VaultKeys {
  /** AES-GCM key used for every batch payload */
  encKey: CryptoKey;
  /** Public, server-visible vault identifier */
  vaultId: string;
}

/** Raw key material, safe to persist locally alongside the local database. */
export interface SerializedVaultKeys {
  version: 1;
  vaultId: string;
  /** Base64 raw AES key bytes */
  encKeyRaw: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// Explicitly ArrayBuffer-backed: WebCrypto's BufferSource rejects the
// SharedArrayBuffer-compatible default that a bare `Uint8Array` implies.
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive the per-vault salt from a user-chosen label.
 *
 * Using the label rather than a single global constant means a passphrase
 * cannot be attacked across every Fluxby user at once.
 */
async function deriveSalt(vaultLabel: string): Promise<ArrayBuffer> {
  const normalized = vaultLabel.trim().toLowerCase();
  return crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(SALT_PREFIX + normalized)
  );
}

/**
 * Turn a passphrase and vault label into the encryption key and vault id.
 * Deliberately slow -- run it once per session, not per request.
 */
export async function deriveVaultKeys(
  passphrase: string,
  vaultLabel: string
): Promise<VaultKeys> {
  if (!passphrase) throw new Error('Passphrase is required');
  if (!vaultLabel.trim()) throw new Error('Vault label is required');

  const salt = await deriveSalt(vaultLabel);

  const passphraseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const masterBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    passphraseKey,
    256
  );

  const master = await crypto.subtle.importKey(
    'raw',
    masterBits,
    'HKDF',
    false,
    ['deriveBits', 'deriveKey']
  );

  const encKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(ENC_INFO),
    },
    master,
    { name: 'AES-GCM', length: 256 },
    true, // extractable, so the key can be cached locally
    ['encrypt', 'decrypt']
  );

  const vaultIdBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(VAULT_INFO),
    },
    master,
    128
  );

  return { encKey, vaultId: toHex(new Uint8Array(vaultIdBits)) };
}

export async function serializeVaultKeys(
  keys: VaultKeys
): Promise<SerializedVaultKeys> {
  const raw = await crypto.subtle.exportKey('raw', keys.encKey);
  return {
    version: 1,
    vaultId: keys.vaultId,
    encKeyRaw: toBase64(new Uint8Array(raw)),
  };
}

export async function deserializeVaultKeys(
  stored: SerializedVaultKeys
): Promise<VaultKeys> {
  const encKey = await crypto.subtle.importKey(
    'raw',
    fromBase64(stored.encKeyRaw),
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  return { encKey, vaultId: stored.vaultId };
}

/**
 * Encrypt a batch. Output is base64(nonce || ciphertext), which is what gets
 * stored server-side.
 */
export async function encryptPayload(
  keys: VaultKeys,
  value: unknown
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    keys.encKey,
    plaintext
  );

  const combined = new Uint8Array(nonce.length + ciphertext.byteLength);
  combined.set(nonce, 0);
  combined.set(new Uint8Array(ciphertext), nonce.length);
  return toBase64(combined);
}

/**
 * Decrypt a batch produced by `encryptPayload`.
 * Throws if the payload was truncated, tampered with, or encrypted under a
 * different passphrase -- GCM authentication covers all three.
 */
export async function decryptPayload<T = unknown>(
  keys: VaultKeys,
  payload: string
): Promise<T> {
  const combined = fromBase64(payload);
  if (combined.length <= NONCE_LENGTH) {
    throw new Error('Encrypted payload is too short to be valid');
  }

  const nonce = combined.slice(0, NONCE_LENGTH);
  const ciphertext = combined.slice(NONCE_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    keys.encKey,
    ciphertext
  );

  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
