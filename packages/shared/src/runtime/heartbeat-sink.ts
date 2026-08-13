import { hostname } from 'node:os';
import { type Db, schema } from '../db/index.js';
import { newId } from '../events/envelope.js';
import type { EventSource } from '../events/index.js';
import type { HeartbeatSample, HeartbeatSink } from './heartbeat.js';

/**
 * The real heartbeat sink: one upserted `service_heartbeats` row (TDS 03 §4.4, TDS 02 §7.2).
 *
 * Workers expose no HTTP port, so this row **is** their health surface. The Backend's Services
 * read model derives status from its age alone — `healthy` < 90 s, `stale` 90 s–5 min, `down`
 * beyond — and a worker that has never written a row reads as `disabled` ("not deployed").
 * Writing the first row is therefore exactly what flips the Settings → Services row from
 * `disabled` to `healthy`.
 *
 * `ON CONFLICT (service) DO UPDATE`: one hot row per service, updated in place, which is why
 * the table carries `fillfactor = 90`. `created_at` is never touched by the update — it records
 * when the service was first ever seen, not when the last process started (`started_at` does
 * that, and it moves on every restart).
 */

/** F6 `source` names → the `ck_service_heartbeats_service` value set (TDS 03 §4.4). */
const HEARTBEAT_ROW_SERVICE: Readonly<Record<EventSource, string | null>> = Object.freeze({
  'telegram-worker': 'telegram_worker',
  'sync-worker': 'sync_worker',
  // The Backend self-reports through `GET /services/health`; it does not heartbeat (§7.1).
  backend: null,
});

export function heartbeatRowService(service: EventSource): string {
  const row = HEARTBEAT_ROW_SERVICE[service];
  if (row === null) {
    throw new Error(`${service} does not write service_heartbeats — it self-reports (TDS 02 §7.1)`);
  }
  return row;
}

/**
 * A sink that writes to `service_heartbeats`.
 *
 * It does not swallow errors: `createHeartbeat` already catches and logs a failed write, and a
 * heartbeat that silently succeeded while the database was unreachable would be a lie told to
 * the one panel whose job is to notice.
 */
export function createDatabaseHeartbeatSink(db: Db): HeartbeatSink {
  return async (sample: HeartbeatSample): Promise<void> => {
    const service = heartbeatRowService(sample.service);

    await db
      .insert(schema.serviceHeartbeats)
      .values({
        id: newId(),
        service,
        hostname: hostnameOf(),
        pid: sample.pid,
        version: sample.version,
        stats: sample.stats,
        startedAt: sample.startedAt,
        lastHeartbeatAt: sample.heartbeatAt,
      })
      .onConflictDoUpdate({
        target: schema.serviceHeartbeats.service,
        set: {
          hostname: hostnameOf(),
          pid: sample.pid,
          version: sample.version,
          stats: sample.stats,
          startedAt: sample.startedAt,
          lastHeartbeatAt: sample.heartbeatAt,
          updatedAt: new Date(),
        },
      });
  };
}

/**
 * `os.hostname()` behind a guard.
 *
 * The column is `NOT NULL` and exists for "which machine is this running on" after a partial
 * upgrade; a locked-down environment where the call throws should degrade to an honest
 * placeholder rather than stop the worker reporting that it is alive.
 */
function hostnameOf(): string {
  try {
    return hostname();
  } catch {
    /* c8 ignore next 2 */
    return 'unknown';
  }
}
