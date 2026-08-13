import { ServicesPanel } from '../../components/ServicesPanel.js';
import { SERVICE_HEALTH_POLL_MS } from '../../lib/service-health.js';
import { Widget } from './Widget.js';

/**
 * The Dashboard Services strip (TDS 06 §5.2) — the compact variant of the §5.7.12 panel, the
 * same component Settings → Services renders in its `full` form (TDS 05 §7.5).
 *
 * **Polled, not socket-driven, and the header says so.** Health must remain observable when
 * the socket is the sick component, so this widget carries no `last updated HH:MM`
 * disclosure: unlike every other region on this page it is not a claim the WebSocket
 * underwrites, and marking it stale when the socket drops would be false.
 */
export function ServicesWidget() {
  return (
    <Widget
      title="Services"
      to="/settings/services"
      toLabel="View service health"
      subtitle={`polled every ${Math.round(SERVICE_HEALTH_POLL_MS / 1000)}s`}
    >
      <ServicesPanel variant="compact" />
    </Widget>
  );
}
