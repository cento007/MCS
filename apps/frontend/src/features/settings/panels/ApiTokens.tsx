import { useState } from 'react';
import { EmptyState } from '../../../components/EmptyState.js';
import { ErrorPanel } from '../../../components/ErrorPanel.js';
import { ConfirmDialog, Modal } from '../../../components/Modal.js';
import { Skeleton } from '../../../components/Skeleton.js';
import type { ApiTokenSummary } from '../../../lib/api/index.js';
import { formatDateTime } from '../../../lib/format/index.js';
import { useCreateApiToken, useRevokeApiToken } from '../mutations.js';
import { useApiTokens } from '../queries.js';
import type { CreatedApiToken } from '../types.js';

/**
 * API tokens (PRD §4.4.6, TDS 04 §3.2–3.3, TDS 06 §5.7.11).
 *
 * **The full token value is shown exactly once, and this component is the only thing standing
 * between that guarantee and its violation.** It is hashed at rest (F5.5), so the server
 * cannot re-issue it and no amount of UI can recover it. Concretely:
 *
 *  - the created token lives in this component's state, never in the query cache — the cache
 *    is long-lived and inspectable, and any cache-persistence layer added later would write a
 *    live credential to disk;
 *  - closing the reveal drops it; there is no "show again" affordance and the list can only
 *    ever render `prefix`;
 *  - the danger-tinted note says "You won't see this again" *before* the operator dismisses
 *    it, not after.
 *
 * Revoke is a confirm-gated destructive action: a revoked token cannot be un-revoked, and the
 * row gives no clue about which script is about to stop working.
 */

/** TDS 04 §1.4 / `apps/backend/src/auth/principal.ts`. `full` grants the entire API. */
const TOKEN_SCOPES = [
  { value: 'full', label: 'full — the entire API' },
  { value: 'ingest', label: 'ingest — hook events only' },
] as const;

export function ApiTokensSection() {
  const tokens = useApiTokens();
  const revoke = useRevokeApiToken();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiTokenSummary | null>(null);

  return (
    <div className="flex flex-col gap-3">
      {tokens.isPending ? (
        <div className="space-y-2" role="status" aria-busy="true">
          <span className="sr-only">Loading API tokens</span>
          <Skeleton height={28} />
          <Skeleton height={28} />
        </div>
      ) : tokens.isError ? (
        <ErrorPanel
          error={tokens.error}
          title="API tokens are unavailable"
          onRetry={() => void tokens.refetch()}
        />
      ) : (tokens.data ?? []).length === 0 ? (
        <EmptyState
          title="No API tokens"
          hint="Tokens authenticate scripts and the Claude Code hooks; the browser uses the session cookie."
        />
      ) : (
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">API tokens</caption>
          <thead>
            <tr className="border-border border-b text-2xs text-text-secondary uppercase">
              <th scope="col" className="py-2 pr-3 font-medium">
                Name
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Created
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Last used
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Prefix
              </th>
              <th scope="col" className="py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(tokens.data ?? []).map((token) => (
              <tr key={token.id} className="border-border border-b last:border-b-0">
                <td className="py-2 pr-3 text-sm text-text">{token.name}</td>
                <td className="py-2 pr-3 text-text-secondary text-xs">
                  {formatDateTime(token.createdAt)}
                </td>
                <td className="py-2 pr-3 text-text-secondary text-xs">
                  {token.lastUsedAt === null ? 'never' : formatDateTime(token.lastUsedAt)}
                </td>
                <td className="py-2 pr-3 font-mono text-text-secondary text-xs">{token.prefix}…</td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    onClick={() => setRevoking(token)}
                    className="rounded-sm px-2 text-sm"
                    style={{
                      color: 'var(--color-danger)',
                      minHeight: 24,
                      height: 'var(--mc-control-sm)',
                    }}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-sm border border-border-control px-3 text-sm text-text"
          style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
        >
          + Create token
        </button>
      </div>

      <CreateTokenModal open={creating} onClose={() => setCreating(false)} />

      <ConfirmDialog
        open={revoking !== null}
        title="Revoke token?"
        body={
          revoking === null
            ? ''
            : `Revoke "${revoking.name}" (${revoking.prefix}…)? Anything using it stops working immediately, and it cannot be restored.`
        }
        confirmLabel="Revoke"
        destructive
        pending={revoke.isPending}
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          if (revoking === null) return;
          revoke.mutate(revoking.id, { onSettled: () => setRevoking(null) });
        }}
      />
    </div>
  );
}

/**
 * Two states in one dialog: compose, then reveal.
 *
 * They are one dialog rather than two on purpose — the reveal must not be dismissible by
 * anything the operator might do reflexively after pressing Create, and keeping it inside the
 * same focus-trapped surface means the only way past it is the explicit
 * "I've stored it" button.
 */
export function CreateTokenModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateApiToken();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<string>('full');
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [copied, setCopied] = useState(false);

  const close = (): void => {
    // The one and only copy of the value leaves memory here.
    setCreated(null);
    setName('');
    setScope('full');
    setCopied(false);
    onClose();
  };

  if (created !== null) {
    return (
      <Modal
        open={open}
        onClose={close}
        title="Token created"
        footer={
          <button
            type="button"
            onClick={close}
            className="rounded-sm px-3 font-medium text-sm"
            style={{
              height: 'var(--mc-control-md)',
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            I&apos;ve stored it
          </button>
        }
      >
        <div
          className="rounded-sm border p-3"
          style={{
            backgroundColor: 'var(--color-danger-subtle)',
            borderColor: 'var(--color-danger)',
          }}
        >
          <p className="font-medium text-sm" style={{ color: 'var(--color-danger)' }}>
            You won&apos;t see this again.
          </p>
          <p className="mt-1 text-2xs text-text-secondary leading-150">
            Mission Control stores only a hash. Copy it now — there is no way to recover it, and the
            list below will only ever show the prefix.
          </p>
        </div>

        <p className="mt-3 text-text-secondary text-xs">{created.name}</p>
        <code
          data-testid="created-token-value"
          className="mt-1 block overflow-x-auto rounded-sm p-3 font-mono text-sm text-text"
          style={{ backgroundColor: 'var(--color-surface-inset)' }}
        >
          {created.token}
        </code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(created.token)
              .then(() => setCopied(true))
              .catch(() => {
                // Clipboard permission denied — the value is selectable on screen, which is
                // why it is rendered as text rather than hidden behind this button.
              });
          }}
          className="mt-2 rounded-sm border border-border-control px-3 text-sm text-text"
          style={{ height: 'var(--mc-control-sm)', minHeight: 24 }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Create API token"
      footer={
        <>
          <button
            type="button"
            onClick={close}
            className="rounded-sm border border-border-control px-3 text-sm text-text"
            style={{ height: 'var(--mc-control-md)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={name.trim().length === 0 || create.isPending}
            onClick={() =>
              create.mutate(
                { name: name.trim(), scopes: [scope] },
                { onSuccess: (token) => setCreated(token) },
              )
            }
            className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
            style={{
              height: 'var(--mc-control-md)',
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <label htmlFor="token-name" className="mb-1 block text-text-secondary text-xs">
            Name
          </label>
          <input
            id="token-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="cli-laptop"
            className="w-full rounded-sm border bg-transparent px-2 text-sm text-text"
            style={{
              height: 'var(--mc-control-md)',
              borderColor: 'var(--color-border-control)',
              backgroundColor: 'var(--color-surface-inset)',
            }}
          />
        </div>

        <div>
          <label htmlFor="token-scope" className="mb-1 block text-text-secondary text-xs">
            Scope
          </label>
          <select
            id="token-scope"
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            className="w-full rounded-sm border bg-transparent px-2 text-sm text-text"
            style={{
              height: 'var(--mc-control-md)',
              borderColor: 'var(--color-border-control)',
              backgroundColor: 'var(--color-surface-inset)',
            }}
          >
            {TOKEN_SCOPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {create.isError ? <ErrorPanel error={create.error} /> : null}
      </div>
    </Modal>
  );
}
