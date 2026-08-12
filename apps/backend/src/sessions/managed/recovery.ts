import { type Db, schema } from '@mc/shared';
import { and, eq } from 'drizzle-orm';
import type { SessionStatePort } from './ports.js';

/**
 * Restart recovery (TDS 02 §4.4, WS6 §5.2.1) — run once at boot, before the Backend accepts
 * work.
 *
 * When the Backend dies, every SDK child dies with it (`KillMode=control-group`, §9.1). So a
 * Session found in `running` at boot has no controller and cannot get one:
 *
 *   1. **`running` (managed) -> `failed`, reason `backend_restart`, trigger `system`.** F7 has
 *      no system path back into `running`, and silently re-spawning an agentic session that may
 *      have been mid-tool-execution is unsafe. The UI offers one-click Resume, which creates a
 *      **new** Session using `resume: runtime_session_id` — the runtime's own JSONL restores the
 *      context, so nothing is lost but the failed marker (§6.3 resume-as-new, corrected
 *      2026-08-12 to include `failed`).
 *   2. **`paused` is untouched.** Cold pause holds no process by design (§5.1), so it is already
 *      restart-proof. Failing paused Sessions here would turn every routine deploy into a
 *      `failed` cascade — the exact outcome cold pause was chosen to prevent.
 *   3. **Queued `session.launch` jobs are untouched.** They are durable in pg-boss and the
 *      registry's consumer services them normally once it subscribes.
 *
 * The runtime is deliberately **not** a parameter: recovery never invokes it (WS6 §5.2.1: "the
 * mock runtime must **not** be invoked — recovery never auto-respawns"). A port it cannot reach
 * is a rule it cannot break.
 *
 * `observed` Sessions are out of scope: their process is somebody else's, it may well still be
 * running, and their ingest path decides what a restart means for them (§5.2).
 */

export const BACKEND_RESTART_REASON = 'backend_restart';

export interface RecoverManagedSessionsOptions {
  readonly db: Db;
  readonly stateMachine: SessionStatePort;
  readonly onError?: ((error: unknown, sessionId: string) => void) | undefined;
}

export interface ManagedRecoveryReport {
  /** Sessions found orphaned in `running`. */
  readonly orphaned: readonly string[];
  /** Those successfully transitioned to `failed`. */
  readonly failed: readonly string[];
}

export async function recoverManagedSessions(
  options: RecoverManagedSessionsOptions,
): Promise<ManagedRecoveryReport> {
  const rows = await options.db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.state, 'running'), eq(schema.sessions.sessionType, 'managed')));

  const orphaned = rows.map((row) => row.id);
  const failed: string[] = [];

  for (const sessionId of orphaned) {
    try {
      await options.stateMachine.transition({
        sessionId,
        to: 'failed',
        trigger: 'system',
        action: 'system',
        reason: BACKEND_RESTART_REASON,
      });
      failed.push(sessionId);
    } catch (error) {
      // One Session that cannot be recovered must not stop the others — and must certainly not
      // stop the Backend from booting.
      options.onError?.(error, sessionId);
    }
  }

  return { orphaned, failed };
}
