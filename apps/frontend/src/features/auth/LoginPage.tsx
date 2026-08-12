import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { useLogin } from './queries.js';
import { sanitizeReturnTo } from './return-to.js';

/**
 * Login (TDS 05 §8, TDS 06 §5.1). The only public route.
 *
 * The SPA never reads or stores the credential or the cookie — success is observed by the
 * response and by `['auth','me']` succeeding afterwards (F5.5). There is no "forgot
 * password" and no registration: a single local account is the whole V1 auth model, and
 * password reset is a CLI concern (`pnpm auth:create-user --reset-password`).
 *
 * The wordmark above the card is the one Phase 1–2 use of the `display-lg` style — the
 * login screen is the only surface with room for the display tier (TDS 06 §5.1).
 */
export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const login = useLogin();
  const usernameRef = useRef<HTMLInputElement>(null);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [revealPassword, setRevealPassword] = useState(false);

  // Validated as an in-app path, never an absolute URL — an open redirect on the one page
  // that takes credentials is the worst place to have one.
  const returnTo = sanitizeReturnTo(searchParams.get('returnTo'));

  useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    login.mutate(
      { username, password },
      {
        onSuccess: () => {
          setPassword('');
          void navigate(returnTo, { replace: true });
        },
      },
    );
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-bg px-4 py-16">
      <h1
        className="font-medium text-3xl text-text"
        style={{ letterSpacing: 'var(--tracking-3xl)' }}
      >
        <span aria-hidden="true" className="mr-3">
          ◆
        </span>
        MISSION CONTROL
      </h1>

      <form
        onSubmit={onSubmit}
        className="mt-8 w-full max-w-sm rounded-xl border border-border bg-surface p-6"
        aria-labelledby="signin-heading"
      >
        <h2 id="signin-heading" className="font-medium text-lg text-text">
          Sign in
        </h2>

        <label htmlFor="username" className="mt-4 block text-text-secondary text-xs">
          Username
        </label>
        <input
          ref={usernameRef}
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          required
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className="mt-1 w-full rounded-sm border px-3 text-md text-text outline-none"
          style={{
            height: 'var(--mc-control-lg)',
            backgroundColor: 'var(--color-surface-inset)',
            // SC 1.4.11: on a near-black canvas no darker fill can reach the 3:1
            // identification floor, so the border is the only element that can carry it.
            borderColor: 'var(--color-border-control)',
          }}
        />

        <label htmlFor="password" className="mt-4 block text-text-secondary text-xs">
          Password
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id="password"
            name="password"
            type={revealPassword ? 'text' : 'password'}
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-sm border px-3 text-md text-text outline-none"
            style={{
              height: 'var(--mc-control-lg)',
              backgroundColor: 'var(--color-surface-inset)',
              borderColor: 'var(--color-border-control)',
            }}
          />
          <button
            type="button"
            aria-pressed={revealPassword}
            aria-label={revealPassword ? 'Hide password' : 'Show password'}
            onClick={() => setRevealPassword((value) => !value)}
            className="rounded-sm border border-border-control px-3 text-sm text-text-secondary"
            style={{ height: 'var(--mc-control-lg)', minWidth: 40 }}
          >
            {revealPassword ? '🙈' : '👁'}
          </button>
        </div>

        <button
          type="submit"
          disabled={login.isPending}
          className="mt-6 w-full rounded-sm font-medium text-sm"
          style={{
            height: 'var(--mc-control-lg)',
            backgroundColor: 'var(--color-accent)',
            color: 'var(--color-on-accent)',
          }}
        >
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>

        {login.isError ? (
          <div className="mt-4">
            {/* §4.3: the inline banner renders the F5.4 envelope — message, `code` chip, and
                the copyable `requestId`. A login failure never distinguishes user from
                password (TDS 04 §1.3 `INVALID_CREDENTIALS`), and the UI must not either. */}
            <ErrorPanel error={login.error} title="Could not sign in" />
          </div>
        ) : null}
      </form>

      <p className="mt-6 text-text-muted text-xs">Self-hosted · single operator</p>
    </div>
  );
}
