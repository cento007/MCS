import { newId } from '../events/envelope.js';
import type { JobPayload, QueueJob } from './port.js';

/**
 * Build a `QueueJob`. The only supported constructor — a hand-rolled literal is one missing
 * `id` away from breaking the at-least-once de-duplication contract (F6.3).
 *
 * `id` is a UUIDv7 (F4.2) and is the de-duplication key. The pg-boss driver maps it onto the
 * job row's own primary key, so re-enqueueing the same id is a no-op rather than a second job.
 */
export function createJob<TPayload extends JobPayload>(
  payload: TPayload,
  id: string = newId(),
  options: { readonly startAfterSeconds?: number } = {},
): QueueJob<TPayload> {
  return Object.freeze({
    id,
    payload,
    ...(options.startAfterSeconds === undefined
      ? {}
      : { startAfterSeconds: Math.max(0, options.startAfterSeconds) }),
  });
}
