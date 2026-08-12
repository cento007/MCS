import { describe, expect, it } from 'vitest';
import {
  ARGON2_OPTIONS,
  assertPasswordPolicy,
  decoyPasswordHash,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PasswordPolicyError,
  verifyPassword,
} from './passwords.js';

/**
 * Argon2id hashing (TDS 03 §3.1, PRD §10). No database, no HTTP — this tier proves the
 * dependency itself installs and runs on this machine, which is the F8 cross-platform
 * requirement the choice of `@node-rs/argon2` (NAPI prebuilds, no node-gyp) exists to satisfy.
 */
describe('password hashing', () => {
  it('produces a PHC-encoded argon2id string carrying its own parameters', async () => {
    const encoded = await hashPassword('correct horse battery staple');

    expect(encoded.startsWith('$argon2id$')).toBe(true);
    expect(encoded).toContain(`m=${ARGON2_OPTIONS.memoryCost}`);
    expect(encoded).toContain(`t=${ARGON2_OPTIONS.timeCost}`);
    expect(encoded).toContain(`p=${ARGON2_OPTIONS.parallelism}`);
    // The plaintext must not survive anywhere in the stored value.
    expect(encoded).not.toContain('correct horse');
  });

  it('salts every hash, so the same password never yields the same string', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password-1'),
      hashPassword('same-password-1'),
    ]);

    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'same-password-1')).toBe(true);
    expect(await verifyPassword(b, 'same-password-1')).toBe(true);
  });

  it('verifies the correct password', async () => {
    const encoded = await hashPassword('a very good passphrase');
    expect(await verifyPassword(encoded, 'a very good passphrase')).toBe(true);
  });

  it('rejects a wrong password, including near misses', async () => {
    const encoded = await hashPassword('a very good passphrase');

    expect(await verifyPassword(encoded, 'a very good passphras')).toBe(false);
    expect(await verifyPassword(encoded, 'A very good passphrase')).toBe(false);
    expect(await verifyPassword(encoded, '')).toBe(false);
  });

  it('returns false — never throws — for an unparseable stored hash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });

  it('refuses to verify an over-long input instead of hashing it', async () => {
    const encoded = await hashPassword('a very good passphrase');
    expect(await verifyPassword(encoded, 'x'.repeat(MAX_PASSWORD_LENGTH + 1))).toBe(false);
  });

  it('has a decoy hash that a real password can be verified against and fail', async () => {
    const decoy = await decoyPasswordHash();

    expect(decoy.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(decoy, 'a very good passphrase')).toBe(false);
    // Cached: the second call must not pay for another hash.
    expect(await decoyPasswordHash()).toBe(decoy);
  });
});

describe('password policy (TDS 04 §3.1 — newPassword: min 12 chars)', () => {
  it('accepts a password at the minimum length', () => {
    expect(() => assertPasswordPolicy('x'.repeat(MIN_PASSWORD_LENGTH))).not.toThrow();
  });

  it('rejects a password below the minimum length', () => {
    expect(() => assertPasswordPolicy('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(
      PasswordPolicyError,
    );
  });

  it('rejects an over-long password', () => {
    expect(() => assertPasswordPolicy('x'.repeat(MAX_PASSWORD_LENGTH + 1))).toThrow(
      PasswordPolicyError,
    );
  });
});
