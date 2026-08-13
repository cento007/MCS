import { ServicesPanel } from '../../../components/ServicesPanel.js';
import type { ServiceHealthRow } from '../../../lib/api/index.js';
import { SERVICE_HEALTH_POLL_MS, useServiceHealth } from '../../../lib/service-health.js';

/**
 * Settings → Services (PRD §4.4.7, TDS 06 §5.7.12).
 *
 * The table itself is `components/ServicesPanel` — the same component the Dashboard renders in
 * its compact variant — so the two screens cannot disagree about a status word, a glyph or the
 * poll interval. This wrapper adds only what §5.7.12 asks for beyond the table: the panel
 * heading, the Backend footer line, and the read-only framing.
 *
 * Two things this panel must get right, both of which are about *not* alarming the operator:
 *
 *  - **The queue row reads "Queue (PostgreSQL)"** — per F2.1/F3 there is no Redis in this
 *    topology, and the label comes from the server rather than being derived here so the UI
 *    cannot invent a service that does not exist.
 *  - **`disabled` is not a failure.** Qdrant, Ollama, the Telegram Worker and the Sync Worker
 *    all report `disabled` on a correct Phase 1 install, meaning specified-but-not-deployed.
 *
 * It reads the same query key as the table, so the footer costs no extra request.
 */
export function ServicesSettingsPanel() {
  const query = useServiceHealth();
  const backend = (query.data?.services ?? []).find((row) => row.name === 'backend') ?? null;

  return (
    <section
      className="rounded-md border border-border"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-border border-b px-4 py-3">
        <h2 className="font-medium text-2xs text-text-secondary uppercase">Services</h2>
        <span className="text-2xs text-text-muted">
          auto-refresh {Math.round(SERVICE_HEALTH_POLL_MS / 1000)}s
        </span>
      </div>

      <div className="px-4 py-4">
        <ServicesPanel variant="full" />
        {backend === null ? null : <BackendLine row={backend} />}
        <p className="mt-3 text-2xs text-text-muted leading-150">
          Read-only. Health is polled rather than pushed over the WebSocket, deliberately: it has to
          stay observable when the socket itself is the failing component.
        </p>
      </div>
    </section>
  );
}

/** `Backend ● healthy · uptime 3d 4h · ‹v0.1.0›` (§5.7.12). */
export function BackendLine({ row }: { row: ServiceHealthRow }) {
  const version = metaString(row, 'version');
  const uptime = metaNumber(row, 'uptimeSeconds');
  const sessions = metaNumber(row, 'activeSessions');
  const slots = metaNumber(row, 'maxConcurrentSessions');

  const parts = [row.label];
  if (uptime !== null) parts.push(`uptime ${formatUptime(uptime)}`);
  if (version !== null) parts.push(`v${version}`);
  if (sessions !== null && slots !== null) parts.push(`${sessions}/${slots} session slots`);

  return (
    <p data-testid="backend-line" className="mt-3 text-2xs text-text-secondary">
      {parts.join(' · ')}
    </p>
  );
}

function metaString(row: ServiceHealthRow, key: string): string | null {
  const value = row.meta?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function metaNumber(row: ServiceHealthRow, key: string): number | null {
  const value = row.meta?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `3d 4h` / `4h 12m` / `54s` — compact by design; the footer says the Backend is up, not for how many seconds. */
export function formatUptime(seconds: number): string {
  if (seconds < 0) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
}
