import { useCallback, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ConfirmDialog } from '../../../components/Modal.js';
import { endpoints, queryKeys } from '../../../lib/api/index.js';
import type { Draft } from '../../../lib/forms/dirty.js';
import {
  SelectControl,
  type SelectOption,
  SettingsField,
  SettingsGroup,
  ToggleControl,
} from '../components/Field.js';
import { SettingsPanel } from '../components/Panel.js';
import { usePanelForm } from '../form.js';
import { useMemorySettings } from '../queries.js';
import type { MemorySettingsDocument } from '../types.js';
import {
  describeMemoryConsequences,
  type MemoryConsequences,
  type MemorySettingsShape,
  memoryConsequences,
  NO_CONSEQUENCES,
  RETENTION_NEVER,
  readMemorySettings,
  retentionDraftKey,
  retentionToDraftValue,
  sourceDraftKey,
  tierDescription,
  toMemoryBody,
  toMemoryDraft,
} from './memory-shape.js';

/**
 * Settings → Memory (PRD §4.4 item 4, TDS 04 §7.3).
 *
 * Two settings, and they are not the same kind of thing:
 *
 *  - **Retention, per memory tier.** The only control in Settings whose save *deletes*. A shorter
 *    window drops stored chunks, and the way back is re-embedding their sources — an embedding
 *    call per chunk, not a restore. So narrowing a window goes through a confirmation that names
 *    both numbers, and the confirmation is wired into the form engine rather than onto the button,
 *    so `Ctrl+S` and the unsaved-changes guard cannot walk around it.
 *  - **Indexed sources.** Which of PRD §6.3's six sources the indexer is allowed to add. Turning
 *    one off is not a delete and the panel says so out loud, because the two are one click apart
 *    on the same screen.
 *
 * ## Only what the Backend serves
 *
 * The panel renders a control for a key it was actually sent, and nothing else. The `memory`
 * category is being filled in as Phase 3 lands — today's key registry (§7.6) has no entries and
 * the route answers `{}` — and the two apps ship separately, so "the field is not there" is a
 * state this screen will be in. Drawing the PRD's controls anyway would put a retention window on
 * screen that no sweep reads and a source switch that no indexer consults, and neither would look
 * any different from one that works. `memory-shape.ts` decides; this file only lays out.
 *
 * The same rule runs the other way for the save: anything served and not rendered is carried
 * through the full-category replace untouched (A14 resets an omitted field to its default), so a
 * newer Backend's extra key survives an older SPA editing beside it.
 */

const PATH = endpoints.settings.category('memory');

const NEVER_OPTION: SelectOption = { value: RETENTION_NEVER, label: 'Never expire' };

/**
 * A short ladder, not a free number field. Retention is destructive and unattended: an operator
 * typing `3` where they meant `30` gets no second chance, and no product need distinguishes 87
 * days from 90.
 */
const RETENTION_LADDER: readonly SelectOption[] = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
  { value: '365', label: '365 days' },
];

const RETENTION_OPTIONS: readonly SelectOption[] = [NEVER_OPTION, ...RETENTION_LADDER];

/**
 * The ladder, plus the stored value when it is not on it.
 *
 * A window set elsewhere — by a migration, by `curl`, by a later version of this screen — must
 * not disappear from its own dropdown: `SelectControl` would render "— not loaded" and the first
 * save would silently rewrite it to whichever option the operator picked next.
 */
export function retentionOptions(current: string): readonly SelectOption[] {
  if (RETENTION_OPTIONS.some((option) => option.value === current)) return RETENTION_OPTIONS;
  const days = Number(current);
  if (!Number.isFinite(days)) return RETENTION_OPTIONS;
  const merged = [...RETENTION_LADDER, { value: current, label: `${current} days (stored)` }].sort(
    (left, right) => Number(left.value) - Number(right.value),
  );
  return [NEVER_OPTION, ...merged];
}

function toDraft(document: MemorySettingsDocument): Draft {
  return toMemoryDraft(readMemorySettings(document));
}

function toBody({ draft, document }: { draft: Draft; document: MemorySettingsDocument }): unknown {
  return toMemoryBody(document, readMemorySettings(document), draft);
}

interface PendingConfirm {
  readonly body: string;
  readonly title: string;
  readonly confirmLabel: string;
  readonly destructive: boolean;
  resolve(confirmed: boolean): void;
}

export function MemoryPanel() {
  const query = useMemorySettings();

  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Read at save time, written every render: the confirmation has to describe the draft as it is
  // when the operator presses Save, and a closure captured into the form engine would describe the
  // draft as it was when the engine was built.
  const consequencesRef = useRef<MemoryConsequences>(NO_CONSEQUENCES);

  const confirmSave = useCallback(async (): Promise<boolean> => {
    const consequences = consequencesRef.current;
    if (!consequences.any) return true;
    return new Promise<boolean>((resolve) => {
      setPending({
        resolve,
        body: describeMemoryConsequences(consequences),
        title:
          consequences.narrowed.length > 0
            ? 'Shorten retention and delete stored memory?'
            : 'Stop indexing these sources?',
        confirmLabel: consequences.narrowed.length > 0 ? 'Shorten and delete' : 'Stop indexing',
        destructive: consequences.narrowed.length > 0,
      });
    });
  }, []);

  const form = usePanelForm<MemorySettingsDocument>({
    panelId: 'memory',
    label: 'Memory',
    path: PATH,
    queryKey: queryKeys.settings.category('memory'),
    query,
    toDraft,
    toBody,
    confirmSave,
  });

  const shape = useMemo(() => readMemorySettings(form.document ?? {}), [form.document]);
  consequencesRef.current = memoryConsequences(shape, form.draft);

  const settle = (confirmed: boolean): void => {
    pending?.resolve(confirmed);
    setPending(null);
  };

  return (
    <>
      <SettingsPanel
        title="Memory"
        form={form}
        endpoint={PATH}
        description="How long the four-tier memory system keeps what it has embedded, and which of PRD §6.3’s sources it is allowed to embed at all."
      >
        {form.available && !form.isPending && shape.empty ? (
          <NothingServed shape={shape} />
        ) : (
          <>
            {shape.retention.length > 0 ? (
              <SettingsGroup title="Retention">
                {shape.retention.map((row) => {
                  const name = retentionDraftKey(row.field);
                  const value = String(form.value(name) ?? retentionToDraftValue(row.days));
                  return (
                    <SettingsField
                      key={name}
                      label={row.label}
                      changed={form.isChanged(name)}
                      description={tierDescription(row.tier)}
                    >
                      {({ id }) => (
                        <SelectControl
                          id={id}
                          value={value}
                          disabled={form.disabled}
                          onChange={(next) => form.set(name, next)}
                          options={retentionOptions(value)}
                        />
                      )}
                    </SettingsField>
                  );
                })}

                {/*
                 * The honest boundary of what this screen can promise. Mission Control stores the
                 * policy; a sweep in the Backend applies it, and nothing here observes that sweep
                 * — so the panel points at the surface where the index's actual state is visible
                 * rather than implying an expiry it can see happen.
                 */}
                <p className="text-2xs text-text-muted leading-150">
                  <span aria-hidden="true">▲</span> Retention is the only setting in the product
                  that deletes. Chunks older than the window are dropped from the index, and getting
                  them back means re-embedding the sources they came from — one model call per
                  chunk, not a database restore. This screen stores the policy and the Backend is
                  what enforces it; what the index actually holds is on{' '}
                  <Link
                    to="/memory"
                    className="rounded-xs underline decoration-dotted underline-offset-2"
                  >
                    Memory
                  </Link>
                  .
                </p>
              </SettingsGroup>
            ) : null}

            {shape.sources.length > 0 ? (
              <SettingsGroup title="Indexed sources">
                {shape.sources.map((row) => {
                  const name = sourceDraftKey(row.field);
                  return (
                    <SettingsField key={name} label={row.label} changed={form.isChanged(name)}>
                      {({ id }) => (
                        // The control says "Indexed", not "Index commits": the field label beside
                        // it already names the source, and the two labels concatenate into the
                        // accessible name ("Commit Indexed"). Pluralising the vocabulary here
                        // would be a third spelling of a word `lib/memory-sources.ts` owns.
                        <ToggleControl
                          id={id}
                          label="Indexed"
                          checked={form.value(name) === true}
                          disabled={form.disabled}
                          onChange={(next) => form.set(name, next)}
                        />
                      )}
                    </SettingsField>
                  );
                })}

                <p className="text-2xs text-text-muted leading-150">
                  <span aria-hidden="true">ⓘ</span> A source switched off stops being indexed, and
                  its existing chunks stop answering queries. Nothing is <strong>deleted</strong>:
                  the rows stay, so switching it back on makes them searchable again and a backfill
                  catches up on whatever was missed in between. Only a rebuild re-derives the
                  collection from zero — and it re-indexes just the sources that are on.
                </p>
              </SettingsGroup>
            ) : null}

            <MissingHalves shape={shape} />
            <CarriedThrough shape={shape} />
          </>
        )}
      </SettingsPanel>

      {/*
       * Raised above the unsaved-changes guard on purpose. That guard's own `[Save]` runs this
       * panel's save through the dirty registry, so the confirmation can be opened while a modal
       * is already on screen — at `z-50` it would sit behind the guard's scrim and the operator
       * would watch a "Saving…" button do nothing. Inline rather than a `z-*` utility: the closed
       * spacing ladder in `theme.css` has taught this codebase not to trust a class name it has
       * not seen in the built CSS.
       */}
      <div style={{ position: 'relative', zIndex: 60 }}>
        <ConfirmDialog
          open={pending !== null}
          title={pending?.title ?? ''}
          body={pending?.body ?? ''}
          confirmLabel={pending?.confirmLabel ?? 'Apply'}
          destructive={pending?.destructive ?? false}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      </div>
    </>
  );
}

/**
 * The Backend answered, and had nothing to configure.
 *
 * Deliberately not the `UnavailableNote`: that one means "no such route". This means the route is
 * there and its document is empty, which is a different fact with a different fix, and an operator
 * who is told the wrong one goes looking in the wrong place.
 */
function NothingServed({ shape }: { shape: MemorySettingsShape }) {
  return (
    <div
      role="note"
      data-testid="memory-settings-absent"
      className="rounded-sm border p-3"
      style={{
        backgroundColor: 'var(--color-warning-subtle)',
        borderColor: 'var(--color-warning)',
      }}
    >
      <p className="text-sm text-text leading-150">
        <span aria-hidden="true">▲</span> This Backend serves no memory settings.
      </p>
      <p className="mt-1 text-2xs text-text-muted leading-150">
        <code className="font-mono">GET /api/v1{PATH}</code> answered with{' '}
        {shape.unrecognised.length > 0
          ? 'a document this screen cannot interpret'
          : 'an empty document'}
        , so its settings key registry has no <code className="font-mono">retentionDays</code> or{' '}
        <code className="font-mono">indexedSources</code> entries yet. PRD §4.4 item 4 specifies a
        retention policy per memory tier and a toggle per indexed source; they are not drawn here
        from local defaults, because a control whose value nothing reads looks exactly like one that
        works — and on this category the controls decide what gets deleted.
      </p>
      {shape.unrecognised.length === 0 ? null : (
        <p className="mt-1 font-mono text-2xs text-text-secondary leading-150">
          served: {shape.unrecognised.join(', ')}
        </p>
      )}
    </div>
  );
}

/** One half of the contract served and the other absent — said once, not left to be noticed. */
function MissingHalves({ shape }: { shape: MemorySettingsShape }) {
  const missing: string[] = [];
  if (shape.retention.length === 0) missing.push('retention windows per memory tier');
  if (shape.sources.length === 0) missing.push('per-source indexing toggles');
  if (missing.length === 0 || shape.empty) return null;

  return (
    <p
      role="note"
      data-testid="memory-settings-partial"
      className="text-2xs text-text-muted leading-150"
    >
      <span aria-hidden="true">▲</span> This Backend does not serve {missing.join(' or ')}, so there
      is no control for them above. PRD §4.4 item 4 specifies them; nothing here invents one.
    </p>
  );
}

/**
 * Keys served but not rendered.
 *
 * Worth stating rather than swallowing, because of what a save does with them: the replacement
 * body is built from the served document, so they survive untouched — and an operator is entitled
 * to know that this screen is writing back a field it never showed them.
 */
function CarriedThrough({ shape }: { shape: MemorySettingsShape }) {
  if (shape.unrecognised.length === 0 || shape.empty) return null;

  return (
    <p
      role="note"
      data-testid="memory-settings-carried"
      className="text-2xs text-text-muted leading-150"
    >
      <span aria-hidden="true">ⓘ</span> Served but not shown here:{' '}
      <code className="font-mono">{shape.unrecognised.join(', ')}</code>. This screen has no control
      for {shape.unrecognised.length === 1 ? 'it' : 'them'} and writes{' '}
      {shape.unrecognised.length === 1 ? 'it' : 'them'} back unchanged — a save is a full-category
      replace, so omitting a field would reset it rather than leave it alone.
    </p>
  );
}
