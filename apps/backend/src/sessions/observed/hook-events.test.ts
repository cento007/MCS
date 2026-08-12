import { describe, expect, it } from 'vitest';
import { ApiError } from '../../http/errors.js';
import {
  canonicalJson,
  type HookEvent,
  hookMessageFor,
  normalizeHookRequestBody,
  runtimeMessageIdFor,
} from './hook-events.js';
import { toolFilePathFrom } from './tool-files.js';

/**
 * The hook wire format (TDS 04 §6.8) and the dedupe key (TDS 03 §3.11), with no database and no
 * Fastify — every one of these is a pure function, which is why the idempotency rule can be
 * proved here rather than only observed in an integration test.
 */

const TRANSCRIPT = process.platform === 'win32' ? 'C:\\c\\p\\s.jsonl' : '/c/p/s.jsonl';

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hookEventName: 'UserPromptSubmit',
    runtimeSessionId: '11111111-1111-4111-8111-111111111111',
    transcriptPath: TRANSCRIPT,
    cwd: '/home/op/proj',
    payload: { prompt: 'ship it' },
    ...overrides,
  };
}

describe('normalizeHookRequestBody — the documented envelope (§6.8)', () => {
  it('accepts the contract shape verbatim', () => {
    const event = normalizeHookRequestBody(envelope());

    expect(event.hookEventName).toBe('UserPromptSubmit');
    expect(event.runtimeSessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(event.transcriptPath).toBe(TRANSCRIPT);
    expect(event.cwd).toBe('/home/op/proj');
    expect(event.payload).toEqual({ prompt: 'ship it' });
  });

  it('parses occurredAt when present and tolerates it being absent or nonsense', () => {
    expect(
      normalizeHookRequestBody(envelope({ occurredAt: '2026-08-12T10:00:00.000Z' })).occurredAt,
    ).toEqual(new Date('2026-08-12T10:00:00.000Z'));

    expect(normalizeHookRequestBody(envelope()).occurredAt).toBeNull();
    expect(normalizeHookRequestBody(envelope({ occurredAt: 'yesterday' })).occurredAt).toBeNull();
  });

  it('drops a transcriptPath it cannot safely open, without failing the request', () => {
    const event = normalizeHookRequestBody(envelope({ transcriptPath: '../../etc/passwd' }));
    expect(event.transcriptPath).toBeNull();
  });

  it('rejects only the two fields it cannot proceed without', () => {
    expect(() => normalizeHookRequestBody(envelope({ hookEventName: 'PreToolUse' }))).toThrow(
      ApiError,
    );
    expect(() => normalizeHookRequestBody(envelope({ runtimeSessionId: '' }))).toThrow(ApiError);
    expect(() => normalizeHookRequestBody('not an object')).toThrow(ApiError);
  });

  it('keeps an unrecognized payload shape raw rather than rejecting it (F1.5)', () => {
    const payload = { prompt: 'hi', somethingNewIn2027: { nested: [1, 2, 3] } };
    expect(normalizeHookRequestBody(envelope({ payload })).payload).toEqual(payload);
  });
});

describe('normalizeHookRequestBody — a raw Claude Code hook body', () => {
  /**
   * An HTTP hook posts the runtime's own JSON; it has no opportunity to reshape it into the
   * §6.8 envelope. Accepting both is what makes the profile our installer writes usable against
   * the runtime it targets.
   */
  it('normalizes snake_case runtime fields into the documented envelope', () => {
    const event = normalizeHookRequestBody({
      session_id: '22222222-2222-4222-8222-222222222222',
      transcript_path: TRANSCRIPT,
      cwd: '/home/op/proj',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/home/op/proj/src/a.ts' },
      tool_response: { ok: true },
    });

    expect(event.hookEventName).toBe('PostToolUse');
    expect(event.runtimeSessionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(event.transcriptPath).toBe(TRANSCRIPT);
    // Envelope fields are extracted; everything else — including `cwd`, which is both — stays.
    expect(event.payload).toMatchObject({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/op/proj/src/a.ts' },
      tool_response: { ok: true },
    });
    expect(event.payload['session_id']).toBeUndefined();
  });
});

describe('runtimeMessageIdFor — the ingest idempotency key (§3.11)', () => {
  const base = normalizeHookRequestBody(envelope({ hookEventName: 'PostToolUse' }));

  it('is a pure function of the body, so a retried POST collapses', () => {
    const first = runtimeMessageIdFor(base);
    const second = runtimeMessageIdFor(
      normalizeHookRequestBody(
        envelope({
          hookEventName: 'PostToolUse',
        }),
      ),
    );

    expect(first).toBe(second);
    expect(first.startsWith('hook:PostToolUse:')).toBe(true);
  });

  it('does not depend on occurredAt being present', () => {
    // §3.11's stated reason for rejecting the (runtimeSessionId, hookEventName, occurredAt)
    // triple as the storage key: the key can be undefined exactly when a retry needs it.
    expect(() => runtimeMessageIdFor(base)).not.toThrow();
    expect(runtimeMessageIdFor(base)).toBe(runtimeMessageIdFor({ ...base }));
  });

  it('distinguishes two genuinely different payloads', () => {
    const other = normalizeHookRequestBody(
      envelope({ hookEventName: 'PostToolUse', payload: { prompt: 'something else' } }),
    );
    expect(runtimeMessageIdFor(base)).not.toBe(runtimeMessageIdFor(other));
  });

  it('changes with occurredAt when the runtime supplies one', () => {
    const timed = normalizeHookRequestBody(
      envelope({ hookEventName: 'PostToolUse', occurredAt: '2026-08-12T10:00:00.000Z' }),
    );
    expect(runtimeMessageIdFor(timed)).not.toBe(runtimeMessageIdFor(base));
  });

  it('prefers a runtime-supplied uuid, so hooks and the transcript converge on one row', () => {
    const echoed = normalizeHookRequestBody(
      envelope({ payload: { prompt: 'x', uuid: 'aaaaaaa1-0000-4000-8000-000000000001' } }),
    );
    expect(runtimeMessageIdFor(echoed)).toBe('aaaaaaa1-0000-4000-8000-000000000001');
  });
});

describe('canonicalJson', () => {
  it('is insensitive to key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('preserves array order — arrays are ordered data, objects are not', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined values so an explicit-undefined key hashes like an absent one', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe('hookMessageFor', () => {
  function event(overrides: Partial<HookEvent>): HookEvent {
    return {
      hookEventName: 'UserPromptSubmit',
      runtimeSessionId: 'r1',
      transcriptPath: null,
      cwd: null,
      occurredAt: null,
      payload: {},
      ...overrides,
    };
  }

  it('turns UserPromptSubmit into the user Message that A13 derives the title from', () => {
    const message = hookMessageFor(event({ payload: { prompt: 'Add a health endpoint' } }));
    expect(message).toMatchObject({ role: 'user', content: 'Add a health endpoint' });
  });

  it('produces nothing for a blank or missing prompt', () => {
    expect(hookMessageFor(event({ payload: {} }))).toBeNull();
    expect(hookMessageFor(event({ payload: { prompt: '   ' } }))).toBeNull();
  });

  it('turns PostToolUse into a tool Message carrying the file path (§6.10.2)', () => {
    const message = hookMessageFor(
      event({
        hookEventName: 'PostToolUse',
        payload: {
          tool_name: 'Edit',
          tool_use_id: 'toolu_1',
          tool_input: { file_path: '/repo/src/a.ts' },
          tool_response: { ok: true },
        },
      }),
    );

    expect(message).toMatchObject({
      role: 'tool',
      toolName: 'Edit',
      toolUseId: 'toolu_1',
      toolFilePath: '/repo/src/a.ts',
    });
    // `tool_payload` remains the raw truth and is not replaced or reshaped (§3.11).
    expect(message?.toolPayload).toEqual({
      input: { file_path: '/repo/src/a.ts' },
      response: { ok: true },
    });
  });

  it('records a tool it does not recognise, with no file path and no failure', () => {
    const message = hookMessageFor(
      event({
        hookEventName: 'PostToolUse',
        payload: { tool_name: 'SomeTool2027', tool_input: 'a bare string' },
      }),
    );

    expect(message).toMatchObject({ role: 'tool', toolName: 'SomeTool2027', toolFilePath: null });
  });

  it('produces nothing for the three lifecycle hooks (§3.11: they need no dedupe key)', () => {
    for (const name of ['SessionStart', 'Stop', 'SessionEnd'] as const) {
      expect(hookMessageFor(event({ hookEventName: name }))).toBeNull();
    }
  });
});

describe('toolFilePathFrom (§6.10.2 owns the list)', () => {
  it('extracts a path for each of the five file-naming tools', () => {
    expect(toolFilePathFrom('Read', { file_path: '/a.ts' })).toBe('/a.ts');
    expect(toolFilePathFrom('Write', { file_path: '/a.ts' })).toBe('/a.ts');
    expect(toolFilePathFrom('Edit', { file_path: '/a.ts' })).toBe('/a.ts');
    expect(toolFilePathFrom('MultiEdit', { file_path: '/a.ts', edits: [1, 2, 3] })).toBe('/a.ts');
    expect(toolFilePathFrom('NotebookEdit', { notebook_path: '/a.ipynb' })).toBe('/a.ipynb');
  });

  it('returns null for the tools that name a pattern or a command, not a file', () => {
    expect(toolFilePathFrom('Bash', { command: 'rm -rf /' })).toBeNull();
    expect(toolFilePathFrom('Glob', { pattern: '**/*.ts' })).toBeNull();
    expect(toolFilePathFrom('Grep', { pattern: 'TODO', path: '/repo' })).toBeNull();
  });

  it('returns null rather than throwing for every malformed input', () => {
    expect(toolFilePathFrom('Read', null)).toBeNull();
    expect(toolFilePathFrom('Read', 'a string')).toBeNull();
    expect(toolFilePathFrom('Read', [])).toBeNull();
    expect(toolFilePathFrom('Read', { file_path: 42 })).toBeNull();
    expect(toolFilePathFrom(undefined, { file_path: '/a.ts' })).toBeNull();
  });
});
