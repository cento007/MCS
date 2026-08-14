import { Buffer } from 'node:buffer';
import {
  type AgentWorkflowHandoffState,
  MAX_AGENT_WORKFLOW_PROMPT_BYTES,
  utf8Bytes,
} from '@mc/shared';

/**
 * **The hand-off.** What step N+1 receives from step N, and the reason this slice is worth
 * building at all: QA cannot review what it cannot see.
 *
 * ## Reuse, not invention
 *
 * The document handed forward is the **context package**
 * (`POST /api/v1/sessions/{id}/context-package`, TDS 04 §6.7), unchanged. Phase 3 built it for
 * "someone resuming abandoned work", which is the same problem viewed from one step earlier, and
 * it already carries every fact a reviewer needs: where the previous step left off, what the
 * operator asked, the last thing the assistant said, **the working tree as of now** (the one fact
 * that is in no transcript), the files touched, the commits, the ADRs already recorded, and
 * related work from semantic memory. Writing a second document would have meant a second set of
 * bounds, a second truncation policy and a second chance to omit something quietly.
 *
 * ## The rule the package already follows, and this file inherits: do not invent
 *
 * Nothing here summarises, infers or generates. There is no model in this path — the runner is
 * plumbing — so a "summary of what the Developer did" could only be assembled by string-joining,
 * which is the fabrication `apps/sync-worker/src/adr-draft.ts` settled against and `package.ts`
 * refuses in the same words.
 *
 * The consequence is the whole of `describeGap` below: **when the hand-off is incomplete, the
 * next step is told.** A prompt that silently lacked the previous step's work would produce a QA
 * review of nothing, phrased with total confidence, and neither the agent nor the operator would
 * have any way to know. So every degraded arm renders a callout naming the reason, and the same
 * reason is stored on the attempt row (`handoff_state = 'degraded'`, `handoff_reason`) so a UI can
 * badge it without parsing prose.
 *
 * Pure and exported so the unit tier can exercise every arm — first step, whole package, memory
 * degraded, package unavailable, prompt over the byte ceiling — with no database, no git and no
 * embedder. A branch that can only be reached by turning a real service off is a branch that will
 * not be tested.
 */

/** What the previous step left, or why it could not be read. */
export type PreviousStep =
  | {
      readonly kind: 'package';
      readonly agentName: string;
      readonly sessionId: string;
      readonly content: string;
      /** `RelatedGapReason` from the package, or `null` when semantic memory answered. */
      readonly gapReason: string | null;
      readonly gapDetail: string | null;
    }
  | {
      readonly kind: 'unavailable';
      readonly agentName: string;
      readonly sessionId: string;
      /** A short machine reason — stored on the attempt row and rendered in the callout. */
      readonly reason: string;
      readonly detail: string;
    };

export interface HandoffInput {
  readonly workflowName: string;
  /** 0-based, as stored. Rendered 1-based, because operators and agents count from one. */
  readonly stepOrdinal: number;
  readonly stepCount: number;
  readonly agentName: string;
  readonly runTask: string;
  readonly stepInstructions: string | null;
  /** `null` for the first step — which is not a degradation, and must not read as one. */
  readonly previous: PreviousStep | null;
}

export interface HandoffResult {
  readonly prompt: string;
  readonly state: AgentWorkflowHandoffState;
  /** Non-null iff `state === 'degraded'`, matching `ck_agent_workflow_run_steps_handoff`. */
  readonly reason: string | null;
  readonly bytes: number;
}

/**
 * Three of the eight `RelatedGapReason` values are **not degradations**, and getting this line
 * wrong in either direction breaks the flag.
 *
 * `below_threshold` means memory was searched and nothing prior was close enough — `package.ts`
 * says so in as many words ("That is a real answer: no comparable prior work was found").
 * `only_own_session` means every match was the previous step's own transcript, which the package
 * excludes because that work is already in the document. Neither leaves the next step short of
 * anything.
 *
 * **`not_configured` is the interesting one, and it is deliberately on this list.** It means this
 * install has never switched semantic memory on — a property of the machine, not of this hand-off.
 * Counting it would badge *every* step of *every* run on a Phase-1-shaped install as degraded,
 * and a flag whose value never varies tells an operator nothing: it is
 * `integrations.ollama.enabled` in a different costume. The agent is still told, because the
 * package renders its own callout inside the document either way; what it does not do is claim
 * that something went wrong.
 *
 * Everything else — Ollama down, a stamp mismatch, an empty index, a timeout, no query — means
 * memory *was* switched on and did not answer. That is a real difference between this run and the
 * last one on the same machine, so it degrades and the reason is recorded.
 */
const NON_DEGRADING_GAPS: ReadonlySet<string> = new Set([
  'below_threshold',
  'only_own_session',
  'not_configured',
]);

export function isDegradingGap(reason: string | null): boolean {
  return reason !== null && !NON_DEGRADING_GAPS.has(reason);
}

/**
 * Build the prompt for one step, and classify how complete it is.
 *
 * The prompt is assembled in a fixed order — task, step brief, hand-off, protocol — so an agent
 * reading two consecutive steps sees the same document twice with different contents, rather than
 * a different document each time.
 */
export function buildHandoff(input: HandoffInput): HandoffResult {
  const position = `${String(input.stepOrdinal + 1)} of ${String(input.stepCount)}`;

  const header = [
    `# ${input.workflowName} — step ${position}`,
    '',
    `You are running as **${input.agentName}**, step ${position} of a Mission Control agent ` +
      'workflow. Each step is its own Claude Code session; when this session ends, the next step ' +
      'receives a record of what you did, assembled from what Mission Control observed.',
  ].join('\n');

  const task = ['## The operator’s task', '', input.runTask].join('\n');

  const brief = [
    '## Your step',
    '',
    input.stepInstructions ??
      '_This step carries no standing instructions. Your persona and the task above are the ' +
        'whole brief._',
  ].join('\n');

  const handoff = renderHandoff(input.previous);

  const protocolLines = [
    '## When you are done',
    '',
    'Say what you did and what you did **not** do. Do not describe work you did not perform — ',
    'the next step is given a record assembled from this session, and an inaccurate summary here ',
    'becomes an inaccurate brief there.',
  ];
  if (input.stepOrdinal + 1 < input.stepCount) {
    protocolLines.push(
      '',
      `This is step ${position}: when the operator ends this session, the next step starts ` +
        'automatically with a record of your work.',
    );
  } else {
    protocolLines.push('', 'This is the final step in the chain.');
  }

  const body = [header, task, brief, handoff.section, protocolLines.join('')].join('\n\n');

  const fitted = fitToPromptLimit(body, handoff);

  return {
    prompt: fitted.prompt,
    state: fitted.state,
    reason: fitted.reason,
    bytes: utf8Bytes(fitted.prompt),
  };
}

interface RenderedHandoff {
  readonly section: string;
  readonly state: AgentWorkflowHandoffState;
  readonly reason: string | null;
  /** The package body, when there is one — the only part truncation is allowed to touch. */
  readonly content: string | null;
}

function renderHandoff(previous: PreviousStep | null): RenderedHandoff {
  if (previous === null) {
    return {
      section: [
        '## Hand-off from the previous step',
        '',
        '_You are the first step in this chain. There is no previous step and no prior work to ' +
          'review — start from the task above._',
      ].join('\n'),
      state: 'none',
      reason: null,
      content: null,
    };
  }

  if (previous.kind === 'unavailable') {
    return {
      section: [
        '## Hand-off from the previous step',
        '',
        `> [!warning] The record of the previous step could not be assembled — \`${previous.reason}\``,
        `> ${previous.detail}`,
        '>',
        `> The previous step ran as **${previous.agentName}** in session \`${previous.sessionId}\`.`,
        '> **You have not been shown its work.** Do not assume what it did. Inspect the working ',
        '> tree and the repository yourself, and say plainly in your reply that the hand-off was ',
        '> missing.',
      ].join('\n'),
      state: 'degraded',
      reason: previous.reason,
      content: null,
    };
  }

  const degrading = isDegradingGap(previous.gapReason);
  const lines = [
    '## Hand-off from the previous step',
    '',
    `_Assembled by Mission Control from what session \`${previous.sessionId}\` recorded, running ` +
      `as **${previous.agentName}**. Nothing in it is summarised or inferred; a section with no ` +
      'source says so._',
  ];

  if (degrading && previous.gapReason !== null) {
    lines.push(
      '',
      `> [!warning] Part of this record is missing — \`${previous.gapReason}\``,
      `> ${previous.gapDetail ?? 'Related context from earlier work could not be retrieved.'}`,
      '>',
      '> Everything else below was produced normally.',
    );
  }

  lines.push('', '---', '', previous.content);

  return {
    section: lines.join('\n'),
    state: degrading ? 'degraded' : 'full',
    reason: degrading ? previous.gapReason : null,
    content: previous.content,
  };
}

/**
 * The prompt fits what `POST /sessions/{id}/prompts` will accept (TDS 04 §6.4, 256 KiB), and
 * `ck_agent_workflow_run_steps_prompt_bytes` refuses a stored one that does not.
 *
 * A context package is bounded (`evidence.ts`: 12 prompts × 4 000 chars, 200 files, 200 commits,
 * six memory excerpts) so this is not the common path — but "bounded" and "under 256 KiB" are two
 * different claims, and the one that matters here is the second. When it bites, the **package** is
 * cut and nothing else is: the task, the step brief and the protocol are what make the prompt
 * intelligible at all, and a truncation that removed them would leave the agent with evidence and
 * no instruction.
 *
 * The cut is announced in place and the attempt is recorded `degraded`, because a silently
 * shortened record is exactly the plausible-looking gap this module exists to prevent.
 */
function fitToPromptLimit(
  body: string,
  handoff: RenderedHandoff,
): { prompt: string; state: AgentWorkflowHandoffState; reason: string | null } {
  if (utf8Bytes(body) <= MAX_AGENT_WORKFLOW_PROMPT_BYTES) {
    return { prompt: body, state: handoff.state, reason: handoff.reason };
  }

  const notice =
    '\n\n_[The record of the previous step was cut here: it exceeded the prompt limit. ' +
    'What follows this point was not sent. Ask the operator for the full context package if you ' +
    'need it.]_';

  const content = handoff.content;
  if (content === null) {
    // No package to cut — the task alone is over the limit. The route would refuse this anyway;
    // cutting the tail keeps the failure comprehensible instead of a 413 with no document.
    return {
      prompt: truncateToBytes(body, MAX_AGENT_WORKFLOW_PROMPT_BYTES - utf8Bytes(notice)) + notice,
      state: 'degraded',
      reason: 'prompt_truncated',
    };
  }

  const overflow = utf8Bytes(body) - MAX_AGENT_WORKFLOW_PROMPT_BYTES + utf8Bytes(notice);
  const keep = Math.max(0, utf8Bytes(content) - overflow);
  const trimmed = truncateToBytes(content, keep) + notice;

  return {
    prompt: body.replace(content, trimmed),
    state: 'degraded',
    reason: 'handoff_truncated',
  };
}

/**
 * Cut to a byte budget without splitting a UTF-8 sequence.
 *
 * `Buffer.subarray` + `toString('utf8')` would leave a replacement character at the seam; walking
 * back to a lead byte leaves valid text. It matters because the thing being cut is a document an
 * agent reads, and a mojibake tail reads as corruption rather than as a bound.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;

  let end = maxBytes;
  // 0b10xxxxxx is a continuation byte; step back until the boundary is a code-point start.
  while (end > 0 && (buffer[end] ?? 0) >= 0x80 && (buffer[end] ?? 0) < 0xc0) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}
