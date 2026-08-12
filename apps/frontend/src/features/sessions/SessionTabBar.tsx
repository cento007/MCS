import { OpenSessionsStrip } from '../../app/shell/OpenSessionsStrip.js';

/**
 * The Live Session tab bar (TDS 06 §5.5, TDS 05 §6.5).
 *
 * > "The tab bar and the sidebar strip are the same list by construction, so they cannot
 * > disagree about what is open."
 *
 * Taken literally: this renders the **same component** as the shell strip, in its horizontal
 * orientation, rather than a second reading of the same `uiStore` slice. Two components
 * reading one store cannot diverge in *data*, but they can and do diverge in *behaviour* —
 * one grows a close affordance the other lacks, one forgets the unread counter. One component
 * cannot.
 *
 * `[+]` is the only thing this surface adds, because launching is the one action that belongs
 * to the tab bar and not to a sidebar list.
 */
export function SessionTabBar({ onLaunch }: { onLaunch: () => void }) {
  return (
    <div className="flex items-center gap-2 border-border border-b pr-2">
      <div className="min-w-0 flex-1">
        <OpenSessionsStrip orientation="horizontal" />
      </div>
      <button
        type="button"
        onClick={onLaunch}
        aria-label="New session"
        title="New session"
        className="shrink-0 rounded-sm border border-border-control px-3 text-sm text-text"
        style={{ height: 'var(--mc-control-sm)' }}
      >
        +
      </button>
    </div>
  );
}
