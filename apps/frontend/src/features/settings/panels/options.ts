import type { SelectOption } from '../components/Field.js';

/**
 * The closed option lists the Settings selects offer (TDS 06 §5.7.3, §5.7.6, §5.7.11).
 *
 * They are shared so two panels cannot end up offering different interval ladders for the same
 * concept, and they are written as `{ value, label }` rather than derived from numbers so the
 * `0 = manual only` case can carry the words that make it comprehensible — §7.7 reads
 * `syncIntervalMinutes > 0` as "scheduled", and an operator picking "0 minutes" from a numeric
 * ladder would have no way to know they had just turned polling off.
 */

export const SYNC_INTERVAL_OPTIONS: readonly SelectOption[] = [
  { value: '0', label: 'Manual only (no polling)' },
  { value: '5', label: '5 minutes' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
  { value: '360', label: '6 hours' },
  { value: '1440', label: '24 hours' },
];

/** WS5 §5.7.11 renders "7 days" as the default. */
export const SESSION_TIMEOUT_OPTIONS: readonly SelectOption[] = [
  { value: '60', label: '1 hour' },
  { value: '480', label: '8 hours' },
  { value: '1440', label: '1 day' },
  { value: '10080', label: '7 days' },
  { value: '43200', label: '30 days' },
];

export const AUDIT_RETENTION_OPTIONS: readonly SelectOption[] = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
  { value: '365', label: '365 days' },
  { value: '0', label: 'Keep forever' },
];

export const ALERT_THRESHOLD_OPTIONS: readonly SelectOption[] = [
  { value: '50', label: '50' },
  { value: '60', label: '60' },
  { value: '70', label: '70' },
  { value: '80', label: '80' },
  { value: '90', label: '90' },
  { value: '100', label: '100' },
];
