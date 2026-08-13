import { useEffect, useState } from 'react';
import { RequestIdLine } from '../../../components/ErrorPanel.js';
import { ApiError, errorMessage } from '../../../lib/api/index.js';
import { formatClock } from '../../../lib/format/index.js';
import type { PanelForm } from '../form.js';
import { useTestConnection } from '../mutations.js';
import type { IntegrationSlug, TestConnectionResult } from '../types.js';

/**
 * Test Connection (TDS 06 §5.7.2, TDS 05 §7.4).
 *
 * **The test always tests persisted state, and the button is disabled while the panel is
 * dirty.** This is the single most consequential rule on the Settings screen and it is
 * enforced here rather than left to each panel:
 *
 * > "a test whose scope depends on which fields happen to be dirty is a test whose result
 * > cannot be interpreted. 'It works' would mean 'it works with the values on your screen',
 * > while the running system — workers, pollers, the Telegram dispatcher — uses the values in
 * > the database; a green check on unsaved input is a false pass on the exact question the
 * > operator asked."
 *
 * The concrete hazard it prevents: paste a token, press Test, see ✓ Connected, navigate away —
 * and have saved nothing, with no way to tell, because the value cannot be read back.
 *
 * Hence three things that are not decoration:
 *  - `disabled` while dirty, with the inline hint **"Save changes to test"**;
 *  - every result line begins **"Tested saved settings"**, naming its own scope;
 *  - results are **cleared the moment the panel goes dirty again** (§5.7.2: "a result
 *    describing a previous configuration must not linger next to edited fields").
 */

export interface TestConnectionProps<TDoc> {
  readonly form: PanelForm<TDoc>;
  readonly integration: IntegrationSlug;
  /** Extra line under a successful result, e.g. "sends a test message to the chat". */
  readonly note?: string;
  /** Turn the server's `detail` object into the integration-specific success fragment. */
  readonly describeSuccess?: (result: TestConnectionResult) => string;
}

export function TestConnection<TDoc>({
  form,
  integration,
  note,
  describeSuccess,
}: TestConnectionProps<TDoc>) {
  const mutation = useTestConnection(integration);
  const [outcome, setOutcome] = useState<TestConnectionResult | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);

  const dirty = form.summary.isDirty;
  const testable = form.available && !dirty && !mutation.isPending;

  // §5.7.2: a result describing a previous configuration must not linger beside edited fields.
  useEffect(() => {
    if (!dirty) return;
    setOutcome(null);
    setFailure(null);
  }, [dirty]);

  const run = (): void => {
    setOutcome(null);
    setFailure(null);
    mutation.mutate(undefined, {
      onSuccess: (result) => setOutcome(result),
      // §7.4: only a *refused request* rejects — `INTEGRATION_NOT_CONFIGURED` (409), or the
      // route simply not existing yet. An integration that answers "no" is `ok: false`
      // above, and the two are rendered as the different problems they are.
      onError: (error) => setFailure(error instanceof ApiError ? error : null),
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={!testable}
          aria-describedby={dirty ? `test-hint-${integration}` : undefined}
          className="rounded-sm border border-border-control px-3 font-medium text-sm text-text disabled:opacity-50"
          style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
        >
          {mutation.isPending ? '⟳ Testing…' : 'Test Connection'}
        </button>

        {dirty ? (
          <span id={`test-hint-${integration}`} className="text-text-muted text-xs">
            Save changes to test
          </span>
        ) : null}

        {note === undefined || dirty ? null : (
          <span className="text-text-muted text-xs">{note}</span>
        )}
      </div>

      {outcome === null ? null : outcome.ok ? (
        <p
          data-testid={`test-result-${integration}`}
          className="text-xs leading-150"
          style={{ color: 'var(--color-success)' }}
        >
          <span aria-hidden="true">✓</span> {successLine(outcome, describeSuccess)}
        </p>
      ) : (
        <div
          data-testid={`test-result-${integration}`}
          role="alert"
          className="rounded-sm border p-3"
          style={{
            backgroundColor: 'var(--color-danger-subtle)',
            borderColor: 'var(--color-danger)',
          }}
        >
          <p className="text-sm leading-150" style={{ color: 'var(--color-danger)' }}>
            <span aria-hidden="true">✕</span> Tested saved settings · {outcome.message}
          </p>
          <p className="mt-1 text-2xs text-text-muted">{clockOf(outcome.checkedAt)}</p>
        </div>
      )}

      {failure === null ? null : (
        <div
          data-testid={`test-error-${integration}`}
          role="alert"
          className="rounded-sm border p-3"
          style={{
            backgroundColor: 'var(--color-danger-subtle)',
            borderColor: 'var(--color-danger)',
          }}
        >
          <p className="text-sm leading-150" style={{ color: 'var(--color-danger)' }}>
            <span aria-hidden="true">✕</span> Could not run the test · {errorMessage(failure)}
          </p>
          <code className="mt-2 inline-block rounded-xs bg-surface-inset px-2 py-05 font-mono text-2xs text-text-secondary">
            {failure.code}
          </code>
          {failure.requestId === null ? null : <RequestIdLine requestId={failure.requestId} />}
        </div>
      )}
    </div>
  );
}

/**
 * `Tested saved settings · Connected as cento007 · 231 ms · 14:07`.
 *
 * The prefix is fixed and always present: it is what makes the result interpretable months
 * later, when the operator no longer remembers whether this button tested the form or the
 * database. Latency and clock are appended only when the server supplied them.
 */
export function successLine(
  result: TestConnectionResult,
  describe?: (result: TestConnectionResult) => string,
): string {
  const parts = ['Tested saved settings'];
  const detail = describe?.(result) ?? result.message;
  if (detail.length > 0) parts.push(detail);
  if (result.latencyMs !== null) parts.push(`${result.latencyMs} ms`);
  const clock = clockOf(result.checkedAt);
  if (clock.length > 0) parts.push(clock);
  return parts.join(' · ');
}

function clockOf(checkedAt: string): string {
  const clock = formatClock(checkedAt);
  return clock === '—' ? '' : clock;
}
