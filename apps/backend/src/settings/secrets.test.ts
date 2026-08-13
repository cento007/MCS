import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApiError } from '../http/errors.js';
import { SecretUnreadableError, SecretVault } from './secrets.js';

/**
 * The seal/unseal policy (TDS 03 §3.13, F8.2) — no database.
 *
 * The key is generated per run: there is no secret in this repository to leak, and a fixture
 * key in a test file is how one gets committed.
 */

const REF = { category: 'integrations', key: 'github_token' } as const;

function vault(): SecretVault {
  return new SecretVault({ encryptionKey: randomBytes(32).toString('base64') });
}

describe('SecretVault', () => {
  it('round-trips a secret', () => {
    const subject = vault();
    const sealed = subject.seal(REF, 'ghp_example_token');

    expect(subject.open(REF, sealed)).toBe('ghp_example_token');
  });

  it('produces a fresh nonce per operation, so identical secrets do not look identical', () => {
    const subject = vault();
    const first = subject.seal(REF, 'same-value');
    const second = subject.seal(REF, 'same-value');

    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it('binds a ciphertext to its (category, key) through the AAD', () => {
    // Without the binding, a `github_token` row could be moved to `telegram_bot_token` and
    // would decrypt cleanly — a stored-credential swap nothing would detect.
    const subject = vault();
    const sealed = subject.seal(REF, 'ghp_example_token');

    expect(() =>
      subject.open({ category: 'integrations', key: 'telegram_bot_token' }, sealed),
    ).toThrow(SecretUnreadableError);
  });

  it('refuses to seal an empty secret — clearing is a DELETE (TDS 03 §3.13)', () => {
    expect(() => vault().seal(REF, '')).toThrow(/empty secret/i);
  });

  it('fails loudly and specifically when the key does not match the stored rows', () => {
    const sealed = vault().seal(REF, 'ghp_example_token');
    const other = vault();

    let thrown: SecretUnreadableError | null = null;
    try {
      other.open(REF, sealed);
    } catch (error) {
      thrown = error as SecretUnreadableError;
    }

    // The realistic cause is a restored database paired with a different MC_ENCRYPTION_KEY.
    // A generic failure would send the operator looking in the wrong place entirely.
    expect(thrown).toBeInstanceOf(SecretUnreadableError);
    expect(thrown?.message).toContain('integrations/github_token');
    expect(thrown?.message).toContain('MC_ENCRYPTION_KEY');
    expect(thrown?.message).toContain('Re-enter');
    expect(thrown?.keyVersion).toBe(1);
  });

  it('names the key version when a row was sealed under a different one', () => {
    const subject = vault();
    const sealed = subject.seal(REF, 'ghp_example_token');

    let thrown: SecretUnreadableError | null = null;
    try {
      subject.open(REF, { ...sealed, keyVersion: 2 });
    } catch (error) {
      thrown = error as SecretUnreadableError;
    }

    expect(thrown?.keyVersion).toBe(2);
    expect(thrown?.message).toContain('key_version 2');
  });

  it('reports tampering rather than returning altered plaintext', () => {
    const subject = vault();
    const sealed = subject.seal(REF, 'ghp_example_token');
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;

    expect(() => subject.open(REF, { ...sealed, ciphertext: tampered })).toThrow(
      SecretUnreadableError,
    );
  });

  it('never puts ciphertext, key material or plaintext in its error', () => {
    const subject = vault();
    const sealed = subject.seal(REF, 'ghp_super_secret_value');
    const other = vault();

    try {
      other.open(REF, sealed);
      expect.unreachable('open() must throw');
    } catch (error) {
      const text = `${(error as Error).message}${JSON.stringify(error)}`;
      expect(text).not.toContain('ghp_super_secret_value');
      expect(text).not.toContain(sealed.ciphertext.toString('base64'));
    }
  });

  it('says why, rather than silently storing nothing, when no key is configured', () => {
    const keyless = new SecretVault({ encryptionKey: null });

    expect(keyless.available).toBe(false);
    let thrown: ApiError | null = null;
    try {
      keyless.seal(REF, 'value');
    } catch (error) {
      thrown = error as ApiError;
    }
    expect(thrown?.code).toBe('INTERNAL');
    expect(thrown?.message).toContain('MC_ENCRYPTION_KEY');
  });

  it('reports an unusable key at first use instead of pretending to work', () => {
    const broken = new SecretVault({ encryptionKey: 'dG9vLXNob3J0' });

    expect(broken.available).toBe(false);
    expect(() => broken.seal(REF, 'value')).toThrow(/32 bytes|MC_ENCRYPTION_KEY/);
  });
});
