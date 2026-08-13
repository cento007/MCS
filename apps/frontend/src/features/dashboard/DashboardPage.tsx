import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { PANEL_BREAKPOINTS, useMediaQuery } from '../../lib/media.js';
import { ActiveProjectsWidget } from './ActiveProjectsWidget.js';
import { ActiveSessionsWidget } from './ActiveSessionsWidget.js';
import { NeedsAttention } from './NeedsAttention.js';
import { NotificationsWidget } from './NotificationsWidget.js';
import { RecentAdrsWidget } from './RecentAdrsWidget.js';
import { ServicesWidget } from './ServicesWidget.js';
import { SpendWidget } from './SpendWidget.js';
import { UpcomingTasksWidget } from './UpcomingTasksWidget.js';

/**
 * `/` — the Dashboard (PRD §8.1, TDS 06 §5.2).
 *
 * **The widget order is the specification and it is deliberate.** An operator opening this
 * page asks, in order: *what is broken?* → *what is running?* → *what is it costing me?* →
 * *what else exists?* The previous layout led with inventory and made failure something you
 * had to go looking for. Needs Attention is therefore first in the grid **and** first in the
 * DOM, which is also first in the mobile stack (§9.2 makes this the primary mobile surface)
 * and first for a screen reader.
 *
 * Every widget owns its own fetch, its own skeleton and its own inline error, so one failing
 * endpoint darkens one card rather than the page (§5.2: "Widget-level fetch errors show the
 * inline ErrorBanner inside that widget only").
 */
export function DashboardPage() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const navigate = useNavigate();
  const mobile = useMediaQuery(PANEL_BREAKPOINTS.mobile);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section className="px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 ref={headingRef} tabIndex={-1} className="font-medium text-text text-xl outline-none">
          Dashboard
        </h1>

        {/* §9.2 / arbitration A12: no New Session entry point on mobile. Composing a launch
            target requires the working-tree disclosure, which cannot be honestly reviewed on
            a phone. The Launch modal itself belongs to the Sessions feature, so this hands
            off through the URL rather than importing across features. */}
        {mobile ? null : (
          <button
            type="button"
            onClick={() => void navigate('/sessions?launch=1')}
            className="ml-auto rounded-sm px-3 font-medium text-sm"
            style={{
              height: 'var(--mc-control-md)',
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            + New Session
          </button>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        <NeedsAttention />
        <ActiveSessionsWidget />
        <SpendWidget />
        <ActiveProjectsWidget />
        <ServicesWidget />
        <RecentAdrsWidget />
        <UpcomingTasksWidget />
        <NotificationsWidget />
      </div>
    </section>
  );
}
