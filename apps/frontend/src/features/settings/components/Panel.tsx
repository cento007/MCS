import type { KeyboardEvent, ReactNode } from 'react';
import { ErrorPanel } from '../../../components/ErrorPanel.js';
import { Skeleton } from '../../../components/Skeleton.js';
import { formatClockSeconds } from '../../../lib/format/index.js';
import { changeCountLabel } from '../dirty.js';
import type { PanelForm } from '../form.js';

/**
 * The shared chrome of every mutable Settings panel (TDS 06 §5.7, §5.7.2).
 *
 * It owns the three things that must be identical on all of them:
 *
 *  1. **The sticky Save bar, which names the count of changed fields** — `3 changes  [Discard]
 *     [Save changes]`. A bare `[Save changes]` says *something* is unsaved without saying how
 *     much would be lost by discarding.
 *  2. **`Ctrl+S` saves the dirty panel from anywhere within it.** Bound on the panel's own
 *     `form` element rather than through `lib/keys`, deliberately: the global registry
 *     suppresses every chord except `Escape` and `Ctrl+Enter` while focus is in a text field
 *     (§9.4), which is exactly where an operator's hands are when they reach for `Ctrl+S`. A
 *     local handler is the only place that binding can honestly work.
 *  3. **The honest unavailable state.** When the Backend does not serve the route, the panel
 *     renders its real fields disabled with a note naming the missing route — never invented
 *     defaults, which would look like persisted configuration and be silently wrong.
 */

export interface SettingsPanelProps<TDoc> {
  readonly title: string;
  readonly form: PanelForm<TDoc>;
  /** The route this panel reads and writes, quoted verbatim in the unavailable note. */
  readonly endpoint: string;
  readonly children: ReactNode;
  readonly description?: string;
  /** Right-hand header slot: the card status chip (`● Connected`, `○ Disabled`). */
  readonly status?: ReactNode;
  /** Rendered between the fields and the Save bar — Test Connection lives here. */
  readonly actions?: ReactNode;
  readonly headingLevel?: 2 | 3;
  /**
   * Shrink the "not served yet" note to one line.
   *
   * The six Integrations cards all read the same document, so when that route is missing they
   * are all unavailable at once — six identical amber boxes down one page, which is noise that
   * teaches the operator to skip the colour. The category prints the explanation once and each
   * card keeps a one-line pointer to its own write route.
   */
  readonly compactUnavailable?: boolean;
}

export function SettingsPanel<TDoc>({
  title,
  form,
  endpoint,
  children,
  description,
  status,
  actions,
  headingLevel = 2,
  compactUnavailable = false,
}: SettingsPanelProps<TDoc>) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    const isSave = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';
    if (!isSave) return;
    event.preventDefault();
    if (!form.summary.isDirty || form.disabled) return;
    void form.save();
  };

  return (
    <form
      data-testid={`panel-${title.toLowerCase().replace(/\s+/g, '-')}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (form.summary.isDirty && !form.disabled) void form.save();
      }}
      onKeyDown={onKeyDown}
      className="rounded-md border border-border"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-border border-b px-4 py-3">
        <Heading className="font-medium text-2xs text-text-secondary uppercase">{title}</Heading>
        {status}
      </div>

      <div className="flex flex-col gap-4 px-4 py-4">
        {description === undefined ? null : (
          <p className="text-sm text-text-secondary leading-150">{description}</p>
        )}

        {form.available ? null : (
          <UnavailableNote endpoint={endpoint} compact={compactUnavailable} />
        )}
        {form.error === null ? null : <ErrorPanel error={form.error} />}

        {form.isPending && form.available ? (
          <div className="space-y-2" role="status" aria-busy="true">
            <span className="sr-only">Loading {title}</span>
            <Skeleton height={32} />
            <Skeleton height={32} />
            <Skeleton height={32} />
          </div>
        ) : (
          children
        )}

        {actions}
      </div>

      <SaveBar form={form} />
    </form>
  );
}

/**
 * The sticky Save bar. Present only while dirty — a permanently-visible Save button on a clean
 * panel trains the operator to ignore it, which is the opposite of what this bar is for.
 */
export function SaveBar<TDoc>({ form }: { form: PanelForm<TDoc> }) {
  const { summary, isSaving, savedAt } = form;

  if (!summary.isDirty) {
    return savedAt === null ? null : (
      <div className="border-border border-t px-4 py-2">
        <p data-testid="saved-confirmation" className="text-2xs text-text-muted">
          Saved {formatClockSeconds(savedAt)}
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="save-bar"
      className="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 border-border border-t px-4 py-3"
      style={{ backgroundColor: 'var(--color-surface-raised)' }}
    >
      <p aria-live="polite" className="mr-auto font-medium text-sm text-text">
        {changeCountLabel(summary)}
      </p>
      <button
        type="button"
        onClick={form.discard}
        disabled={isSaving}
        className="rounded-sm border border-border-control px-3 text-sm text-text disabled:opacity-50"
        style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
      >
        Discard
      </button>
      <button
        type="submit"
        disabled={isSaving || form.disabled}
        className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
        style={{
          height: 'var(--mc-control-md)',
          minHeight: 24,
          backgroundColor: 'var(--color-accent)',
          color: 'var(--color-on-accent)',
        }}
      >
        {isSaving ? 'Saving…' : 'Save changes'}
      </button>
    </div>
  );
}

/**
 * The honest "not served yet" note.
 *
 * It names the exact route, because the operator reading it and the engineer who has to add it
 * are frequently the same person, and "settings unavailable" would send them to the logs to
 * discover what this line already knows.
 */
export function UnavailableNote({
  endpoint,
  compact = false,
}: {
  endpoint: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <p role="note" data-testid="endpoint-unavailable" className="text-2xs text-text-muted">
        <span aria-hidden="true">▲</span> Disabled — no{' '}
        <code className="font-mono">/api/v1{endpoint}</code> route yet.
      </p>
    );
  }

  return (
    <div
      role="note"
      data-testid="endpoint-unavailable"
      className="rounded-sm border p-3"
      style={{
        backgroundColor: 'var(--color-warning-subtle)',
        borderColor: 'var(--color-warning)',
      }}
    >
      <p className="text-sm text-text leading-150">
        <span aria-hidden="true">▲</span> Not configurable yet — the Backend does not serve{' '}
        <code className="font-mono text-xs">/api/v1{endpoint}</code>.
      </p>
      <p className="mt-1 text-2xs text-text-muted leading-150">
        The fields below are built to the TDS 04 §7.3 contract and are disabled until that route
        exists. Nothing is shown from a local default: a value here that had never been saved would
        be indistinguishable from configuration.
      </p>
    </div>
  );
}

/** Card-header status chip — `● Connected`, `○ Disabled`, `◌ Not active (Phase 3)`. */
export function PanelStatus({
  glyph,
  label,
  colorVar = '--color-text-muted',
}: {
  glyph: string;
  label: string;
  colorVar?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-2xs" style={{ color: `var(${colorVar})` }}>
      <span aria-hidden="true">{glyph}</span>
      {label}
    </span>
  );
}
