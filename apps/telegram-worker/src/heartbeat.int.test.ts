import {
  createDatabaseHeartbeatSink,
  createHeartbeat,
  createLogger,
  HEARTBEAT_INTERVAL_MS,
  heartbeatRowService,
  heartbeatStatus,
  schema,
} from '@mc/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDatabase, truncateAll } from '../test/integration/harness.js';

/**
 * The worker heartbeat (TDS 03 §4.4, TDS 02 §7.2).
 *
 * This is the worker's entire health surface: it exposes no port, so the Services panel derives
 * its status from the age of one upserted row. The Backend-side half of the transition —
 * `disabled` ("not deployed") flipping to `healthy` once a row exists — is asserted end to end
 * through `GET /services/health` in the Backend's own tier, because that is where the read
 * model lives.
 */

const silentLogger = createLogger({ service: 'telegram-worker', level: 'silent' });

async function rows(): Promise<(typeof schema.serviceHeartbeats.$inferSelect)[]> {
  return testDatabase().db.select().from(schema.serviceHeartbeats);
}

beforeEach(async () => {
  await truncateAll();
});

describe('createDatabaseHeartbeatSink', () => {
  it('writes one row under the DB name for this service', async () => {
    const heartbeat = createHeartbeat({
      service: 'telegram-worker',
      version: '1.2.3',
      logger: silentLogger,
      sink: createDatabaseHeartbeatSink(testDatabase().db),
      stats: () => ({ jobsProcessed: 7, jobsFailed: 1 }),
    });

    await heartbeat.beat();

    const written = await rows();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      // The F6 source name is `telegram-worker`; the CHECK constraint wants `telegram_worker`.
      service: heartbeatRowService('telegram-worker'),
      version: '1.2.3',
      stats: { jobsProcessed: 7, jobsFailed: 1 },
    });
    expect(written[0]?.pid).toBeGreaterThan(0);
    expect(written[0]?.hostname.length).toBeGreaterThan(0);
  });

  it('upserts in place — one hot row per service, never a growing log', async () => {
    const heartbeat = createHeartbeat({
      service: 'telegram-worker',
      version: '1.2.3',
      logger: silentLogger,
      sink: createDatabaseHeartbeatSink(testDatabase().db),
    });

    await heartbeat.beat();
    const first = (await rows())[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
    await heartbeat.beat();

    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(first?.id);
    expect(after[0]?.lastHeartbeatAt.getTime()).toBeGreaterThan(
      first?.lastHeartbeatAt.getTime() ?? 0,
    );
    // `created_at` records when this service was first ever seen, not the last restart.
    expect(after[0]?.createdAt.getTime()).toBe(first?.createdAt.getTime());
  });

  it('produces a row the Services view reads as healthy', async () => {
    await createHeartbeat({
      service: 'telegram-worker',
      version: '0.0.0-test',
      logger: silentLogger,
      sink: createDatabaseHeartbeatSink(testDatabase().db),
    }).beat();

    const row = (await rows())[0];
    const ageMs = Date.now() - (row?.lastHeartbeatAt.getTime() ?? 0);

    expect(heartbeatStatus(ageMs)).toBe('healthy');
    // Three ticks inside the healthy window (TDS 02 §7.2).
    expect(HEARTBEAT_INTERVAL_MS * 3).toBeLessThanOrEqual(90_000);
  });

  it('refuses to write a heartbeat for the Backend, which self-reports instead', () => {
    expect(() => heartbeatRowService('backend')).toThrow('self-reports');
  });
});
