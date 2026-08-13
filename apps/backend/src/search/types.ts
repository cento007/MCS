/**
 * The `GET /api/v1/search` resource (TDS 04 §11), and the vocabulary it shares with the
 * five `UNION ALL` branches of TDS 03 §4.6.
 *
 * **The discriminator values are singular** — `session`, `adr`, `commit`, `message`,
 * `pull_request` — and the `?types=` query parameter accepts exactly these, nothing else
 * (§11, resolving WS7 non-blocking N17). The plural spelling was withdrawn precisely because a
 * parameter whose values differ from the discriminator they select guarantees someone
 * eventually sends one and gets the other, so there is a single list and both sides read it.
 */

/** Order is the §4.6 branch order, which is also the order branches are emitted. */
export const SEARCH_TYPES = ['session', 'adr', 'commit', 'message', 'pull_request'] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

/**
 * ⚠ **Additive to §11 — flagged, not silently invented.**
 *
 * §11's result shape is `{ type, id, title, snippet, occurredAt, rank }`, and for three of the
 * five types that is not enough to reach the thing that matched. The TDS 05 §2.2 routing map has
 * **no** `/commits/:id`, `/pull-requests/:id` or `/messages/:id` page: a commit and a pull
 * request are rendered under their Repository (which is rendered under its Project,
 * `/projects/:projectId`), and a Message is rendered inside `/sessions/:sessionId`. With `id`
 * alone, those three result types render as text a client cannot link, which makes them worse
 * than absent — a search result the operator cannot click is a search result that lies about
 * having found something.
 *
 * So each row carries the identifiers needed to build its link, and nothing else. This is the
 * same treatment `PullRequest.reviewedAt` and `PullRequest.description` got in `pull-requests/`:
 * the field exists because a stated UI purpose needs it, and the deviation is written down.
 *
 * Per type:
 *
 * | type | `projectId` | `repositoryId` | `sessionId` |
 * |---|---|---|---|
 * | `session` | the Session's Project | the Session's Repository, if any | `null` — the Session *is* `id` |
 * | `adr` | the ADR's Project | `null` | `null` |
 * | `commit` | the Repository's Project | the Repository | the Session that produced it, if any |
 * | `pull_request` | the Repository's Project | the Repository | `null` |
 * | `message` | the Session's Project | `null` | the Session that contains it |
 */
export interface SearchResultContext {
  /** The Project this result belongs to. Never null in practice — every branch has one. */
  readonly projectId: string | null;
  /** Set for `commit` and `pull_request` (and for a `session` bound to a Repository). */
  readonly repositoryId: string | null;
  /** Containment for `message`; attribution for `commit`. */
  readonly sessionId: string | null;
}

export interface SearchResultResource {
  readonly type: SearchType;
  readonly id: string;
  /**
   * **Plain text — render it as text, never as HTML.**
   *
   * It is the branch's own label, straight from the corpus: a commit *subject*, an ADR's
   * `ADR-0007 — …`, a PR's `#42 …`, the Session title, or `assistant message`. So a commit
   * subject reading `Escape <img src=x …> in the renderer` arrives with those characters
   * intact, which is correct — escaping here would show the operator `&lt;img` — and is safe in
   * any renderer that escapes text by default (React's `{title}` does).
   *
   * `snippet` is the one field with the opposite contract, and the asymmetry is deliberate:
   * exactly one field in this resource carries markup, and it is the one that had to.
   */
  readonly title: string;
  /**
   * **HTML — and `<mark>`/`</mark>` are the only tags it can contain.**
   *
   * It has to be HTML: `<mark>` around the matched terms is what §11 promises and what makes a
   * snippet a snippet. Everything from the corpus is escaped first, so that promise is also the
   * bound. See `highlight.ts` — PostgreSQL highlights with a private sentinel, the whole
   * headline is escaped, and the escaped sentinel is what becomes `<mark>`.
   */
  readonly snippet: string;
  readonly occurredAt: string;
  /**
   * `ts_rank_cd(search_tsv, query, 32)` — cover density with normalization flag `32`
   * (`rank/(rank+1)`), so every value is in `(0,1)` and ranks from different entity types are
   * directly comparable. That comparability is the whole reason one ordered list across five
   * tables is meaningful (§4.6, §11).
   */
  readonly rank: number;
  readonly context: SearchResultContext;
}
