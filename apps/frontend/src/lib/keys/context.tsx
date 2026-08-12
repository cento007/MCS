import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react';
import { type KeyBinding, KeyboardRegistry } from './registry.js';

/**
 * React plumbing for the keyboard registry (TDS 05 §9.4).
 *
 * One `keydown` listener for the whole application, installed here. Bindings register and
 * unregister through the context, "so bindings die with their route and there is a single
 * place to audit conflicts".
 */

const KeyboardContext = createContext<KeyboardRegistry | null>(null);

export function KeyboardProvider({
  children,
  registry: injected,
}: {
  children: ReactNode;
  /** Test seam. Production always uses the one created here. */
  registry?: KeyboardRegistry;
}) {
  const registry = useMemo(() => injected ?? new KeyboardRegistry(), [injected]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      registry.handle(event);
    };
    // `keydown` on `document`, not `window`: a binding must still fire when focus is inside
    // a dialog that stops propagation at the window level, and must see the real `target`
    // so the text-entry suppression rule can read it.
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [registry]);

  return <KeyboardContext value={registry}>{children}</KeyboardContext>;
}

export function useKeyboardRegistry(): KeyboardRegistry {
  const registry = useContext(KeyboardContext);
  if (registry === null) {
    throw new Error('useKeyboardRegistry must be used inside <KeyboardProvider>');
  }
  return registry;
}

/**
 * Register one binding for the lifetime of the calling component.
 *
 * The handler is read through a ref so a component may close over fresh state without
 * re-registering on every render — re-registration would churn the conflict table and make
 * a binding briefly absent between renders.
 */
export function useKeyBinding(binding: KeyBinding | null): void {
  const registry = useKeyboardRegistry();
  const latest = useRef<KeyBinding | null>(binding);
  latest.current = binding;

  const id = binding?.id;
  const keys = binding?.keys;
  const allowInTextEntry = binding?.allowInTextEntry === true;
  const preventDefault = binding?.preventDefault !== false;

  useEffect(() => {
    if (id === undefined || keys === undefined) return;
    const snapshot = latest.current;
    return registry.register({
      id,
      keys,
      label: snapshot?.label ?? id,
      scope: snapshot?.scope ?? 'global',
      run: (event) => latest.current?.run(event),
      when: () => latest.current?.when?.() !== false,
      ...(allowInTextEntry ? { allowInTextEntry: true } : {}),
      ...(preventDefault ? {} : { preventDefault: false }),
    });
  }, [registry, id, keys, allowInTextEntry, preventDefault]);
}

/** Register a fixed-length list of bindings. The array's length must not change. */
export function useKeyBindings(bindings: readonly KeyBinding[]): void {
  const registry = useKeyboardRegistry();
  const latest = useRef<readonly KeyBinding[]>(bindings);
  latest.current = bindings;

  // The identity of the binding SET. It is deliberately the only re-registration trigger:
  // the array is rebuilt on every render, so depending on it directly would unregister and
  // re-register every shortcut on every keystroke.
  const signature = bindings.map((binding) => `${binding.id}:${binding.keys}`).join('|');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` IS the dependency; see above
  useEffect(() => {
    const removers = latest.current.map((binding, index) =>
      registry.register({
        id: binding.id,
        keys: binding.keys,
        label: binding.label,
        scope: binding.scope,
        run: (event) => latest.current[index]?.run(event),
        when: () => latest.current[index]?.when?.() !== false,
        ...(binding.allowInTextEntry === true ? { allowInTextEntry: true } : {}),
        ...(binding.preventDefault === false ? { preventDefault: false } : {}),
      }),
    );
    return () => {
      for (const remove of removers) remove();
    };
  }, [registry, signature]);
}
