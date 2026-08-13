import { Widget } from './Widget.js';

/**
 * Recent ADRs (TDS 06 §5.2) — **Phase 2**.
 *
 * The Adr entity, `GET /adrs` and the Sync Worker that generates them all arrive with the
 * Knowledge phase. So this widget renders what is true today and nothing more: it does not
 * call an endpoint the Backend does not serve, and it does not render `0` or an empty list,
 * because both would claim the operator has no ADRs when the truth is that the feature has
 * not shipped. "No ADRs yet" over a 404 is a lie with a friendly face.
 */
export function RecentAdrsWidget() {
  return (
    <Widget title="Recent ADRs" subtitle="Phase 2">
      <p className="text-2xs text-text-muted leading-150">
        ADRs are generated from Sessions and synced to the Obsidian vault in Phase 2. Nothing writes
        one yet, so this widget stays empty rather than reporting a count it cannot know.
      </p>
    </Widget>
  );
}
