import type { Buffer } from 'node:buffer';
import {
  CryptoError,
  CURRENT_KEY_VERSION,
  decodeEncryptionKey,
  decryptSecret,
  encryptSecret,
  type SealedSecret,
  type SettingsCategory,
} from '@mc/shared';
import { ApiError } from '../http/errors.js';

/**
 * The one place in the Backend that seals and unseals `secret_items` (TDS 03 §3.13, F8.2).
 *
 * AES-256-GCM under `MC_ENCRYPTION_KEY`, per-row 12-byte nonce, AAD `"{category}/{key}"`. The
 * crypto itself lives in `@mc/shared` so the workers agree byte-for-byte; what lives here is
 * the *policy*:
 *
 *  - **Plaintext never leaves this module except to the one caller that must have it** — Test
 *    Connection, which sends it to the integration it belongs to and nowhere else. There is no
 *    read path from HTTP to a plaintext secret, and no logging in this file.
 *  - **A secret that cannot be decrypted fails loudly and specifically.** The realistic cause
 *    is a restored database paired with a different `MC_ENCRYPTION_KEY` — the exact scenario
 *    the CLAUDE.md warning about backing the key up out-of-band describes. A generic 500 would
 *    tell the operator nothing; `SecretUnreadableError` names the category, the key and the
 *    `key_version`, and the Test Connection layer turns it into a result the operator can act
 *    on ("re-enter the token").
 *  - **Clearing a secret is a DELETE**, never an encryption of `""`: `encryptSecret` refuses
 *    an empty plaintext because `ck_secret_items_ciphertext` requires more than the 16-byte
 *    auth tag.
 */

export interface SecretRow {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly keyVersion: number;
}

export interface SecretCoordinate {
  readonly category: SettingsCategory;
  readonly key: string;
}

/** A stored secret exists but this process cannot read it. Never carries ciphertext. */
export class SecretUnreadableError extends Error {
  readonly category: string;
  readonly key: string;
  readonly keyVersion: number;

  constructor(ref: SecretCoordinate, keyVersion: number, reason: string) {
    super(
      `Stored secret ${ref.category}/${ref.key} could not be decrypted (${reason}). ` +
        'It was sealed with a different MC_ENCRYPTION_KEY, or the row was tampered with. ' +
        'Re-enter the value in Settings to re-seal it with the current key.',
    );
    this.name = 'SecretUnreadableError';
    this.category = ref.category;
    this.key = ref.key;
    this.keyVersion = keyVersion;
  }
}

export interface SecretVaultOptions {
  /**
   * Base64 `MC_ENCRYPTION_KEY`. `null` means this process was built without bootstrap config
   * (only possible in a test app); secret *writes* then fail with a stated reason instead of
   * silently storing nothing.
   */
  readonly encryptionKey: string | null;
}

export class SecretVault {
  readonly #key: Buffer | null;
  readonly #keyError: string | null;

  constructor(options: SecretVaultOptions) {
    if (options.encryptionKey === null) {
      this.#key = null;
      this.#keyError = 'MC_ENCRYPTION_KEY is not configured in this process';
      return;
    }
    try {
      this.#key = decodeEncryptionKey(options.encryptionKey);
      this.#keyError = null;
    } catch (error) {
      // Unreachable through `loadConfig`, which validates the key length — but a vault that
      // pretends to work and writes nothing is worse than one that says why on first use.
      this.#key = null;
      this.#keyError =
        error instanceof CryptoError ? error.message : 'MC_ENCRYPTION_KEY is invalid';
    }
  }

  get available(): boolean {
    return this.#key !== null;
  }

  seal(ref: SecretCoordinate, plaintext: string): SealedSecret {
    return encryptSecret(plaintext, ref, this.#require(), CURRENT_KEY_VERSION);
  }

  /**
   * @throws {SecretUnreadableError} when the row cannot be authenticated under the current key.
   */
  open(ref: SecretCoordinate, row: SecretRow): string {
    const key = this.#require();

    if (row.keyVersion !== CURRENT_KEY_VERSION) {
      // `key_version` exists so KEK rotation is a job rather than a migration (TDS 03 §3.13).
      // Until that job exists, a row from another version is unreadable *and says so* — which
      // is the difference between a 30-second fix and an afternoon.
      throw new SecretUnreadableError(
        ref,
        row.keyVersion,
        `stored under key_version ${row.keyVersion}, this process holds ${CURRENT_KEY_VERSION}`,
      );
    }

    try {
      return decryptSecret(
        { ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion },
        ref,
        key,
      );
    } catch (error) {
      throw new SecretUnreadableError(
        ref,
        row.keyVersion,
        error instanceof CryptoError ? 'authentication failed' : 'unreadable',
      );
    }
  }

  #require(): Buffer {
    if (this.#key === null) {
      throw new ApiError(
        'INTERNAL',
        `Cannot store or read a secret: ${this.#keyError ?? 'no encryption key'}`,
      );
    }
    return this.#key;
  }
}
