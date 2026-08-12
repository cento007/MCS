import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { useLiveSessionStore } from '../stores/live-session-store.js';
import { useSocketStore } from '../stores/socket-store.js';
import { useToastStore } from '../stores/toast-store.js';
import { uiPersistStorage, useUiStore } from '../stores/ui-store.js';

/**
 * Unit-tier setup. No database, no network, no browser download — `pnpm test` runs on a
 * bare checkout (TDS 07 §4).
 *
 * Zustand stores are module singletons, so they are reset between tests explicitly. A test
 * that inherits an open session set or a `live` connection status from the test before it
 * passes for the wrong reason, and the failure surfaces somewhere else entirely.
 */
/**
 * `ResizeObserver` is not implemented by jsdom, and TanStack Virtual observes its scroll
 * element's rect through it. Without a stub, importing the conversation pane throws at
 * construction — which would make the transcript the one surface in the product that cannot
 * be unit-tested, i.e. exactly the wrong one to leave uncovered.
 *
 * The stub deliberately never fires: layout in jsdom is a fiction, so the virtualizer is
 * driven from explicit rect/scroll stubs in the tests that care (see `Conversation.test.tsx`)
 * rather than from an observer callback that would report zeroes.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

beforeEach(() => {
  useUiStore.getState().reset();
  useSocketStore.getState().reset();
  useLiveSessionStore.getState().reset();
  useToastStore.getState().clear();
  uiPersistStorage.clear();
});

afterEach(() => {
  cleanup();
});
