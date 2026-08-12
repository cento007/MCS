import { useEffect, useRef } from 'react';
import { useKeyboardRegistry } from '../../lib/keys/context.js';
import type { KeyScope } from '../../lib/keys/registry.js';

/**
 * The `?` cheat sheet (TDS 06 §4.6, TDS 05 §9.4).
 *
 * It enumerates the live registry rather than restating the shortcut table, so a binding
 * that exists but is undocumented — or documented but removed — is not expressible. §9.4
 * asks for exactly that: "bindings are declared with metadata (label, scope, availability
 * predicate) so the cheat sheet and the palette can enumerate them rather than duplicating
 * a hard-coded list."
 */
const SCOPE_ORDER: readonly KeyScope[] = [
  'global',
  'lists',
  'tables',
  'conversation',
  'composer',
  'settings',
];

const SCOPE_LABEL: Readonly<Record<KeyScope, string>> = {
  global: 'Global',
  lists: 'Lists',
  tables: 'Tables',
  conversation: 'Conversation',
  composer: 'Composer',
  settings: 'Settings',
};

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const registry = useKeyboardRegistry();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const bindings = registry.list();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close shortcuts"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
        style={{ backgroundColor: 'var(--color-overlay)' }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="relative max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-lg border border-border p-4"
        style={{
          backgroundColor: 'var(--color-surface-raised)',
          boxShadow: 'var(--shadow-overlay)',
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-lg text-text">Keyboard shortcuts</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts"
            className="rounded-sm border border-border-control px-3 text-sm text-text"
            style={{ height: 'var(--mc-control-sm)' }}
          >
            Close
          </button>
        </div>

        {SCOPE_ORDER.map((scope) => {
          const inScope = bindings.filter((binding) => binding.scope === scope);
          if (inScope.length === 0) return null;
          return (
            <section key={scope} className="mt-4">
              <h3 className="text-2xs text-text-muted uppercase">{SCOPE_LABEL[scope]}</h3>
              <dl className="mt-2 space-y-1">
                {inScope.map((binding) => (
                  <div key={binding.id} className="flex items-baseline gap-3">
                    <dt className="w-28 shrink-0 font-mono text-text-secondary text-xs">
                      {binding.keys}
                    </dt>
                    <dd className="text-sm text-text">{binding.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </div>
  );
}
