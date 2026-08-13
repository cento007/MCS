/**
 * Presentation formatting (TDS 05 §2.1 `lib/format`).
 *
 * Every timestamp on the wire is ISO 8601 UTC with a `Z` (F4.2); every timestamp on screen
 * is the operator's local time. That conversion happens here and nowhere else, so there is
 * one place to look when a time reads wrong.
 */

/** `HH:MM` in local time — the "last updated" affordance of TDS 06 §3.3. */
export function formatClock(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  if (date === null) return '—';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** `HH:MM:SS` in local time — the chip tooltip's `last update` line (§3.3). */
export function formatClockSeconds(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  if (date === null) return '—';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Full local date-time for detail headers and tooltips. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  if (date === null) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * `HH:MM:SS` elapsed. Always three fields — a duration column that switches between `4:21`
 * and `1:04:21` is unscannable in a table, which is the surface this mostly appears in.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(total % 60)}`;
}

/**
 * A duration the client can no longer verify (TDS 06 §3.3).
 *
 * The `~` is not decoration: while the socket is not `live`, a counter that keeps
 * incrementing renders as though the Session were confirmed alive when the truth is
 * unknown. Freezing it and marking it last-known is the honest rendering.
 */
export function formatFrozenDuration(seconds: number | null | undefined): string {
  const text = formatDuration(seconds);
  return text === '—' ? text : `~${text}`;
}

/** Costs are mono and four-decimal everywhere (TDS 06 §2.2.3): `$0.4821`. */
export function formatCostUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `$${value.toFixed(4)}`;
}

/**
 * Budget-scale money: `$3.42`, `$10.00` — two decimals, never four.
 *
 * Distinct from `formatCostUsd` on purpose. A *per-Session* cost is a small number where the
 * fourth decimal is real information (`$0.4821`), but a daily total sits beside a budget the
 * operator typed as `10.00`, and rendering `$3.4200 of $10.0000` invites them to read the
 * fourth decimal as precision that the comparison does not have. Same money, two scales
 * (TDS 06 §5.2 renders `‹$3.42› of ‹$10.00›`).
 */
export function formatMoneyUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `$${value.toFixed(2)}`;
}

/** Compact token counts for dense rows: `1.2k`, `934`, `3.4M`. */
export function formatTokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/**
 * Byte counts for generated documents: `812 B`, `47.3 KB`, `1.2 MB`.
 *
 * Binary units on purpose (`utf8Bytes` on the Backend counts bytes, and the operator is judging
 * whether a document will fit somewhere), and one decimal above the kilobyte because the whole
 * point of showing it beside a token estimate is that this number is the *exact* one.
 */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const bytes = Math.max(0, value);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Session identity (TDS 05 §9.3): **never lead with a UUIDv7 prefix.** The leading hex of a
 * UUIDv7 encodes a millisecond timestamp, so every Session started in the same hour shares
 * a near-identical prefix — precisely the least discriminating substring available. The
 * last six characters are random and therefore actually distinguishing.
 */
export function sessionIdTail(id: string): string {
  return id.length <= 6 ? id : `…${id.slice(-6)}`;
}

/**
 * The display label for a Session. The Backend derives `title` from the first user prompt
 * inside the same transaction that persists it (A13), but a freshly-created, prompt-less
 * Session has none — so no surface ever renders blank.
 */
export function sessionLabel(session: { id: string; title: string | null }): string {
  const title = session.title?.trim() ?? '';
  return title.length > 0 ? title : `Untitled session · ${sessionIdTail(session.id)}`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
