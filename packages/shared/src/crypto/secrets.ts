import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { ENCRYPTION_KEY_BYTES } from '../config/schema.js';

/**
 * AES-256-GCM encryption for `secret_items` (F8.2, storage contract TDS 03 §3.13).
 *
 * The storage contract is pinned so the Backend and both workers agree byte-for-byte:
 *   - `ciphertext` = GCM ciphertext with the 16-byte auth tag APPENDED
 *   - `nonce`      = 12 random bytes, unique per encryption operation, never reused
 *   - AAD          = the UTF-8 string `"{category}/{key}"`, binding a ciphertext to its
 *                    row so ciphertexts cannot be swapped between rows undetected
 *   - `keyVersion` = KEK rotation marker; V1 writes 1
 *
 * No plaintext ever leaves this module in a form intended for storage or logging.
 */

export const AES_GCM_NONCE_BYTES = 12;
export const AES_GCM_TAG_BYTES = 16;
export const CURRENT_KEY_VERSION = 1;

const ALGORITHM = 'aes-256-gcm';

/** The three columns of a `secret_items` row that carry the sealed value. */
export interface SealedSecret {
  /** GCM ciphertext || 16-byte auth tag. */
  readonly ciphertext: Buffer;
  /** 12-byte IV. */
  readonly nonce: Buffer;
  readonly keyVersion: number;
}

/** Identifies the row; becomes the AAD. Matches `secret_items(category, key)`. */
export interface SecretRef {
  readonly category: string;
  readonly key: string;
}

export class CryptoError extends Error {
  readonly code: 'INVALID_ENCRYPTION_KEY' | 'INVALID_PLAINTEXT' | 'DECRYPTION_FAILED';

  constructor(code: CryptoError['code'], message: string) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
  }
}

/** Decode `MC_ENCRYPTION_KEY` (base64) into the raw 32-byte key. */
export function decodeEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.byteLength !== ENCRYPTION_KEY_BYTES) {
    throw new CryptoError(
      'INVALID_ENCRYPTION_KEY',
      `MC_ENCRYPTION_KEY must decode to exactly ${ENCRYPTION_KEY_BYTES} bytes, got ${key.byteLength}`,
    );
  }
  return key;
}

/** AAD is `"{category}/{key}"` — a convention, not a stored column (TDS 03 §3.13). */
export function secretAad(ref: SecretRef): Buffer {
  return Buffer.from(`${ref.category}/${ref.key}`, 'utf8');
}

export function encryptSecret(
  plaintext: string,
  ref: SecretRef,
  key: Buffer,
  keyVersion: number = CURRENT_KEY_VERSION,
): SealedSecret {
  assertKeyLength(key);

  // An empty plaintext seals to exactly the 16-byte auth tag, which the storage contract
  // forbids: `secret_items.ciphertext` carries CHECK (octet_length(ciphertext) > 16)
  // (TDS 03 §3.13). Clearing a secret is a DELETE, not an encryption of "".
  if (plaintext.length === 0) {
    throw new CryptoError(
      'INVALID_PLAINTEXT',
      'Refusing to seal an empty secret — clearing a secret deletes the row (TDS 03 §3.13)',
    );
  }

  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: AES_GCM_TAG_BYTES });
  cipher.setAAD(secretAad(ref));

  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Object.freeze({
    ciphertext: Buffer.concat([body, tag]),
    nonce,
    keyVersion,
  });
}

export function decryptSecret(sealed: SealedSecret, ref: SecretRef, key: Buffer): string {
  assertKeyLength(key);

  if (sealed.nonce.byteLength !== AES_GCM_NONCE_BYTES) {
    throw new CryptoError(
      'DECRYPTION_FAILED',
      `nonce must be ${AES_GCM_NONCE_BYTES} bytes, got ${sealed.nonce.byteLength}`,
    );
  }
  if (sealed.ciphertext.byteLength <= AES_GCM_TAG_BYTES) {
    throw new CryptoError(
      'DECRYPTION_FAILED',
      'ciphertext must be longer than the appended 16-byte auth tag',
    );
  }

  const split = sealed.ciphertext.byteLength - AES_GCM_TAG_BYTES;
  const body = sealed.ciphertext.subarray(0, split);
  const tag = sealed.ciphertext.subarray(split);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, sealed.nonce, {
      authTagLength: AES_GCM_TAG_BYTES,
    });
    decipher.setAAD(secretAad(ref));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // Never echo ciphertext, key material, or the underlying OpenSSL detail.
    throw new CryptoError(
      'DECRYPTION_FAILED',
      `Could not decrypt secret ${ref.category}/${ref.key}: authentication failed ` +
        '(wrong key, wrong category/key binding, or tampered ciphertext)',
    );
  }
}

function assertKeyLength(key: Buffer): void {
  if (key.byteLength !== ENCRYPTION_KEY_BYTES) {
    throw new CryptoError(
      'INVALID_ENCRYPTION_KEY',
      `encryption key must be ${ENCRYPTION_KEY_BYTES} bytes, got ${key.byteLength}`,
    );
  }
}

/** Constant-time comparison helper for hashed tokens (F5.5). */
export function safeEquals(a: Buffer, b: Buffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}
