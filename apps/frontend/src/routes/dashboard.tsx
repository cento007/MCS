import { PagePlaceholder } from '../components/PagePlaceholder.js';

/** `/` — Dashboard home (PRD §8.1, TDS 06 §5.2). Widgets land with the dashboard task. */
export function Component() {
  return (
    <PagePlaceholder
      title="Dashboard"
      summary="Needs Attention, Active Sessions, Spend, Active Projects, Services, Recent ADRs, Upcoming Tasks and Notifications — in that order. Every widget on this page is a live region, so each one obeys the degraded-liveness rule: muted values and frozen durations whenever the connection chip is not `live`."
      owner="TDS 06 §5.2 and PRD §8.1"
    />
  );
}
