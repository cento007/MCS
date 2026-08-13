/**
 * How a relevance score is shown, and why it is shown that way.
 *
 * The Backend's `DEFAULT_MIN_SCORE` records a measured score table over 758 chunks of this
 * repository's own content, embedded with `nomic-embed-text`:
 *
 *   on-topic queries bottom out at **0.552**; off-topic ones top out at **0.509**.
 *
 * The whole usable band is therefore **0.043 wide**, and it sits at the top of the cosine scale
 * because Ollama's `/api/embed` applies neither of the `search_query:` / `search_document:`
 * prefixes `nomic-embed-text` was trained for. Two presentations follow directly from that:
 *
 * **1. The number is printed raw, to two decimals, and never as a percentage.** `0.65` is what
 * the store returned. A "65% match" would claim a probability that cosine similarity is not, and
 * rescaling the 0–1 range to 0–100% would put every honest answer this system can produce between
 * 52 and 66 — a bar that is always two-thirds full, which tells the operator nothing. Three
 * decimals were rejected for the opposite failure: at 0.043 of total separation, a 0.001 gap
 * between two hits invites a comparison the embedding cannot support.
 *
 * **2. Distance is shown against the floor, not against zero.** The meter below maps
 * `minScore → HEADROOM_CEILING` onto 0–100%, so with the default floor a 0.55 renders about a
 * fifth full and a 0.65 nearly full — the discrimination the raw scale refuses to give. The
 * ceiling is `0.66`, the highest score in that same measured table, so the meter has a stated
 * unit ("as far above the floor as the best on-topic hit ever observed") rather than an invented
 * one. It is a *reference*, not a maximum: a score above it clamps full and the caller marks it.
 *
 * Both are captioned on screen with the floor that produced them, because the floor is a request
 * parameter — an operator who lowers it to 0 must see that the bar's origin moved with it.
 */

/**
 * The top of the measured on-topic band (`DEFAULT_MIN_SCORE`'s table: 0.660 for "How do
 * WebSocket clients recover after the relay drops?").
 *
 * Not a maximum a score cannot exceed — it is the reference the headroom meter is drawn against.
 */
export const HEADROOM_CEILING = 0.66;

/**
 * The Backend's `DEFAULT_MIN_SCORE`, mirrored for **annotation only**.
 *
 * The client never sends it: omitting `minScore` from the request is what selects the default,
 * and every response echoes the floor it actually used. This copy exists so an operator looking
 * at an overridden floor can see what they overrode — a response produced under an override
 * cannot tell them, because `minScore` comes back as the override. If the Backend ever moves its
 * default, this annotation goes stale and nothing else does.
 */
export const DEFAULT_MIN_SCORE = 0.52;

/**
 * The lowest score any on-topic query in that table produced (0.552), and the highest any
 * off-topic one did (0.509). Exported so the screen can state the band it is drawing rather than
 * asserting a confidence it measured nothing for.
 */
export const MEASURED_ON_TOPIC_FLOOR = 0.552;
export const MEASURED_OFF_TOPIC_CEILING = 0.509;

/**
 * A degenerate span guard. An operator may raise `minScore` above `HEADROOM_CEILING`, at which
 * point the meter has no width; it gets a nominal one rather than dividing by zero and rendering
 * every hit as either 0% or 100%.
 */
const MIN_SPAN = 0.02;

/** The raw cosine, two decimals. The only number this screen prints for a score. */
export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return '—';
  return score.toFixed(2);
}

export interface Headroom {
  /** 0–1 position between the request's floor and `HEADROOM_CEILING`, clamped. */
  readonly fraction: number;
  /** True when the score is at or above the reference ceiling — the meter reads full. */
  readonly aboveCeiling: boolean;
}

export function headroom(score: number, minScore: number): Headroom {
  if (!Number.isFinite(score)) return { fraction: 0, aboveCeiling: false };
  const span = Math.max(HEADROOM_CEILING - minScore, MIN_SPAN);
  const raw = (score - minScore) / span;
  return {
    fraction: Math.min(1, Math.max(0, raw)),
    aboveCeiling: score >= HEADROOM_CEILING,
  };
}

/**
 * The sentence behind the meter — its `title` and its accessible name.
 *
 * It names the floor and the reference explicitly, because a bar with no stated unit is exactly
 * the false precision this module exists to avoid. Colour and length are never the only channel:
 * the raw score sits beside the meter as text.
 */
export function describeScore(score: number, minScore: number): string {
  const { aboveCeiling } = headroom(score, minScore);
  return (
    `Cosine similarity ${formatScore(score)}, against a floor of ${minScore.toFixed(2)}. ` +
    (aboveCeiling
      ? `At or above ${HEADROOM_CEILING.toFixed(2)} — the strongest on-topic score measured for this corpus.`
      : `The bar shows how far above the floor it sits, relative to ${HEADROOM_CEILING.toFixed(2)}.`)
  );
}

/**
 * A one-word qualifier, used only where a number cannot be read at a glance (the palette hint
 * and the `aria-label` of a rank marker).
 *
 * Three words for a 0.043-wide band would be false precision, so there are **two**, and the
 * boundary is the one measured fact available: `MEASURED_ON_TOPIC_FLOOR`. Above it, every
 * on-topic query in the table scored at least this well. Below it — but still above the floor —
 * the honest word is "weak", not "poor": the chunk cleared the floor, and the floor is what the
 * operator set.
 */
export function scoreQualifier(score: number): 'strong' | 'weak' {
  return score >= MEASURED_ON_TOPIC_FLOOR ? 'strong' : 'weak';
}
