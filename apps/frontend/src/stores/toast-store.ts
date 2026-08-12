import { create } from 'zustand';

/**
 * Toasts (TDS 06 §4.5, TDS 05 §11.1).
 *
 * Strict rule from §4.5: **toasts are ephemeral feedback about what the operator just did
 * or must see now; the Notification inbox is the durable record.** Phase 1 has only the
 * toast half — the bell and the inbox light up in Phase 2 with the Notification entity.
 *
 * `danger` toasts are sticky: an error that auto-dismisses after five seconds is an error
 * the operator can miss by looking away, and §11.1 requires that every failed mutation
 * produce a surfaced error unless a more specific inline one exists.
 */

export type ToastKind = 'success' | 'info' | 'warning' | 'danger';

export interface ToastAction {
  readonly label: string;
  readonly run: () => void;
}

export interface Toast {
  readonly id: string;
  readonly kind: ToastKind;
  readonly message: string;
  /** Expandable detail — where the `requestId` goes (§11.1). */
  readonly detail?: string;
  readonly action?: ToastAction;
  readonly sticky: boolean;
  readonly createdAt: number;
}

export interface ToastInput {
  readonly kind?: ToastKind;
  readonly message: string;
  readonly detail?: string;
  readonly action?: ToastAction;
  readonly sticky?: boolean;
}

/** §4.5 — max 3 stacked. */
export const MAX_TOASTS = 3;
export const TOAST_TTL_MS = 5_000;

export interface ToastStoreState {
  readonly toasts: readonly Toast[];
  push(input: ToastInput): string;
  dismiss(id: string): void;
  clear(): void;
}

let sequence = 0;

export const useToastStore = create<ToastStoreState>((set, get) => ({
  toasts: [],

  push: (input) => {
    sequence += 1;
    const id = `toast-${sequence}`;
    const kind = input.kind ?? 'info';
    const toast: Toast = {
      id,
      kind,
      message: input.message,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      ...(input.action === undefined ? {} : { action: input.action }),
      sticky: input.sticky ?? kind === 'danger',
      createdAt: Date.now(),
    };

    set((previous) => ({ toasts: [...previous.toasts, toast].slice(-MAX_TOASTS) }));

    if (!toast.sticky) {
      setTimeout(() => get().dismiss(id), TOAST_TTL_MS);
    }
    return id;
  },

  dismiss: (id) => set((previous) => ({ toasts: previous.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** Imperative helper for non-component call sites (the 401 interceptor, the socket hooks). */
export function toast(input: ToastInput): string {
  return useToastStore.getState().push(input);
}
