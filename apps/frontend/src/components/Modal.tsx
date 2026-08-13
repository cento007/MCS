import { type ReactNode, useEffect, useRef } from 'react';

/**
 * The shared overlay surface (TDS 06 §2.5 Modal, §4.x confirm pattern).
 *
 * Focus handling is the substance here, not the chrome: the dialog takes focus on open, traps
 * `Tab` inside itself, and **returns focus to the element that opened it** on close. Without
 * the return, a keyboard operator who dismisses a confirm lands at the top of the document and
 * has to walk back to where they were — which on this screen means walking past every control
 * they were deliberately not pressing.
 */

export interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly labelledBy?: string;
}

export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Close ${title}`}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
        style={{ backgroundColor: 'var(--color-overlay)' }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = focusableWithin(dialogRef.current);
          if (focusable.length === 0) return;
          const first = focusable[0] as HTMLElement;
          const last = focusable[focusable.length - 1] as HTMLElement;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        className="relative w-full max-w-lg rounded-lg border border-border"
        style={{
          backgroundColor: 'var(--color-surface-raised)',
          boxShadow: 'var(--shadow-overlay)',
          // A dialog taller than the viewport must scroll rather than overflow: the API-token
          // reveal is the case that proves it — its "I've stored it" button is the only way
          // past a credential that can never be shown again, so it can never be off-screen.
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <div className="flex items-center justify-between border-border border-b px-4 py-3">
          <h2 className="font-medium text-md text-text">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-xs text-text-muted"
            style={{ minWidth: 24, minHeight: 24 }}
          >
            ✕
          </button>
        </div>
        <div className="px-4 py-4">{children}</div>
        {footer === undefined ? null : (
          <div className="flex justify-end gap-2 border-border border-t px-4 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}

function focusableWithin(root: HTMLElement | null): readonly Element[] {
  if (root === null) return [];
  return [
    ...root.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
}

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly pending?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-sm border border-border-control px-3 text-sm text-text"
            style={{ height: 'var(--mc-control-md)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
            style={{
              height: 'var(--mc-control-md)',
              backgroundColor: destructive ? 'var(--color-danger)' : 'var(--color-accent)',
              color: 'var(--color-text-inverse)',
            }}
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm text-text leading-150">{body}</p>
    </Modal>
  );
}
