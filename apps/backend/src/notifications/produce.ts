import {
  type Db,
  decideNotification,
  type EventEnvelope,
  type EventType,
  type NotificationDecision,
  type NotificationPayload,
  type NotificationType,
  notificationTypeForEvent,
  type QueuePort,
  type QuietHoursWindow,
  readLocalDayWindow,
  readQuietHoursWindow,
  schema,
  writeNotification,
} from '@mc/shared';
import { and, eq, gte } from 'drizzle-orm';
import type { EventBus, Outbox } from '../events/index.js';
import { CANCELLED_REASON } from '../sessions/service.js';
import { readCostBudget } from '../settings/claude-code.js';
import { DEFAULT_TIMEZONE, readTimezone } from '../settings/general.js';
import { readScheduleIntegrationSettings } from '../settings/integrations.js';
import { readNotificationsSettings } from '../settings/notifications.js';
import { isInvalidTimezoneError, readSpendAggregate } from '../spend/aggregate.js';
import { deriveDayStatus } from '../spend/status.js';
import {
  readNotificationRecipientId,
  readRepositoryFacts,
  readSessionFacts,
  readSyncRunFacts,
} from './facts.js';
import {
  type RenderedNotification,
  renderCostBudgetAlert,
  renderRepositoryProblem,
  renderSessionCompleted,
  renderSessionFailed,
  renderSyncFailed,
} from './render.js';

/**
 * Notification **production** (TDS 04 §8: "creation is system-only").
 *
 * ## Where production lives, and why it is here
 *
 * TDS 04 §15.2's "Queue consumers" column names the telegram-worker as the consumer that turns
 * `session.completed` / `session.failed` / `repository.sync_failed` / `sync.failed` into
 * Notifications. This implementation puts that step in the **Backend** instead, and keeps the
 * worker as the *delivery* half. Three reasons, in order of weight:
 *
 *  1. **Atomicity.** The row and its delivery job must commit together (F6.3), which needs an
 *     open transaction handle. The Backend already opens one for every domain write and owns
 *     the outbox helper; the worker would have to invent a second transactional path for a
 *     write the Backend was already making.
 *  2. **pg-boss is a competing-consumer substrate.** For the worker to see `session.completed`
 *     it must subscribe to the shared `events` queue — and a job on that queue goes to exactly
 *     one subscriber. The moment the Sync Worker subscribes for its own §15.2 rows
 *     (`setting.updated`, `adr.created`, `adr.updated`) the two workers start stealing each
 *     other's events. The catalog's consumer column describes routing that the chosen queue
 *     substrate cannot provide without a fan-out layer that does not exist. Recorded as a
 *     contract problem rather than worked around silently.
 *  3. **§15.2 already puts a producer here.** Its own note reads "the cost-budget check runs in
 *     the Backend on `session.completed`/usage updates and produces `notification.created`",
 *     so the Backend is a Notification producer by the catalog's own reckoning. This makes it
 *     the producer for all five Backend-observable types instead of four-plus-one.
 *
 * The daily report stays where TDS 02 §2.2 puts it: the Telegram Worker owns that scheduled
 * job, and produces its Notification through the same shared `writeNotification` primitive.
 *
 * ## What the transaction contains
 *
 * Reads (settings, quiet-hours window, facts) happen **outside**; the transaction holds only
 * writes, and holds all of them:
 *
 *   INSERT notifications  +  enqueue `notification.deliver`  +  enqueue `notification.created`
 *
 * so a rollback leaves no Notification, no delivery job and no event — and a commit leaves a
 * Notification that something is already committed to delivering.
 *
 * ## Driven by the in-process bus, not the queue
 *
 * The producer subscribes to the Backend's own post-commit event bus (F3.2). That is the
 * cheapest correct wiring for Backend-produced events and it introduces no second consumer on
 * `events`.
 *
 * `sync.failed` is produced by the **Sync Worker**, and it reaches this subscription through
 * §15.1's `LISTEN/NOTIFY` arm: `events/relay.ts` injects worker-produced envelopes into the same
 * in-process bus, so this producer needs no notion of where an event came from. That relay is
 * fan-out rather than a queue subscription, which is what keeps point 2 above true — nothing
 * here competes with the Telegram Worker for a job.
 *
 * One consequence worth stating, because it is load-bearing: `handleEvent` is **not** idempotent
 * on `event.id` — a repeated `sync.failed` would produce a second Notification. De-duplication
 * therefore lives in the relay (a bounded LRU on envelope `id`, `events/relay.ts`), which is the
 * one place every cross-process envelope passes through.
 */

/** The event types this producer listens for (TDS 04 §15.2 "Notif." column). */
export const PRODUCED_FROM_EVENTS: readonly EventType[] = Object.freeze([
  'session.completed',
  'session.failed',
  'repository.sync_failed',
  'sync.failed',
]);

export interface ProducedNotification {
  readonly id: string;
  readonly type: NotificationType;
  readonly telegramStatus: string;
  readonly dispatched: boolean;
  readonly deferUntil: Date | null;
}

export interface ProduceInput {
  readonly type: NotificationType;
  readonly rendered: RenderedNotification;
  readonly payload: NotificationPayload | null;
  readonly correlationId?: string | null;
}

export interface NotificationProducerOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly queue: QueuePort;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, context: string) => void;
}

export class NotificationProducer {
  readonly #db: Db;
  readonly #outbox: Outbox;
  readonly #queue: QueuePort;
  readonly #now: () => Date;
  readonly #onError: ((error: unknown, context: string) => void) | undefined;

  constructor(options: NotificationProducerOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#queue = options.queue;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError;
  }

  /**
   * Subscribe to the in-process bus. Returns the unsubscribe function.
   *
   * The listener is deliberately fire-and-forget: `bus.publish` is synchronous and runs after
   * the domain transaction has committed, so a producer failure must not be able to travel back
   * into the caller that completed a Session. It is reported through `onError` instead.
   */
  start(bus: EventBus): () => void {
    const unsubscribes = PRODUCED_FROM_EVENTS.map((type) =>
      bus.on(type, (event) => {
        void this.handleEvent(event).catch((error: unknown) => {
          this.#onError?.(error, `notification.produce:${event.type}`);
        });
      }),
    );

    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  /** Translate one F6 envelope into a Notification, or into nothing. Public: it is the seam. */
  async handleEvent(event: EventEnvelope): Promise<ProducedNotification | null> {
    const type = notificationTypeForEvent(event.type);
    if (type === null) return null;

    const built = await this.#build(type, event);
    if (built === null) return null;

    const produced = await this.produce(built);

    // The budget check rides `session.completed` (TDS 04 §15.2 note) rather than a schedule:
    // that is the only moment a Session's final cost lands on the row, so it is the only moment
    // the day's total can newly cross a threshold. It is independent of whether the completion
    // itself produced a Notification — an operator who muted "session complete" still wants to
    // know they are about to spend their daily budget.
    if (event.type === 'session.completed') {
      await this.#evaluateCostBudget(event.correlationId).catch((error: unknown) => {
        this.#onError?.(error, 'notification.produce:cost_budget_alert');
      });
    }

    return produced;
  }

  /**
   * Write one Notification and everything that must commit with it.
   *
   * Returns `null` when the operator's settings say this notification should not exist — the
   * per-event toggle being off is the only case, and it is a decision, not a failure.
   */
  async produce(input: ProduceInput): Promise<ProducedNotification | null> {
    const [notifications, integrations, timezone, userId] = await Promise.all([
      readNotificationsSettings(this.#db),
      readScheduleIntegrationSettings(this.#db),
      readTimezone(this.#db),
      readNotificationRecipientId(this.#db),
    ]);

    const now = this.#now();
    const quietHours = await this.#quietHours(notifications.quietHours, timezone, now);

    const decision = decideNotification({
      type: input.type,
      toggles: notifications.events,
      telegram: integrations.telegram,
      quietHours,
    });

    if (!decision.create) return null;

    if (userId === null) {
      // `notifications.user_id` is NOT NULL with an FK; before `auth:create-user` has run there
      // is no recipient. Silently dropping would be wrong, and so would crashing the caller.
      this.#onError?.(
        new Error('No local account exists yet — the Notification has no recipient'),
        `notification.produce:${input.type}`,
      );
      return null;
    }

    return this.#write(userId, input, decision, notifications.quietHours, timezone, now);
  }

  async #write(
    userId: string,
    input: ProduceInput,
    decision: NotificationDecision,
    quietHoursSettings: { start: string; end: string },
    timezone: string,
    now: Date,
  ): Promise<ProducedNotification> {
    const written = await this.#outbox.run(async (ctx) => {
      const result = await writeNotification(ctx.tx, this.#queue, {
        userId,
        type: input.type,
        title: input.rendered.title,
        body: input.rendered.body,
        payload: input.payload,
        correlationId: input.correlationId ?? null,
        decision,
        quietHours: { start: quietHoursSettings.start, end: quietHoursSettings.end, timezone },
        now,
      });

      await ctx.emit(
        this.#outbox.event(
          'notification.created',
          {
            notificationId: result.id,
            notificationType: input.type,
            severity: decision.severity,
          },
          {
            occurredAt: now,
            ...(input.correlationId === undefined || input.correlationId === null
              ? {}
              : { correlationId: input.correlationId }),
          },
        ),
      );

      return result;
    });

    return {
      id: written.id,
      type: input.type,
      telegramStatus: written.telegramStatus,
      dispatched: written.dispatched,
      deferUntil: written.deferUntil,
    };
  }

  /**
   * Evaluate the quiet-hours window, tolerating a timezone PostgreSQL rejects.
   *
   * Same fallback as the spend read model (§7.8): ICU and PostgreSQL keep separate zone
   * databases, so a name `Intl` accepted can still be rejected by the server. Failing the whole
   * notification over it would trade a possibly mistimed delivery for no delivery at all.
   */
  async #quietHours(
    settings: { enabled: boolean; start: string; end: string },
    timezone: string,
    at: Date,
  ): Promise<QuietHoursWindow> {
    try {
      return await readQuietHoursWindow(this.#db, { timezone, settings, at });
    } catch (error) {
      if (!isInvalidTimezoneError(error) || timezone === DEFAULT_TIMEZONE) throw error;
      this.#onError?.(error, 'notification.produce:timezone');
      return readQuietHoursWindow(this.#db, { timezone: DEFAULT_TIMEZONE, settings, at });
    }
  }

  /** Facts + text for one event. `null` when the entity it names no longer exists. */
  async #build(type: NotificationType, event: EventEnvelope): Promise<ProduceInput | null> {
    const correlationId = event.correlationId;

    switch (type) {
      case 'session_completed':
      case 'session_failed': {
        const sessionId = stringField(event.payload, 'sessionId');
        if (sessionId === null) return null;

        const facts = await readSessionFacts(this.#db, sessionId);
        if (facts === null) return null;

        const failureReason = facts.failureReason ?? stringField(event.payload, 'reason');

        // **A cancellation is not an alert.** `SessionService.cancel` writes `failed` because F7
        // gives a Session that never launched no other exit, and it emits `session.failed` like
        // every other transition into that state. Paging the operator with "Session failed" for
        // the Session they just cancelled — usually by stopping a workflow run — would be the
        // notification telling them something broke when they are the thing that happened. The
        // *reason* is what separates this from `backend_restart` or `process_crash`, both of
        // which are news and both of which still notify.
        if (type === 'session_failed' && failureReason === CANCELLED_REASON) return null;

        return {
          type,
          rendered:
            type === 'session_completed'
              ? renderSessionCompleted(facts)
              : renderSessionFailed({ ...facts, failureReason }),
          payload: {
            eventType: event.type,
            sessionId,
            ...(facts.projectName === null ? {} : { projectName: facts.projectName }),
          },
          correlationId,
        };
      }

      case 'repository_problem': {
        const repositoryId = stringField(event.payload, 'repositoryId');
        if (repositoryId === null) return null;

        const facts = await readRepositoryFacts(
          this.#db,
          repositoryId,
          stringField(event.payload, 'reason'),
        );

        return {
          type,
          rendered: renderRepositoryProblem(facts),
          payload: { eventType: event.type, repositoryId },
          correlationId,
        };
      }

      case 'sync_failed': {
        const syncRunId = stringField(event.payload, 'syncRunId');
        if (syncRunId === null) return null;

        const facts = await readSyncRunFacts(
          this.#db,
          syncRunId,
          stringField(event.payload, 'reason'),
        );

        return {
          type,
          rendered: renderSyncFailed(facts),
          payload: { eventType: event.type, syncRunId },
          correlationId,
        };
      }

      /* c8 ignore next 4 — `daily_report` is produced by the Telegram Worker and
         `cost_budget_alert` by `#evaluateCostBudget`; neither arrives as an event. */
      default:
        return null;
    }
  }

  /**
   * The PRD §4.4.2 budget check.
   *
   * **At most one alert per local calendar day**, and the dedupe anchor is the `notifications`
   * table itself rather than in-memory state: a Backend that restarts between two Sessions must
   * not re-alert, and a day that has already been alerted must not alert again on every
   * subsequent completion. `over` is allowed to supersede an earlier `alert` on the same day —
   * crossing the budget outright is new information, and staying silent about it because a 80%
   * warning already went out would be the wrong trade.
   */
  async #evaluateCostBudget(correlationId: string | null): Promise<void> {
    const [budget, timezone] = await Promise.all([
      readCostBudget(this.#db),
      readTimezone(this.#db),
    ]);
    if (budget.dailyUsd === null) return;

    const now = this.#now();
    const [aggregate, day] = await Promise.all([
      readSpendAggregate(this.#db, timezone, { at: now }),
      readLocalDayWindow(this.#db, timezone, now),
    ]);

    const status = deriveDayStatus(aggregate.day.totalCostUsd, budget);
    if (status !== 'alert' && status !== 'over') return;

    const already = await this.#alertedToday(day.dayStart);
    if (already === status || already === 'over') return;

    await this.produce({
      type: 'cost_budget_alert',
      rendered: renderCostBudgetAlert({
        status,
        spentUsd: aggregate.day.totalCostUsd,
        budgetUsd: budget.dailyUsd,
        thresholdPercent: budget.alertThresholdPercent,
        timezone,
        localDate: day.localDate,
      }),
      payload: {
        // No `eventType`: a threshold evaluation has no originating F6 event (arbitration A8).
        budgetStatus: status,
        spentUsd: aggregate.day.totalCostUsd,
        budgetUsd: budget.dailyUsd,
        localDate: day.localDate,
        timezone,
      },
      correlationId,
    });
  }

  /** The strongest budget alert already raised in this local day, if any. */
  async #alertedToday(dayStart: Date): Promise<'alert' | 'over' | null> {
    const rows = await this.#db
      .select({ payload: schema.notifications.payload })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.type, 'cost_budget_alert'),
          gte(schema.notifications.createdAt, dayStart),
        ),
      );

    let strongest: 'alert' | 'over' | null = null;
    for (const row of rows) {
      const status = stringField(row.payload as Record<string, unknown> | null, 'budgetStatus');
      if (status === 'over') return 'over';
      if (status === 'alert') strongest = 'alert';
    }
    return strongest;
  }
}

function stringField(payload: Record<string, unknown> | null, field: string): string | null {
  const value = payload?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
