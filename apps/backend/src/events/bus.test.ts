import { createEvent, type EventEnvelope } from '@mc/shared';
import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from './bus.js';

/**
 * The in-process fan-out (F3.2). Its one hard property: a subscriber that throws must not be
 * able to fail the publisher — the WebSocket hub is a relay, and a relay failure is not a
 * domain failure (TDS 02 §2).
 */

const event = (type: Parameters<typeof createEvent>[0] = 'session.created'): EventEnvelope =>
  createEvent(type, 'backend', { sessionId: '018f6b2e-1111-7abc-8def-0123456789ab' });

describe('createEventBus', () => {
  it('delivers every envelope to every subscriber', () => {
    const bus = createEventBus();
    const first = vi.fn();
    const second = vi.fn();

    bus.subscribeAll(first);
    bus.subscribeAll(second);
    const published = event();
    bus.publish(published);

    expect(first).toHaveBeenCalledWith(published);
    expect(second).toHaveBeenCalledWith(published);
  });

  it('unsubscribes', () => {
    const bus = createEventBus();
    const listener = vi.fn();

    const unsubscribe = bus.subscribeAll(listener);
    unsubscribe();
    bus.publish(event());

    expect(listener).not.toHaveBeenCalled();
    expect(bus.listenerCount).toBe(0);
  });

  it('filters by type with `on`', () => {
    const bus = createEventBus();
    const listener = vi.fn();

    bus.on('session.state_changed', listener);
    bus.publish(event('session.created'));
    expect(listener).not.toHaveBeenCalled();

    const stateChanged = event('session.state_changed');
    bus.publish(stateChanged);
    expect(listener).toHaveBeenCalledExactlyOnceWith(stateChanged);
  });

  it('isolates a throwing listener: the publisher survives and the others still run', () => {
    const onListenerError = vi.fn();
    const bus = createEventBus({ onListenerError });
    const healthy = vi.fn();

    bus.subscribeAll(() => {
      throw new Error('relay exploded');
    });
    bus.subscribeAll(healthy);

    const published = event();
    expect(() => {
      bus.publish(published);
    }).not.toThrow();

    expect(healthy).toHaveBeenCalledWith(published);
    expect(onListenerError).toHaveBeenCalledTimes(1);
    expect(onListenerError.mock.calls[0]?.[1]).toBe(published);
  });
});
