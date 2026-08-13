import { adrNumberLabel } from '@mc/shared';

/**
 * Drafting an ADR from a Session — **deterministic, assembled from session data**.
 *
 * ## The choice, stated plainly
 *
 * TDS 04 §9 calls this an "AI-drafted ADR". This implementation is **not** model-assisted, and
 * the reason is structural rather than a preference:
 *
 *  - The Agent SDK seam is `AgentRuntimePort`, embedded in the **Backend** (F1.5: "the Claude
 *    Agent SDK … embedded in the Backend"). This job runs in the **Sync Worker**, which may
 *    not call the Backend over HTTP (F2.2) and must not open a second SDK entry point — that
 *    would be a second place that spawns Claude processes, a second cost source outside the
 *    canonical `ResultMessage` accounting (F1.5), and a second thing to reason about when the
 *    concurrency limit is reached (TDS 02 §4.3).
 *  - Moving the drafting into the Backend to reach the SDK would contradict §9, which puts the
 *    producer in the Sync Worker, and would put a multi-second model call inside the request or
 *    inside the process that streams live sessions.
 *
 * So V1 assembles the draft from what the session actually recorded, and the honest sections
 * say what they are. This is not a lesser outcome than a model would give for two of the four
 * sections — Context and Consequences are *evidence*, and evidence is exactly what the database
 * has — while the two it cannot know (Decision rationale, Alternatives) are marked for the
 * operator instead of being invented. An ADR containing a plausible fabricated "Alternatives
 * considered" is worse than one containing an empty one, because only the empty one tells the
 * truth about what was recorded.
 *
 * The result is `proposed` (TDS 04 §9 / arbitration A4 — there is no `draft` status), which is
 * precisely the state "drafted, awaiting review" is supposed to be represented by.
 *
 * **The seam is left open.** If a later phase wants a model-assisted draft, the shape to add is
 * a `AdrDraftPort` implemented in the Backend behind the existing `AgentRuntimePort`, with this
 * function as its fallback — not a second SDK client in this process.
 */

export interface SessionEvidence {
  readonly sessionId: string;
  readonly title: string | null;
  readonly state: string;
  readonly sessionType: string;
  readonly runtime: string;
  readonly model: string | null;
  readonly branch: string | null;
  readonly workingDir: string | null;
  readonly projectName: string | null;
  readonly repositoryName: string | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly durationMs: number | null;
  readonly numTurns: number | null;
  readonly totalCostUsd: string | null;
  readonly failureReason: string | null;
  /** Operator prompts in order, bounded and truncated by the reader. */
  readonly prompts: readonly string[];
  readonly promptsTotal: number;
  /** The last non-empty assistant message. */
  readonly outcome: string | null;
  readonly files: readonly string[];
  readonly filesTotal: number;
}

export interface AdrDraft {
  readonly title: string;
  readonly context: string;
  readonly decision: string;
  readonly alternatives: string;
  readonly consequences: string;
}

/** Matches `ck_adrs_title_length`. */
const MAX_TITLE_LENGTH = 300;

const NEEDS_OPERATOR =
  '> [!todo] Fill this in before accepting.\n> This section was not derived automatically — see below for why.';

export function draftAdrFromSession(evidence: SessionEvidence): AdrDraft {
  return {
    title: draftTitle(evidence),
    context: draftContext(evidence),
    decision: draftDecision(evidence),
    alternatives: draftAlternatives(),
    consequences: draftConsequences(evidence),
  };
}

function draftTitle(evidence: SessionEvidence): string {
  const title = evidence.title?.trim() ?? '';
  if (title.length === 0) return `Decision from session ${evidence.sessionId.slice(0, 8)}`;
  return title.slice(0, MAX_TITLE_LENGTH);
}

/**
 * Context is evidence: what ran, where, and what the operator asked for. The prompts are
 * quoted verbatim rather than summarised — a summary is the part that needs a model, and a
 * wrong one here would misrepresent what the operator actually said.
 */
function draftContext(evidence: SessionEvidence): string {
  const lines: string[] = [
    `Drafted from session \`${evidence.sessionId}\` (${evidence.sessionType}, ${evidence.runtime}).`,
    '',
  ];

  const facts = [
    fact('Project', evidence.projectName),
    fact('Repository', evidence.repositoryName),
    fact('Branch', evidence.branch),
    fact('Working directory', evidence.workingDir),
    fact('Model', evidence.model),
    fact('Started', evidence.startedAt?.toISOString() ?? null),
    fact('Completed', evidence.completedAt?.toISOString() ?? null),
    fact('Turns', evidence.numTurns === null ? null : String(evidence.numTurns)),
    fact('Cost', evidence.totalCostUsd === null ? null : `$${evidence.totalCostUsd}`),
    fact('Session outcome', evidence.state),
    fact('Failure reason', evidence.failureReason),
  ].filter((line): line is string => line !== null);

  lines.push(...facts);

  if (evidence.prompts.length > 0) {
    lines.push('', '**What was asked**', '');
    for (const prompt of evidence.prompts) lines.push(quote(prompt), '');
    if (evidence.promptsTotal > evidence.prompts.length) {
      lines.push(
        `_${evidence.promptsTotal - evidence.prompts.length} further prompt(s) are in the session and were not copied here._`,
        '',
      );
    }
  }

  return lines.join('\n').trim();
}

/**
 * The session's last assistant message is the closest thing the transcript has to a statement
 * of what was done. It is labelled as such — "the session concluded", not "the decision is" —
 * because a summary of work is not automatically a decision, and pretending otherwise is how
 * an ADR ends up asserting something nobody decided.
 */
function draftDecision(evidence: SessionEvidence): string {
  if (evidence.outcome === null || evidence.outcome.trim().length === 0) {
    return `${NEEDS_OPERATOR}\n\n_The session recorded no assistant response to draw a decision from._`;
  }

  return [
    NEEDS_OPERATOR,
    '',
    '_Below is how the session concluded, copied verbatim. State the decision itself above it._',
    '',
    '---',
    '',
    evidence.outcome.trim(),
  ].join('\n');
}

function draftAlternatives(): string {
  return [
    NEEDS_OPERATOR,
    '',
    '_Alternatives are not recoverable from a session transcript: options that were considered',
    'and dropped rarely appear in it, and inferring them would be invention rather than record._',
  ].join('\n');
}

/**
 * The files a session touched are a real, checkable consequence, so they are listed. Everything
 * else about consequences is judgement and is left to the operator.
 */
function draftConsequences(evidence: SessionEvidence): string {
  const lines: string[] = [NEEDS_OPERATOR, ''];

  if (evidence.files.length === 0) {
    lines.push('_The session touched no files that Mission Control recorded._');
    return lines.join('\n');
  }

  lines.push('**Files this session touched**', '');
  for (const file of evidence.files) lines.push(`- \`${file}\``);
  if (evidence.filesTotal > evidence.files.length) {
    lines.push(`- _…and ${evidence.filesTotal - evidence.files.length} more._`);
  }

  return lines.join('\n');
}

function fact(label: string, value: string | null): string | null {
  if (value === null || value.trim().length === 0) return null;
  return `- **${label}:** ${value}`;
}

function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** Re-exported so log lines can name the ADR the way the operator sees it. */
export { adrNumberLabel };
