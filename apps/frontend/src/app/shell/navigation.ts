/**
 * The navigation model (TDS 06 §3.1, §3.2; TDS 05 §2.2).
 *
 * One table, three renderings: the desktop nav rail, the mobile bottom bar + `More` sheet,
 * and the `Ctrl+K` palette's navigation entries. A second hard-coded list somewhere is how
 * a route ends up reachable from the palette but missing from the rail.
 */

export interface NavItem {
  readonly to: string;
  readonly label: string;
  /** Text glyph — the wireframes' vocabulary; no icon dependency in V1. */
  readonly glyph: string;
  /**
   * Phase-gated destinations render a full-contrast label plus a muted `P3`/`P4` badge and
   * route to a placeholder shell. They are NEVER `disabled` and never dimmed to
   * `--color-text-disabled` (TDS 06 §2.5) — the target is focusable and it does something.
   */
  readonly phase?: 3 | 4;
  /** Shown in the mobile bottom bar; everything else lives behind `More`. */
  readonly mobilePrimary?: boolean;
  /** `g …` sequence that jumps here (TDS 06 §4.6). */
  readonly sequence?: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Dashboard', glyph: '◧', mobilePrimary: true, sequence: 'g d' },
  { to: '/projects', label: 'Projects', glyph: '▤', mobilePrimary: true, sequence: 'g p' },
  { to: '/sessions', label: 'Sessions', glyph: '▶', mobilePrimary: true, sequence: 'g s' },
  { to: '/adrs', label: 'ADRs', glyph: '▣', sequence: 'g r' },
  { to: '/memory', label: 'Memory', glyph: '◌', phase: 3, sequence: 'g m' },
  { to: '/agents', label: 'Agents', glyph: '◌', phase: 4, sequence: 'g e' },
  { to: '/settings/general', label: 'Settings', glyph: '⚙', sequence: 'g ,' },
];

/** PRD §4.4 categories, in that order (TDS 05 §7.1). */
export const SETTINGS_CATEGORIES = [
  'general',
  'integrations',
  'notifications',
  'memory',
  'agents',
  'security',
  'services',
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

export function isSettingsCategory(value: string): value is SettingsCategory {
  return (SETTINGS_CATEGORIES as readonly string[]).includes(value);
}

export const SETTINGS_CATEGORY_PHASE: Readonly<Partial<Record<SettingsCategory, 3 | 4>>> = {
  memory: 3,
  agents: 4,
};

export function settingsCategoryLabel(category: string): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}
