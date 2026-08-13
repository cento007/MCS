import type { SessionState } from '@mc/shared/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { composerMode, overflowActions } from '../actions.js';
import { makeSession } from '../test-support.js';
import { Composer } from './Composer.js';

/**
 * The composer × F7 matrix, rendered (TDS 05 §6.6, TDS 06 §5.5).
 *
 * `actions.test.ts` proves the predicate; this proves the surface obeys it — the two failure
 * modes are different, and the second one is the one an operator meets.
 */

const noop = (): void => {};

function renderComposer(session = makeSession(), overrides: Record<string, unknown> = {}) {
  return render(
    <Composer
      session={session}
      mode={composerMode(session)}
      value=""
      onChange={noop}
      onSubmit={noop}
      onEscape={noop}
      launchQueued={false}
      submitting={false}
      undeliveredPrompts={[]}
      onRestorePrompt={noop}
      terminalActions={overflowActions(session)}
      onAction={noop}
      {...overrides}
    />,
  );
}

describe('composer per F7 state', () => {
  it('created — enabled, and its placeholder says typing is the start gesture', () => {
    renderComposer(makeSession({ state: 'created' }));
    const input = screen.getByTestId('composer-input');
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute('placeholder', 'Send a prompt to start this session');
  });

  it('running — enabled', () => {
    renderComposer(makeSession({ state: 'running' }));
    expect(screen.getByTestId('composer-input')).toBeEnabled();
  });

  it('paused — disabled with the resume hint, and no client-side queueing', () => {
    renderComposer(makeSession({ state: 'paused' }));
    const input = screen.getByTestId('composer-input');
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('placeholder', 'Session is paused — resume to continue');
  });

  it('completed — replaced by the completion bar with Resume as new session', () => {
    renderComposer(makeSession({ state: 'completed' }));
    expect(screen.queryByTestId('composer-input')).toBeNull();
    expect(screen.getByText(/Session completed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume as new session' })).toBeInTheDocument();
  });

  it('failed — replaced by the failure banner, which is an alert', () => {
    renderComposer(makeSession({ state: 'failed' }));
    expect(screen.queryByTestId('composer-input')).toBeNull();
    const banner = screen.getByTestId('failure-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('Session failed');
    // The retained partial turn is the operator's evidence; the banner must say so rather
    // than implying the output is gone.
    expect(banner).toHaveTextContent(/partial response above is retained/);
  });

  it('failed — states the reason from the Session, not a placeholder dash', () => {
    renderComposer(makeSession({ state: 'failed', failureReason: 'process_crash' }));

    // §5.5: "reason, `code`, `requestId`". The reason is the answer to the question the
    // operator opened this screen to ask, and it comes off the resource — no timeline fetch.
    expect(screen.getByTestId('failure-detail')).toHaveTextContent('process_crash');
  });

  it('failed — renders `—` when the transition carried no reason', () => {
    renderComposer(makeSession({ state: 'failed', failureReason: null }));

    // Every segment renders even when empty: "no code" and "no line" must not look alike.
    // `requestId` is always `—` today — nothing persists one against a Session.
    expect(screen.getByTestId('failure-detail')).toHaveTextContent('— · requestId —');
  });

  it('archived — read-only bar, Resume as new session and no Clone', () => {
    renderComposer(makeSession({ state: 'archived' }));
    expect(screen.queryByTestId('composer-input')).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume as new session' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clone' })).toBeNull();
  });

  it('observed — no composer at all, in every state', () => {
    const states: readonly SessionState[] = [
      'created',
      'running',
      'paused',
      'completed',
      'failed',
      'archived',
    ];
    for (const state of states) {
      const { unmount } = renderComposer(makeSession({ state, sessionType: 'observed' }));
      expect(screen.queryByTestId('composer-input')).toBeNull();
      expect(screen.getByTestId('observed-bar')).toHaveTextContent('Observed session — read-only');
      unmount();
    }
  });
});

describe('composer keyboard contract (§9.4 / §6.8)', () => {
  it('sends on Ctrl+Enter', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderComposer(makeSession({ state: 'running' }), { value: 'do the thing', onSubmit });

    await user.click(screen.getByTestId('composer-input'));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('does not send an empty prompt', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderComposer(makeSession({ state: 'running' }), { value: '   ', onSubmit });

    await user.click(screen.getByTestId('composer-input'));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled();
  });

  it('Esc steps focus out to the conversation rather than stopping the turn', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    const onSubmit = vi.fn();
    renderComposer(makeSession({ state: 'running' }), { value: 'text', onEscape, onSubmit });

    await user.click(screen.getByTestId('composer-input'));
    await user.keyboard('{Escape}');
    // One press leaves the field. Nothing else happens — a stray Esc while typing must never
    // kill a turn (§6.8).
    expect(onEscape).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('launch queueing and undelivered prompts', () => {
  it('shows the queued-for-launch affordance and keeps the typed prompt', () => {
    renderComposer(makeSession({ state: 'created' }), { launchQueued: true, value: 'first turn' });
    expect(screen.getByText(/Queued for launch/)).toBeInTheDocument();
    expect(screen.getByTestId('composer-input')).toHaveValue('first turn');
  });

  it('offers pause-time prompts back for explicit re-send, never auto-replay', async () => {
    const user = userEvent.setup();
    const onRestorePrompt = vi.fn();
    renderComposer(makeSession({ state: 'paused' }), {
      undeliveredPrompts: ['run the migration'],
      onRestorePrompt,
    });

    expect(screen.getByText(/never replayed automatically/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Put back in composer/ }));
    expect(onRestorePrompt).toHaveBeenCalledWith('run the migration');
  });
});
