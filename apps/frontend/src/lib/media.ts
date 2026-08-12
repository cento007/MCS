import { useEffect, useState } from 'react';

/**
 * Media queries as state (TDS 05 §6.7's responsive collapse table, §9.2).
 *
 * Defensive by construction: `window.matchMedia` is not guaranteed to exist in every
 * environment this code runs in (the unit tier's DOM among them), and a layout hook that
 * throws takes the whole route down. When it is absent the hook reports `false`, which lands
 * every consumer on its widest, most capable layout — the safe direction to fail, because the
 * alternative is hiding a panel on a machine that has room for it.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => evaluate(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    setMatches(list.matches);

    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    }
    return undefined;
  }, [query]);

  return matches;
}

function evaluate(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** The three breakpoints §6.7 names for the Session right panel. */
export const PANEL_BREAKPOINTS = {
  /** ≥ 1440 px — expanded by default. */
  wide: '(min-width: 1440px)',
  /** < 1024 px — no rail; the panel becomes a swipe-up sheet. */
  mobile: '(max-width: 1023px)',
} as const;
