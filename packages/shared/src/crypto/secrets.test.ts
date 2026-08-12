import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AES_GCM_NONCE_BYTES,
  AES_GCM_TAG_BYTES,
  CryptoError,
  CURRENT_KEY_VERSION,
  decodeEncryptionKey,
  decryptSecret,
  encryptSecret,
  type SealedSecret,
} from './secrets.js';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const REF = { category: 'integrations', key: 'github_token' } as const;

/** Flip one bit in a copy of `buffer` at `index`. */
function tamper(buffer: Buffer, index: number): Buffer {
  const copy = Buffer.from(buffer);
  const current = copy[index];
  if (current === undefined) throw new Error(`index ${index} out of range`);
  copy[index] = current ^ 0b0000_0001;
  return copy;
}

describe('AES-256-GCM secret sealing (TDS 03 §3.13)', () => {
  it('round-trips a value', () => {
    const sealed = encryptSecret('ghp_supersecrettoken', REF, KEY);
    expect(decryptSecret(sealed, REF, KEY)).toBe('ghp_supersecrettoken');
  });

  it('round-trips unicode and long values', () => {
    for (const plaintext of ['a', 'ünïcödé — ✓ 中文', 'x'.repeat(8192)]) {
      const sealed = encryptSecret(plaintext, REF, KEY);
      expect(decryptSecret(sealed, REF, KEY)).toBe(plaintext);
    }
  });

  it('refuses to seal an empty secret — the storage contract forbids it', () => {
    // secret_items.ciphertext has CHECK (octet_length(ciphertext) > 16), and an empty
    // plaintext seals to exactly the 16-byte tag. Clearing a secret deletes the row.
    try {
      encryptSecret('', REF, KEY);
      expect.unreachable('encryptSecret should have thrown');
    } catch (error) {
      expect((error as CryptoError).code).toBe('INVALID_PLAINTEXT');
    }
  });

  it('produces the pinned storage layout: 12-byte nonce, ciphertext || 16-byte tag', () => {
    const plaintext = 'abcdefghij';
    const sealed = encryptSecret(plaintext, REF, KEY);

    expect(sealed.nonce.byteLength).toBe(AES_GCM_NONCE_BYTES);
    expect(sealed.ciphertext.byteLength).toBe(
      Buffer.byteLength(plaintext, 'utf8') + AES_GCM_TAG_BYTES,
    );
    expect(sealed.keyVersion).toBe(CURRENT_KEY_VERSION);
  });

  it('is non-deterministic: a unique nonce per encryption', () => {
    const a = encryptSecret('same value', REF, KEY);
    const b = encryptSecret('same value', REF, KEY);

    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(decryptSecret(a, REF, KEY)).toBe(decryptSecret(b, REF, KEY));
  });

  it('round-trips the key version so rotation is a job, not a migration', () => {
    const sealed = encryptSecret('value', REF, KEY, 7);
    expect(sealed.keyVersion).toBe(7);
    expect(decryptSecret(sealed, REF, KEY)).toBe('value');
  });

  it('detects a tampered ciphertext byte', () => {
    const sealed = encryptSecret('tamper me please', REF, KEY);
    const attacked: SealedSecret = { ...sealed, ciphertext: tamper(sealed.ciphertext, 0) };
    expect(() => decryptSecret(attacked, REF, KEY)).toThrowError(CryptoError);
  });

  it('detects a tampered auth tag byte', () => {
    const sealed = encryptSecret('tamper me please', REF, KEY);
    const tagIndex = sealed.ciphertext.byteLength - 1;
    const attacked: SealedSecret = {
      ...sealed,
      ciphertext: tamper(sealed.ciphertext, tagIndex),
    };
    expect(() => decryptSecret(attacked, REF, KEY)).toThrowError(CryptoError);
  });

  it('detects a tampered nonce byte', () => {
    const sealed = encryptSecret('tamper me please', REF, KEY);
    const attacked: SealedSecret = { ...sealed, nonce: tamper(sealed.nonce, 0) };
    expect(() => decryptSecret(attacked, REF, KEY)).toThrowError(CryptoError);
  });

  it('refuses a ciphertext resealed under a different category/key (AAD binding)', () => {
    const sealed = encryptSecret('ghp_token', REF, KEY);
    expect(() =>
      decryptSecret(sealed, { category: 'integrations', key: 'telegram_bot_token' }, KEY),
    ).toThrowError(CryptoError);
  });

  it('refuses the wrong key', () => {
    const sealed = encryptSecret('ghp_token', REF, KEY);
    expect(() => decryptSecret(sealed, REF, OTHER_KEY)).toThrowError(CryptoError);
  });

  it('never leaks plaintext or key material in the failure message', () => {
    const sealed = encryptSecret('ghp_THE_SECRET_VALUE', REF, KEY);
    try {
      decryptSecret(sealed, REF, OTHER_KEY);
      expect.unreachable('decryptSecret should have thrown');
    } catch (error) {
      const message = (error as CryptoError).message;
      expect(message).not.toContain('THE_SECRET_VALUE');
      expect(message).not.toContain(KEY.toString('base64'));
      expect((error as CryptoError).code).toBe('DECRYPTION_FAILED');
    }
  });

  it('rejects malformed sealed rows without reaching OpenSSL', () => {
    const sealed = encryptSecret('value', REF, KEY);
    expect(() => decryptSecret({ ...sealed, nonce: randomBytes(8) }, REF, KEY)).toThrowError(
      /nonce must be 12 bytes/,
    );
    expect(() =>
      decryptSecret({ ...sealed, ciphertext: randomBytes(AES_GCM_TAG_BYTES) }, REF, KEY),
    ).toThrowError(/longer than the appended 16-byte auth tag/);
  });
});

describe('decodeEncryptionKey', () => {
  it('decodes a valid 32-byte base64 key', () => {
    expect(decodeEncryptionKey(KEY.toString('base64')).equals(KEY)).toBe(true);
  });

  it('rejects a key of the wrong length with a named error', () => {
    try {
      decodeEncryptionKey(randomBytes(16).toString('base64'));
      expect.unreachable('decodeEncryptionKey should have thrown');
    } catch (error) {
      expect((error as CryptoError).code).toBe('INVALID_ENCRYPTION_KEY');
      expect((error as CryptoError).message).toContain('MC_ENCRYPTION_KEY');
    }
  });
});
