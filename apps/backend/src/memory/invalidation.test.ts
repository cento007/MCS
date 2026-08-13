import { describe, expect, it } from 'vitest';
import { affectsMemoryRuntime } from './index.js';

/**
 * Which `setting.updated` events drop the cached `MemoryRuntime`.
 *
 * This predicate is the whole of a bug that shipped: `runtime.ts` documents that a settings
 * change "is how changing the embedding model takes effect without a restart, and how it is
 * *caught* without a restart", and nothing subscribed. The consequence is not a stale field —
 * it is that an operator who switches the embedding model keeps being served results from the
 * collection the **previous** model built, and mismatched vectors return confident nonsense
 * rather than an error. The stamp exists to refuse exactly that, and the miss made it silent.
 *
 * The slug cases are the live path and the only one today: `integrations` is excluded from
 * `DOCUMENT_CATEGORIES`, so no route emits `integration: null` beside an `integrations.*` key.
 * The `changedKeys` cases below pin **defence in depth** rather than a shipped path — they are
 * labelled as such so nobody later reads them as evidence that a category route exists.
 */

const CHANGED = (...keys: string[]) => ({ category: 'integrations', changedKeys: keys });

describe('the integration slug — PUT /settings/integrations/{integration}', () => {
  it('invalidates for qdrant', () => {
    expect(affectsMemoryRuntime({ integration: 'qdrant', changedKeys: [] })).toBe(true);
  });

  it('invalidates for ollama, whose host and port build the embedder', () => {
    // Not cosmetic: the runtime caches an embedder bound to that host and port. Moving Ollama
    // without dropping the cache leaves every embed call pointed at nothing.
    expect(affectsMemoryRuntime({ integration: 'ollama', changedKeys: [] })).toBe(true);
  });

  it('ignores integrations the runtime never read', () => {
    for (const integration of ['github', 'telegram', 'obsidian', 'claude-code']) {
      expect(affectsMemoryRuntime({ integration, changedKeys: [] })).toBe(false);
    }
  });
});

describe('the changed keys — defence in depth, no route emits this today', () => {
  it('invalidates when a qdrant key moved, though the slug is null', () => {
    // Not reachable from the current API: `integrations` is excluded from DOCUMENT_CATEGORIES,
    // so `replaceCategory` cannot be called with it. Pinned anyway because `changedKeys` states
    // what actually moved while the slug only states which route was called.
    expect(
      affectsMemoryRuntime({
        integration: null,
        ...CHANGED('integrations.qdrant.embeddingModel'),
      }),
    ).toBe(true);
  });

  it('invalidates when an ollama key moved', () => {
    expect(
      affectsMemoryRuntime({ integration: null, ...CHANGED('integrations.ollama.port') }),
    ).toBe(true);
  });

  it('invalidates when a memory key is one of several in a mixed category write', () => {
    expect(
      affectsMemoryRuntime({
        integration: null,
        ...CHANGED(
          'integrations.github.syncIntervalMinutes',
          'integrations.telegram.enabled',
          'integrations.qdrant.host',
        ),
      }),
    ).toBe(true);
  });

  it('does NOT invalidate a category write that left both integrations alone', () => {
    // The negative half, and the one that stops this from being a rubber stamp: without it the
    // predicate could return `true` unconditionally and every test above would still pass —
    // while a GitHub sync interval change threw away a verified runtime and forced three fresh
    // round trips, one of them a cold model load, on the next query.
    expect(
      affectsMemoryRuntime({
        integration: null,
        ...CHANGED('integrations.github.workflowMode', 'integrations.obsidian.syncMode'),
      }),
    ).toBe(false);
  });

  it('does not match a key that merely contains the word elsewhere', () => {
    expect(affectsMemoryRuntime({ integration: null, ...CHANGED('general.qdrantNotes') })).toBe(
      false,
    );
  });
});

describe('payloads that are not the shape we expect', () => {
  it('is false for a non-integration category rather than throwing', () => {
    // `setting.updated` also fires for general/notifications/security, whose payloads carry no
    // `integration` at all. A throw here would land in `onListenerError` on every save.
    expect(
      affectsMemoryRuntime({ category: 'security', changedKeys: ['security.allowedOrigins'] }),
    ).toBe(false);
  });

  it('is false for a missing or malformed changedKeys', () => {
    expect(affectsMemoryRuntime({})).toBe(false);
    expect(affectsMemoryRuntime({ changedKeys: 'integrations.qdrant.host' })).toBe(false);
    expect(affectsMemoryRuntime({ changedKeys: [42, null] })).toBe(false);
  });
});
