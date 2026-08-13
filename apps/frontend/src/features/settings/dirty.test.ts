import { describe, expect, it } from 'vitest';
import {
  changeCountLabel,
  changedFieldNames,
  changedSecretNames,
  isSameValue,
  summarizeDirty,
  unsavedChangesMessage,
} from './dirty.js';

/**
 * The dirty-state contract (TDS 06 §5.7, §4.4), asserted without a DOM.
 *
 * The wording is the feature here, not decoration: "3 changes" is what tells an operator how
 * much `[Discard]` is about to destroy, and "(incl. 1 secret)" is what tells them that some of
 * it cannot be reconstructed by looking at the screen.
 */

describe('isSameValue', () => {
  it('compares arrays element-wise and order-sensitively', () => {
    expect(isSameValue(['a', 'b'], ['a', 'b'])).toBe(true);
    // Discovery roots are scanned in order, so a reorder is a real change.
    expect(isSameValue(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(isSameValue(['a'], ['a', 'b'])).toBe(false);
  });

  it('does not treat an array and a scalar as equal', () => {
    expect(isSameValue(['a'], 'a')).toBe(false);
  });

  it('is stable for a half-typed number input', () => {
    // `Object.is(NaN, NaN)` is true — `===` would report the field changed on every render.
    expect(isSameValue(Number.NaN, Number.NaN)).toBe(true);
  });
});

describe('changedFieldNames', () => {
  it('names only the fields that differ', () => {
    expect(
      changedFieldNames(
        { instanceName: 'a', timezone: 'UTC' },
        { instanceName: 'b', timezone: 'UTC' },
      ),
    ).toEqual(['instanceName']);
  });

  it('reports a field the server stopped returning rather than dropping it from the count', () => {
    expect(changedFieldNames({ removed: 'x' }, {})).toEqual(['removed']);
  });
});

describe('changedSecretNames', () => {
  it('does not count an unlocked but empty secret input', () => {
    // `[Replace]` on its own has changed nothing; counting it would make `[Discard]` claim to
    // be discarding something that does not exist.
    expect(changedSecretNames({ token: { replacing: true, value: '' } })).toEqual([]);
  });

  it('counts a secret carrying typed replacement content', () => {
    expect(changedSecretNames({ token: { replacing: true, value: 'ghp_x' } })).toEqual(['token']);
  });

  it('does not count a locked secret', () => {
    expect(changedSecretNames({ token: { replacing: false, value: 'stale' } })).toEqual([]);
  });
});

describe('changeCountLabel', () => {
  const summary = (fields: string[], secrets: string[] = []) =>
    summarizeDirty(
      Object.fromEntries(fields.map((name) => [name, 'before'])),
      Object.fromEntries(fields.map((name) => [name, 'after'])),
      Object.fromEntries(secrets.map((name) => [name, { replacing: true, value: 'typed' }])),
    );

  it('is empty on a clean panel', () => {
    expect(changeCountLabel(summarizeDirty({ a: '1' }, { a: '1' }))).toBe('');
  });

  it('is singular for one change', () => {
    expect(changeCountLabel(summary(['a']))).toBe('1 change');
  });

  it('counts plural changes', () => {
    expect(changeCountLabel(summary(['a', 'b', 'c']))).toBe('3 changes');
  });

  it('calls out secrets, because a discarded secret cannot be re-read from the screen', () => {
    expect(changeCountLabel(summary(['a', 'b'], ['token']))).toBe('3 changes (incl. 1 secret)');
    expect(changeCountLabel(summary([], ['token']))).toBe('1 change (incl. 1 secret)');
    expect(changeCountLabel(summary([], ['token', 'apiKey']))).toBe('2 changes (incl. 2 secrets)');
  });
});

describe('unsavedChangesMessage', () => {
  it('names the single dirty panel verbatim, as §5.7 words it', () => {
    expect(
      unsavedChangesMessage([
        {
          panelId: 'integrations.github',
          label: 'Integrations → GitHub',
          count: 3,
          secretCount: 0,
        },
      ]),
    ).toBe('You have 3 unsaved changes in Integrations → GitHub.');
  });

  it('is singular for one change', () => {
    expect(
      unsavedChangesMessage([{ panelId: 'general', label: 'General', count: 1, secretCount: 0 }]),
    ).toBe('You have 1 unsaved change in General.');
  });

  it('names every dirty panel when the Integrations cards disagree', () => {
    // The wireframe assumes one panel at a time; six independently-savable integration cards
    // mean two can be dirty at once, and the modal must not name only one of them.
    expect(
      unsavedChangesMessage([
        {
          panelId: 'integrations.github',
          label: 'Integrations → GitHub',
          count: 2,
          secretCount: 1,
        },
        {
          panelId: 'integrations.telegram',
          label: 'Integrations → Telegram',
          count: 1,
          secretCount: 0,
        },
      ]),
    ).toBe(
      'You have 3 unsaved changes across 2 panels: Integrations → GitHub, Integrations → Telegram.',
    );
  });
});
