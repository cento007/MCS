import {
  MEMORY_SOURCE_TYPES,
  MEMORY_TIERS,
  type MemorySourceType,
  type MemoryTier,
} from '@mc/shared/types';
import { memorySourceField, memorySourceLabel } from '../../../lib/memory-sources.js';
import type { Draft, DraftValue } from '../dirty.js';

/**
 * Settings → Memory, as pure functions (PRD §4.4 item 4).
 *
 * The panel is the one place in Settings that **cannot** assume the document it is editing. Every
 * other category has a settled shape in the key registry; `memory` is being filled in as Phase 3
 * lands, so this client has to work against a Backend that serves the whole contract, one that
 * serves half of it, and the one that shipped yesterday, which serves `{}`. Four rules make that
 * safe, and all four live here rather than in the component so they are assertable without a DOM:
 *
 *  1. **A control is drawn only for a key the Backend actually served.** Not for a key the PRD
 *     names, not for a key with a plausible default. A switch that writes to a field nothing
 *     reads is indistinguishable, on screen, from one that works — and this category's switches
 *     decide what gets deleted.
 *  2. **A value this client cannot read is not a control either.** A retention entry that is a
 *     string, or a source flag that is not a boolean, is reported as unrecognised rather than
 *     coerced: coercing it would show the operator a value the server does not hold.
 *  3. **Everything served is written back.** A save is a full-category replace (arbitration A14),
 *     so an omitted field is a *reset to default*, not a no-op. Any key this panel does not
 *     render — a whole field, a tier, a source — is carried through the `PUT` verbatim.
 *  4. **A document is written back in the dialect it was read in.** See below.
 *
 * ## Two dialects for "never expire"
 *
 * The Backend's key registry names the field `retentionDays` and spells never-expire as **`0`**,
 * matching `security.auditLogRetentionDays`, and its JSON Schema is `integer, minimum: 0` — so a
 * `null` there is a `400`, not a synonym. The contract this panel was specified against named the
 * field `retention` and spelled never-expire as `null`. Both are read; whichever arrived is what
 * is written back, because guessing the other way round is either a rejected save or — far worse,
 * in the `retention` dialect — a `0` that reads as "expire everything now".
 */

/** Days, or `null` for "never expire". The wire spelling of `null` depends on the dialect. */
export type RetentionDays = number | null;

/** How the served document spells "never expire", and under which field name. */
export interface RetentionDialect {
  readonly field: string;
  /** The value written for `null`: `0` for `retentionDays`, `null` for `retention`. */
  readonly never: RetentionDays;
}

export interface RetentionRow {
  readonly tier: MemoryTier;
  readonly field: string;
  readonly label: string;
  readonly days: RetentionDays;
}

export interface SourceRow {
  readonly sourceType: MemorySourceType;
  readonly field: string;
  readonly label: string;
  readonly enabled: boolean;
}

export interface MemorySettingsShape {
  /** Tiers this Backend serves a readable retention value for, in `MEMORY_TIERS` order. */
  readonly retention: readonly RetentionRow[];
  /** Sources this Backend serves a readable toggle for, in `MEMORY_SOURCE_TYPES` order. */
  readonly sources: readonly SourceRow[];
  /** The retention field and never-spelling this document used; `null` when it carried neither. */
  readonly dialect: RetentionDialect | null;
  readonly hasIndexedSources: boolean;
  /** Dotted paths served but not rendered — disclosed on screen, and preserved on save. */
  readonly unrecognised: readonly string[];
  /** True when there is nothing on this Backend for the panel to configure. */
  readonly empty: boolean;
}

/**
 * In preference order. `retentionDays` first because it is what the Backend's registry defines;
 * `retention` is the shape this panel was specified against and is still read, so a Backend that
 * lands it instead gets a working screen rather than an empty one.
 */
const RETENTION_FIELDS: readonly { readonly field: string; readonly never: RetentionDays }[] = [
  { field: 'retentionDays', never: 0 },
  { field: 'retention', never: null },
];

const SOURCES_FIELD = 'indexedSources';

/** The `<select>` value standing for "never". `''` is taken — `SelectControl` reads it as unset. */
export const RETENTION_NEVER = 'never';

const TIER_LABELS: Readonly<Record<MemoryTier, string>> = {
  session: 'Session memory',
  project: 'Project memory',
  agent: 'Agent memory',
  global: 'Global memory',
};

/**
 * What each tier actually holds, from `packages/shared/src/memory/projection.ts`'s own table —
 * because "session / project / global" says nothing about which of them holds the transcript an
 * operator is about to put a 30-day window on.
 */
const TIER_DESCRIPTIONS: Readonly<Record<MemoryTier, string>> = {
  session: 'Chunks projected from session transcripts — the user and assistant turns.',
  project: 'Commits, ADRs, pull requests and repository documentation — everything project-scoped.',
  agent:
    'Agent memory is Phase 4 and nothing writes this tier yet, so a window here expires nothing.',
  global: 'Obsidian notes and anything else that belongs to no single project.',
};

function objectAt(document: unknown, field: string): Record<string, unknown> | null {
  if (typeof document !== 'object' || document === null) return null;
  const value = (document as Record<string, unknown>)[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * One stored retention value, in the given dialect. `null` (the outer one) means "this is not a
 * value I can read", which is a third answer and never gets a control.
 */
function readRetention(
  raw: unknown,
  dialect: RetentionDialect,
): { readonly days: RetentionDays } | null {
  // `null` is read as never in both dialects: it is the `retention` spelling, and a `null` under
  // `retentionDays` can only have come from something that bypassed the schema — reading it as a
  // day count would be worse than reading it as the safest value there is.
  if (raw === null) return { days: null };
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  const days = Math.trunc(raw);
  return { days: dialect.never === 0 && days === 0 ? null : days };
}

/**
 * Project `GET /settings/memory` into what can be rendered — and what must be carried.
 *
 * Takes `unknown` on purpose. The declared type of this document is a promise about a Backend
 * that may not have shipped yet; the runtime value is the only thing that is true.
 */
export function readMemorySettings(document: unknown): MemorySettingsShape {
  const root = typeof document === 'object' && document !== null ? document : {};
  const sourcesObject = objectAt(root, SOURCES_FIELD);

  const candidate = RETENTION_FIELDS.find((entry) => objectAt(root, entry.field) !== null);
  const dialect: RetentionDialect | null = candidate ?? null;
  const retentionObject = dialect === null ? null : objectAt(root, dialect.field);

  const unrecognised: string[] = [];

  for (const key of Object.keys(root as Record<string, unknown>)) {
    if (key === SOURCES_FIELD && sourcesObject !== null) continue;
    if (dialect !== null && key === dialect.field) continue;
    unrecognised.push(key);
  }

  const retention: RetentionRow[] = [];
  if (retentionObject !== null && dialect !== null) {
    const known = new Set<string>();
    for (const tier of MEMORY_TIERS) {
      known.add(tier);
      if (!(tier in retentionObject)) continue;
      const value = readRetention(retentionObject[tier], dialect);
      if (value === null) {
        unrecognised.push(`${dialect.field}.${tier}`);
        continue;
      }
      retention.push({ tier, field: tier, label: TIER_LABELS[tier], days: value.days });
    }
    for (const key of Object.keys(retentionObject)) {
      if (!known.has(key)) unrecognised.push(`${dialect.field}.${key}`);
    }
  }

  const sources: SourceRow[] = [];
  if (sourcesObject !== null) {
    const known = new Set<string>();
    for (const sourceType of MEMORY_SOURCE_TYPES) {
      const field = memorySourceField(sourceType);
      known.add(field);
      if (!(field in sourcesObject)) continue;
      const value = sourcesObject[field];
      if (typeof value !== 'boolean') {
        unrecognised.push(`${SOURCES_FIELD}.${field}`);
        continue;
      }
      sources.push({ sourceType, field, label: memorySourceLabel(sourceType), enabled: value });
    }
    for (const key of Object.keys(sourcesObject)) {
      if (!known.has(key)) unrecognised.push(`${SOURCES_FIELD}.${key}`);
    }
  }

  return {
    retention,
    sources,
    dialect,
    hasIndexedSources: sourcesObject !== null,
    unrecognised,
    empty: retention.length === 0 && sources.length === 0,
  };
}

export function tierDescription(tier: MemoryTier): string {
  return TIER_DESCRIPTIONS[tier];
}

// ---------------------------------------------------------------------------------- the draft

/**
 * Draft keys are dotted paths like every other panel's, and they are **stable across dialects**
 * (`retention.session`, not `retentionDays.session`). The draft is this screen's own state; the
 * field name on the wire is decided once, at the edge, by `toMemoryBody`.
 */
export function retentionDraftKey(field: string): string {
  return `retention.${field}`;
}

export function sourceDraftKey(field: string): string {
  return `${SOURCES_FIELD}.${field}`;
}

export function retentionToDraftValue(days: RetentionDays): string {
  return days === null ? RETENTION_NEVER : String(days);
}

export function retentionFromDraftValue(value: DraftValue | undefined): RetentionDays {
  if (value === RETENTION_NEVER || value === undefined) return null;
  const days = Number(value);
  return Number.isFinite(days) && days >= 0 ? Math.trunc(days) : null;
}

export function toMemoryDraft(shape: MemorySettingsShape): Draft {
  const draft: Record<string, DraftValue> = {};
  for (const row of shape.retention) {
    draft[retentionDraftKey(row.field)] = retentionToDraftValue(row.days);
  }
  for (const row of shape.sources) {
    draft[sourceDraftKey(row.field)] = row.enabled;
  }
  return draft;
}

/**
 * The full-category replacement body (A14).
 *
 * Built by **copying the served document and overwriting the rendered fields**, rather than by
 * constructing a fresh object from the contract. That order is the whole point: a key this
 * version of the SPA has never heard of survives the round trip, where a constructed body would
 * omit it and the omission would reset it to its registry default.
 */
export function toMemoryBody(
  document: unknown,
  shape: MemorySettingsShape,
  draft: Draft,
): Record<string, unknown> {
  const root = typeof document === 'object' && document !== null ? document : {};
  const body: Record<string, unknown> = { ...(root as Record<string, unknown>) };

  if (shape.dialect !== null) {
    const dialect = shape.dialect;
    const retention = { ...(objectAt(root, dialect.field) ?? {}) };
    for (const row of shape.retention) {
      const days = retentionFromDraftValue(draft[retentionDraftKey(row.field)]);
      retention[row.field] = days === null ? dialect.never : days;
    }
    body[dialect.field] = retention;
  }

  if (shape.hasIndexedSources) {
    const sources = { ...(objectAt(root, SOURCES_FIELD) ?? {}) };
    for (const row of shape.sources) {
      sources[row.field] = draft[sourceDraftKey(row.field)] === true;
    }
    body[SOURCES_FIELD] = sources;
  }

  return body;
}

// ------------------------------------------------------------------------------- consequences

export interface RetentionNarrowing {
  readonly tier: MemoryTier;
  readonly label: string;
  readonly from: RetentionDays;
  readonly to: RetentionDays;
}

export interface MemoryConsequences {
  /** Windows that got shorter — the changes that delete stored chunks. */
  readonly narrowed: readonly RetentionNarrowing[];
  /** Sources switched off — nothing is deleted, but their chunks stop answering queries. */
  readonly disabled: readonly SourceRow[];
  readonly any: boolean;
}

export const NO_CONSEQUENCES: MemoryConsequences = Object.freeze({
  narrowed: [],
  disabled: [],
  any: false,
});

/** `null` (never) is the widest window there is, so anything finite is narrower than it. */
function isNarrower(from: RetentionDays, to: RetentionDays): boolean {
  if (to === null) return false;
  if (from === null) return true;
  return to < from;
}

export function memoryConsequences(shape: MemorySettingsShape, draft: Draft): MemoryConsequences {
  const narrowed: RetentionNarrowing[] = [];
  for (const row of shape.retention) {
    const next = retentionFromDraftValue(draft[retentionDraftKey(row.field)]);
    if (isNarrower(row.days, next)) {
      narrowed.push({ tier: row.tier, label: row.label, from: row.days, to: next });
    }
  }

  const disabled = shape.sources.filter(
    (row) => row.enabled && draft[sourceDraftKey(row.field)] !== true,
  );

  return { narrowed, disabled, any: narrowed.length > 0 || disabled.length > 0 };
}

export function describeRetention(days: RetentionDays): string {
  return days === null ? 'never expire' : `${String(days)} days`;
}

/**
 * The confirm dialog's body — written before the write, never as an explanation afterwards.
 *
 * It names every tier whose window shrank with both numbers, because "are you sure?" without the
 * old value asks the operator to remember what they were replacing. The cost of undoing is stated
 * in the terms that actually apply: the chunks are gone, and getting them back means embedding
 * their sources again — time and one model call per chunk, not a database restore.
 *
 * A disabled source gets its own sentence and is deliberately **not** called a deletion. Nothing
 * is removed: the rows stay and the toggle gates retrieval as well as indexing, so the chunks
 * stop answering queries and start again when it is switched back on.
 */
export function describeMemoryConsequences(consequences: MemoryConsequences): string {
  const parts: string[] = [];

  if (consequences.narrowed.length > 0) {
    const list = consequences.narrowed
      .map(
        (entry) =>
          `${entry.label} ${describeRetention(entry.from)} → ${describeRetention(entry.to)}`,
      )
      .join('; ');
    parts.push(
      `Shortening a retention window deletes stored chunks and cannot be undone: ${list}. ` +
        'Bringing them back means re-embedding the sources they came from — a rebuild, and one ' +
        'embedding call per chunk.',
    );
  }

  if (consequences.disabled.length > 0) {
    const list = consequences.disabled.map((row) => row.label).join(', ');
    parts.push(
      `Switching a source off stops it being indexed and stops its existing chunks answering ` +
        `queries: ${list}. Nothing already indexed is deleted — switching it back on makes those ` +
        'chunks searchable again, and a backfill catches up on whatever was missed in between.',
    );
  }

  return parts.join(' ');
}
