import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger/index.js';
import { createShutdownController, SHUTDOWN_SIGNALS, type ShutdownSignal } from './shutdown.js';

const logger = createLogger({ service: 'backend', level: 'silent' });

/** Stands in for `process` so tests never emit real signals into the test runner. */
function makeSignalTarget() {
  const emitter = new EventEmitter();
  return {
    target: {
      on: (signal: ShutdownSignal, listener: () => void) => emitter.on(signal, listener),
      off: (signal: ShutdownSignal, listener: () => void) => emitter.off(signal, listener),
    },
    emit: (signal: ShutdownSignal) => emitter.emit(signal),
    listenerCount: (signal: ShutdownSignal) => emitter.listenerCount(signal),
  };
}

describe('graceful shutdown (F8.1 process contract, TDS 07 §7.2)', () => {
  it('wires BOTH SIGINT and SIGTERM — Ubuntu sends SIGTERM, Windows Ctrl-C sends SIGINT', () => {
    const signals = makeSignalTarget();
    const controller = createShutdownController({ logger, signalTarget: signals.target });

    expect([...SHUTDOWN_SIGNALS]).toEqual(['SIGINT', 'SIGTERM']);
    for (const signal of SHUTDOWN_SIGNALS) {
      expect(signals.listenerCount(signal), signal).toBe(1);
    }

    controller.dispose();
  });

  it.each([...SHUTDOWN_SIGNALS])('drains hooks on %s', async (signal) => {
    const signals = makeSignalTarget();
    const controller = createShutdownController({ logger, signalTarget: signals.target });

    let drained = false;
    controller.onShutdown('worker', () => {
      drained = true;
    });

    signals.emit(signal);
    await new Promise((resolve) => setImmediate(resolve));

    expect(drained).toBe(true);
    controller.dispose();
  });

  it('runs hooks in reverse registration order — last registered tears down first', async () => {
    const controller = createShutdownController({
      logger,
      signalTarget: makeSignalTarget().target,
    });
    const order: string[] = [];

    controller.onShutdown('db-pool', () => {
      order.push('db-pool');
    });
    controller.onShutdown('queue', () => {
      order.push('queue');
    });
    controller.onShutdown('http-server', () => {
      order.push('http-server');
    });

    await controller.shutdown('test');

    expect(order).toEqual(['http-server', 'queue', 'db-pool']);
    controller.dispose();
  });

  it('is idempotent — a second signal while draining is ignored', async () => {
    const signals = makeSignalTarget();
    const controller = createShutdownController({ logger, signalTarget: signals.target });

    let calls = 0;
    controller.onShutdown('worker', () => {
      calls += 1;
    });

    await controller.shutdown('first');
    await controller.shutdown('second');
    signals.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toBe(1);
    controller.dispose();
  });

  it('keeps draining when a hook throws, so one bad teardown cannot strand the rest', async () => {
    const controller = createShutdownController({
      logger,
      signalTarget: makeSignalTarget().target,
    });
    const survivors: string[] = [];

    controller.onShutdown('db-pool', () => {
      survivors.push('db-pool');
    });
    controller.onShutdown('exploding', () => {
      throw new Error('teardown failed');
    });

    await expect(controller.shutdown('test')).resolves.toBeUndefined();
    expect(survivors).toEqual(['db-pool']);
    controller.dispose();
  });

  it('detaches its listeners on dispose', () => {
    const signals = makeSignalTarget();
    const controller = createShutdownController({ logger, signalTarget: signals.target });

    controller.dispose();

    for (const signal of SHUTDOWN_SIGNALS) {
      expect(signals.listenerCount(signal), signal).toBe(0);
    }
  });
});
