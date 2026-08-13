/**
 * `notifications/` — the cross-process half of the Notification contract (TDS 04 §8,
 * storage TDS 03 §4.2).
 *
 * It lives in `@mc/shared` because **two processes produce Notifications**: the Backend from
 * its own domain events (TDS 04 §15.2 rows 6, 7, 15 and the cost-budget note) and the Telegram
 * Worker from its scheduled daily report (TDS 02 §2.2). The production policy, the atomic
 * row+job write, and the quiet-hours window are therefore contract, not implementation detail —
 * a second copy in either process would be a copy that eventually disagrees, and the
 * disagreement would show up as an operator not being told something.
 *
 * Not here: **rendering**. `title`/`body` are pre-rendered by whoever produces the
 * Notification (§8: "Telegram and the UI share it") from facts only that producer has.
 *
 * Node-only (it touches Drizzle and the queue), so it is exported from `@mc/shared` and
 * deliberately **not** from the browser-safe `@mc/shared/types` entry.
 */

export * from './policy.js';
export * from './quiet-hours.js';
export * from './write.js';
