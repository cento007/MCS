import { type Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Argon2id password hashing (TDS 02 §2, TDS 03 §3.1, PRD §10).
 *
 * DEPENDENCY CHOICE — `@node-rs/argon2`. F8 requires the whole stack to install and run on
 * Windows 11 (dev) and Ubuntu (prod) *without a native build toolchain*. `@node-rs/argon2`
 * ships NAPI prebuilds for every platform this project targets (`win32-x64-msvc`,
 * `linux-x64-gnu`, `linux-x64-musl`, arm64 variants) plus a `wasm32-wasi` fallback, so
 * `pnpm install` never invokes node-gyp. The alternative `argon2` package compiles from
 * source through node-gyp unless a prebuild happens to match, which is exactly the
 * dev-machine-dependent install F8 rules out.
 *
 * `users.password_hash` stores the full PHC-encoded string (`$argon2id$v=19$m=…,t=…,p=…$…`),
 * so the parameters below are recorded per-row and can be raised later without a migration —
 * `verify` reads them from the stored hash, never from this file.
 */

/**
 * `Algorithm` is an ambient `const enum`, which `isolatedModules` forbids reading as a value.
 * The wire value is fixed by the Argon2 spec (0 = Argon2d, 1 = Argon2i, 2 = Argon2id).
 */
const ARGON2ID = 2 as Algorithm;

/** OWASP Password Storage Cheat Sheet, Argon2id row: m = 19 MiB, t = 2, p = 1. */
export const ARGON2_OPTIONS = Object.freeze({
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
});

/** PRD §4.4.6 / TDS 04 §3.1 — `newPassword: min 12 chars`. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Upper bound so a login request cannot be turned into a memory-hard DoS. Well above any
 * real passphrase; enforced by the route schemas too, this is the last line.
 */
export const MAX_PASSWORD_LENGTH = 1024;

export async function hashPassword(password: string): Promise<string> {
  assertHashablePassword(password);
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored PHC hash. Returns `false` — never throws — for a wrong
 * password, an unparseable hash, or an over-long input, so callers have exactly one failure
 * path and cannot accidentally distinguish them to the client.
 */
export async function verifyPassword(encodedHash: string, password: string): Promise<boolean> {
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await verify(encodedHash, password);
  } catch {
    return false;
  }
}

/**
 * A real Argon2id hash of a random string, used to spend the same work on a login for an
 * unknown username as on one for a known username (TDS 04 §1.3: `INVALID_CREDENTIALS` "never
 * distinguishes user vs password"). Without it, "no such user" returns in microseconds and
 * "wrong password" in ~20 ms, which is a username oracle on the wire.
 *
 * Built lazily and cached: the cost is paid once, on the first failed lookup, not at import.
 */
let dummyHashPromise: Promise<string> | null = null;

export async function decoyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hash(
    // Not a credential: a random value that nothing can ever be a password for.
    `decoy:${Math.random()}:${Date.now()}`,
    ARGON2_OPTIONS,
  );
  return dummyHashPromise;
}

/** Burn the same work as a real verification, then fail. */
export async function verifyAgainstDecoy(password: string): Promise<false> {
  await verifyPassword(await decoyPasswordHash(), password);
  return false;
}

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

/** Length policy for a password being *set* (login has no minimum — the stored hash decides). */
export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  assertHashablePassword(password);
}

function assertHashablePassword(password: string): void {
  if (password.length === 0) throw new PasswordPolicyError('Password must not be empty');
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
}
