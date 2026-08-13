import { describe, expect, it } from 'vitest';
import {
  describeScore,
  formatScore,
  HEADROOM_CEILING,
  headroom,
  MEASURED_OFF_TOPIC_CEILING,
  MEASURED_ON_TOPIC_FLOOR,
  scoreQualifier,
} from './relevance.js';

/**
 * Score presentation.
 *
 * The claim under test is the one the operator relies on: **0.55 and 0.65 must be
 * distinguishable, and neither may be dressed up as a precision the embedding does not have.**
 */

describe('the printed number', () => {
  it('is the raw cosine, to two decimals, and never a percentage', () => {
    expect(formatScore(0.6543)).toBe('0.65');
    expect(formatScore(0.552)).toBe('0.55');
    // A "65% match" would claim a probability cosine similarity is not. Nothing here multiplies.
    expect(formatScore(0.65)).not.toContain('%');
  });

  it('renders a non-finite score as an em dash rather than NaN', () => {
    expect(formatScore(Number.NaN)).toBe('—');
  });

  it('rounds rather than truncating, so 0.559 does not read as 0.55', () => {
    expect(formatScore(0.559)).toBe('0.56');
  });
});

describe('the headroom meter', () => {
  it('separates a 0.55 from a 0.65 by most of its width', () => {
    // The whole reason the meter exists. On the raw 0–1 scale these two differ by a tenth of the
    // bar and look identical; against the floor they are a fifth and nearly all of it.
    const weak = headroom(0.55, 0.52).fraction;
    const strong = headroom(0.65, 0.52).fraction;

    expect(weak).toBeLessThan(0.3);
    expect(strong).toBeGreaterThan(0.85);
    expect(strong - weak).toBeGreaterThan(0.6);
  });

  it('starts at the request floor, not at zero', () => {
    // A hit exactly on the floor has no headroom at all, which is the honest reading of "it only
    // just cleared the bar".
    expect(headroom(0.52, 0.52).fraction).toBe(0);
    expect(headroom(0.4, 0.52).fraction).toBe(0);
  });

  it('moves its origin when the operator lowers the floor', () => {
    // `minScore` is a request parameter, so the same score means something different under a
    // different floor. A meter with a fixed origin would silently contradict the caption.
    const atDefault = headroom(0.55, 0.52).fraction;
    const atZero = headroom(0.55, 0).fraction;
    expect(atZero).toBeGreaterThan(atDefault);
  });

  it('clamps at the measured ceiling and says it clamped', () => {
    expect(headroom(0.9, 0.52)).toEqual({ fraction: 1, aboveCeiling: true });
    expect(headroom(HEADROOM_CEILING, 0.52).aboveCeiling).toBe(true);
    expect(headroom(0.6, 0.52).aboveCeiling).toBe(false);
  });

  it('does not divide by zero when the floor is raised past the ceiling', () => {
    const result = headroom(0.9, 0.99);
    expect(Number.isFinite(result.fraction)).toBe(true);
    expect(result.fraction).toBeLessThanOrEqual(1);
  });
});

describe('the stated unit', () => {
  it('names both the floor and the reference, so the bar is never an unlabelled length', () => {
    const description = describeScore(0.6, 0.52);
    expect(description).toContain('0.60');
    expect(description).toContain('0.52');
    expect(description).toContain('0.66');
  });

  it('says so when a score is at or above the strongest measured on-topic hit', () => {
    expect(describeScore(0.7, 0.52)).toContain('strongest on-topic score measured');
  });
});

describe('the qualifier', () => {
  it('has two words, not three, because the whole band is 0.043 wide', () => {
    // Splitting a 0.043-wide band three ways would be false precision dressed as nuance. The one
    // boundary that is measured is where every on-topic query in the table bottomed out.
    expect(MEASURED_ON_TOPIC_FLOOR - MEASURED_OFF_TOPIC_CEILING).toBeCloseTo(0.043, 3);
    expect(scoreQualifier(MEASURED_ON_TOPIC_FLOOR)).toBe('strong');
    expect(scoreQualifier(MEASURED_ON_TOPIC_FLOOR - 0.001)).toBe('weak');
  });
});
