import { type Db, newId, schema } from '@mc/shared';
import { eq, sql } from 'drizzle-orm';
import { recordAuditEntry } from '../audit/index.js';
import { assertPasswordPolicy, hashPassword } from './passwords.js';

/**
 * First-run bootstrap of the single local account (F4.1, PRD §10 "Local account").
 *
 * ⚠ **GAP — the TDS is silent on this.** TDS 03 §8 says only that "first-run bootstrap
 * (single `users` row, default `workspaces` row, default `settings`) is application startup
 * logic (idempotent upsert), not a migration". No document — WS0, WS1, WS2, WS3 or the PRD —
 * says **where the first account's credentials come from**. That matters because the two
 * readings of "idempotent upsert at startup" are both wrong on their own:
 *
 *   - Auto-creating a user at startup requires inventing a default password, which is the
 *     single worst default a self-hosted product can ship.
 *   - Leaving it out entirely leaves a migrated database with no way in, since
 *     `POST /api/v1/auth/login` is the only public route.
 *
 * Implemented instead (and flagged for the contract owners rather than folded in silently):
 * an explicit, non-interactive-safe operator action — `pnpm auth:create-user`, see
 * `src/cli/create-user.ts`. The workspace/settings half of TDS 03 §8's seed genuinely is
 * idempotent startup logic and stays with whoever implements those tables.
 *
 * The safety property this module owns: **an existing account is never silently overwritten.**
 * A second run reports `already_exists` and changes nothing; replacing the password requires
 * an explicit flag *and* the username to match the account that exists.
 */

export type BootstrapStatus = 'created' | 'password_reset' | 'already_exists';

export interface BootstrapUserInput {
  readonly username: string;
  readonly password: string;
  readonly displayName?: string | null;
  /**
   * Explicit opt-in to replacing the password of the existing account — the lockout escape
   * hatch. Never implied by re-running the command.
   */
  readonly allowPasswordReset?: boolean;
}

export interface BootstrapUserResult {
  readonly status: BootstrapStatus;
  readonly userId: string;
  readonly username: string;
}

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

export const MAX_USERNAME_LENGTH = 64;

/**
 * Create the local account, or (only with `allowPasswordReset`) replace its password.
 *
 * Runs inside a transaction holding an advisory lock, so two concurrent invocations cannot
 * both observe an empty `users` table and both insert. V1 is single-account by product
 * decision, and this is what makes that true of the *database* rather than of the happy path.
 */
export async function bootstrapLocalUser(
  db: Db,
  input: BootstrapUserInput,
): Promise<BootstrapUserResult> {
  assertUsername(input.username);
  assertPasswordPolicy(input.password);

  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    // Arbitrary but stable key for "the bootstrap critical section"; released at commit.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('mission-control:bootstrap'))`);

    const existing = await tx
      .select({ id: schema.users.id, username: schema.users.username })
      .from(schema.users)
      .limit(2);

    const current = existing[0];

    if (current === undefined) {
      const id = newId();
      await tx.insert(schema.users).values({
        id,
        username: input.username,
        passwordHash,
        displayName: input.displayName ?? null,
      });

      await recordAuditEntry(tx, {
        actorType: 'system',
        actorId: null,
        action: 'user.created',
        entityType: 'users',
        entityId: id,
        after: { username: input.username, source: 'bootstrap_cli' },
      });

      return { status: 'created', userId: id, username: input.username };
    }

    if (input.allowPasswordReset !== true) {
      return { status: 'already_exists', userId: current.id, username: current.username };
    }

    if (current.username.toLowerCase() !== input.username.toLowerCase()) {
      throw new BootstrapError(
        `Refusing to reset the password: this instance's account is '${current.username}', not ` +
          `'${input.username}'. V1 has exactly one local account (F4.1); renaming it is not a ` +
          'password reset.',
      );
    }

    await tx
      .update(schema.users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(schema.users.id, current.id));

    await recordAuditEntry(tx, {
      actorType: 'system',
      actorId: null,
      action: 'user.password_reset',
      entityType: 'users',
      entityId: current.id,
      after: { username: current.username, source: 'bootstrap_cli' },
    });

    return { status: 'password_reset', userId: current.id, username: current.username };
  });
}

function assertUsername(username: string): void {
  if (username.length < 1 || username.length > MAX_USERNAME_LENGTH) {
    throw new BootstrapError(`Username must be 1–${MAX_USERNAME_LENGTH} characters`);
  }
  if (username.trim() !== username) {
    throw new BootstrapError('Username must not start or end with whitespace');
  }
}
