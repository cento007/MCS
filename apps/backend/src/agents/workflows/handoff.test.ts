import { MAX_AGENT_WORKFLOW_PROMPT_BYTES } from '@mc/shared';
import { describe, expect, it } from 'vitest';
import { MAX_PROMPT_BYTES } from '../../sessions/managed/prompts.js';
import { buildHandoff, isDegradingGap, truncateToBytes } from './handoff.js';

/**
 * The hand-off, unit tier — no database, no git, no embedder.
 *
 * Every arm of `buildHandoff` is a claim about what the *next agent reads*, and the ones that
 * matter most are the failure arms: a step handed nothing must be told it was handed nothing.
 * Those branches can only be reached in the real system by turning Ollama off or by cutting a
 * network share mid-run, which is exactly why they are exercised here instead.
 */

const BASE = {
  workflowName: 'Review chain',
  stepOrdinal: 1,
  stepCount: 4,
  agentName: 'QA',
  runTask: 'Add rate limiting to the login route.',
  stepInstructions: 'Review the previous step for missing tests.',
} as const;

describe('the prompt-byte ceiling is one number in two packages', () => {
  /**
   * `MAX_AGENT_WORKFLOW_PROMPT_BYTES` lives in `@mc/shared` because a CHECK constraint needs it;
   * `MAX_PROMPT_BYTES` lives in the managed wrapper because the route applies it. Two
   * declarations of one number is the drift this codebase keeps paying for, so the coupling is
   * pinned here rather than hoped for: a stored prompt this side accepts and that side rejects
   * would strand a run at the exact moment it tried to speak.
   */
  it('agrees with the limit POST /sessions/{id}/prompts actually enforces', () => {
    expect(MAX_AGENT_WORKFLOW_PROMPT_BYTES).toBe(MAX_PROMPT_BYTES);
  });
});

describe('the first step', () => {
  it('is "none", not "degraded" — there is nothing missing', () => {
    const result = buildHandoff({ ...BASE, stepOrdinal: 0, previous: null });

    expect(result.state).toBe('none');
    expect(result.reason).toBeNull();
    expect(result.prompt).toContain('You are the first step in this chain');
    // The distinction that matters: an absent predecessor must not read as a lost one.
    expect(result.prompt).not.toContain('[!warning]');
  });

  it('carries the operator task and the step instructions verbatim', () => {
    const result = buildHandoff({ ...BASE, stepOrdinal: 0, previous: null });

    expect(result.prompt).toContain(BASE.runTask);
    expect(result.prompt).toContain(BASE.stepInstructions);
  });

  it('says so when a step carries no standing instructions', () => {
    const result = buildHandoff({ ...BASE, stepInstructions: null, previous: null });

    expect(result.prompt).toContain('no standing instructions');
  });
});

describe('a whole hand-off', () => {
  const previous = {
    kind: 'package',
    agentName: 'Developer',
    sessionId: '0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
    content: '## Working tree, as of now\n\n- **Uncommitted entries**: 12',
    gapReason: null,
    gapDetail: null,
  } as const;

  it('is "full" and carries the package body', () => {
    const result = buildHandoff({ ...BASE, previous });

    expect(result.state).toBe('full');
    expect(result.reason).toBeNull();
    expect(result.prompt).toContain('Uncommitted entries');
    expect(result.prompt).toContain('Developer');
    expect(result.prompt).toContain(previous.sessionId);
  });

  it('tells the agent the record is assembled, not summarised', () => {
    const result = buildHandoff({ ...BASE, previous });
    expect(result.prompt).toContain('Nothing in it is summarised or inferred');
  });

  it('says a later step exists, and says when it is the last one', () => {
    const middle = buildHandoff({ ...BASE, previous });
    expect(middle.prompt).toContain('the next step starts');

    const last = buildHandoff({ ...BASE, stepOrdinal: 3, previous });
    expect(last.prompt).toContain('final step');
  });
});

describe('a degraded hand-off names the gap in the prompt itself', () => {
  it('warns, and refuses to let the agent assume, when the package could not be built', () => {
    const result = buildHandoff({
      ...BASE,
      previous: {
        kind: 'unavailable',
        agentName: 'Developer',
        sessionId: '0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
        reason: 'CONFLICT',
        detail: 'This session has not started, so there is nothing to export yet',
      },
    });

    expect(result.state).toBe('degraded');
    expect(result.reason).toBe('CONFLICT');
    expect(result.prompt).toContain('[!warning]');
    expect(result.prompt).toContain('You have not been shown its work');
    expect(result.prompt).toContain('Do not assume what it did');
  });

  it('flags a memory failure and keeps the rest of the package', () => {
    const result = buildHandoff({
      ...BASE,
      previous: {
        kind: 'package',
        agentName: 'Developer',
        sessionId: '0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
        content: 'the package body',
        gapReason: 'unavailable',
        gapDetail: 'Semantic retrieval failed while this package was being generated.',
      },
    });

    expect(result.state).toBe('degraded');
    expect(result.reason).toBe('unavailable');
    expect(result.prompt).toContain('Part of this record is missing');
    expect(result.prompt).toContain('Everything else below was produced normally');
    expect(result.prompt).toContain('the package body');
  });
});

describe('which memory gaps count as degradation', () => {
  it('treats a real failure as degradation', () => {
    for (const reason of [
      'unavailable',
      'stamp_mismatch',
      'index_empty',
      'timed_out',
      'no_query',
    ]) {
      expect(isDegradingGap(reason)).toBe(true);
    }
  });

  it('does NOT treat an honest answer as degradation', () => {
    // "Memory answered and nothing was close enough" is a result, not a fault.
    expect(isDegradingGap('below_threshold')).toBe(false);
    expect(isDegradingGap('only_own_session')).toBe(false);
  });

  it('does NOT treat "this install has no memory" as degradation', () => {
    // The load-bearing one: counting it would badge every step of every run on an install that
    // never opted into Phase 3, and a flag that is always on is a flag that says nothing.
    expect(isDegradingGap('not_configured')).toBe(false);
  });

  it('is not a gap at all when memory answered', () => {
    expect(isDegradingGap(null)).toBe(false);
  });
});

describe('the prompt fits what the prompt route will accept', () => {
  it('cuts the package, keeps the instructions, and says it cut', () => {
    const huge = 'x'.repeat(MAX_AGENT_WORKFLOW_PROMPT_BYTES + 10_000);

    const result = buildHandoff({
      ...BASE,
      previous: {
        kind: 'package',
        agentName: 'Developer',
        sessionId: '0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
        content: huge,
        gapReason: null,
        gapDetail: null,
      },
    });

    expect(result.bytes).toBeLessThanOrEqual(MAX_AGENT_WORKFLOW_PROMPT_BYTES);
    expect(result.state).toBe('degraded');
    expect(result.reason).toBe('handoff_truncated');
    // The task and the brief survive: evidence without an instruction is worse than neither.
    expect(result.prompt).toContain(BASE.runTask);
    expect(result.prompt).toContain(BASE.stepInstructions);
    expect(result.prompt).toContain('was cut here');
  });

  it('leaves a package that fits completely alone', () => {
    const result = buildHandoff({
      ...BASE,
      previous: {
        kind: 'package',
        agentName: 'Developer',
        sessionId: '0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
        content: 'short',
        gapReason: null,
        gapDetail: null,
      },
    });

    expect(result.prompt).not.toContain('was cut here');
    expect(result.state).toBe('full');
  });
});

describe('truncateToBytes', () => {
  it('never splits a UTF-8 sequence', () => {
    // Four bytes each. Cutting at 6 must yield one whole emoji, not one and a half.
    const text = '😀😀😀';
    const cut = truncateToBytes(text, 6);

    expect(cut).toBe('😀');
    expect(cut).not.toContain('�');
  });

  it('returns the whole string when it already fits, and nothing at a zero budget', () => {
    expect(truncateToBytes('abc', 10)).toBe('abc');
    expect(truncateToBytes('abc', 0)).toBe('');
  });
});
