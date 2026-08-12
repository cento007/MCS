/**
 * Holds the Node event loop open until shutdown.
 *
 * WHY THIS EXISTS, AND WHEN IT GOES AWAY: a worker process is only alive as long as
 * something references the event loop. The real pg-boss driver (F3.1) holds a PostgreSQL
 * connection and a poller, which is exactly that reference — so once WS1 wires the driver
 * in, this helper is deleted from the worker composition roots.
 *
 * In the scaffold the queue is the in-memory no-op and the heartbeat timer is `unref`'d
 * (it must never be the reason a process lingers), so without this the worker would start,
 * log, and exit 0 in ~300 ms. That would make `pnpm dev:workers` look broken and would
 * quietly diverge from the systemd `Type=simple` contract, where a long-running unit that
 * exits cleanly is a unit the operator can no longer see.
 */
export type StopKeepAlive = () => void;

/** One ref'd timer with a long period — cheap, and honest about what it is for. */
export function keepAlive(intervalMs = 60_000): StopKeepAlive {
  const timer = setInterval(() => {
    // Intentionally empty: the timer exists solely to reference the event loop.
  }, intervalMs);

  return () => clearInterval(timer);
}
