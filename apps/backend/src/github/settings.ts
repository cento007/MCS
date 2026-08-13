import {
  type Db,
  normalizeSetting,
  settingKey,
  WORKFLOW_MODES,
  type WorkflowMode,
} from '@mc/shared';
import { SecretUnreadableError, type SecretVault } from '../settings/secrets.js';
import { findSecretRow } from '../settings/store.js';
import { readCategoryValues, readSecretKeys } from '../settings/values.js';

/**
 * The `integrations.github.*` reads this module needs (TDS 04 §7.2, F8.2).
 *
 * Two hard rules, and the type system enforces the first:
 *
 *  1. **`GithubIntegrationSettings` has no token field.** Nothing that returns configuration
 *     can carry the credential, so no caller can accidentally log, serialize or audit one by
 *     handing the settings object to a formatter. The plaintext is reachable only through
 *     `readGithubToken`, which returns a bare `string` inside a discriminated union and hands
 *     it directly to the one consumer that must have it (the client's `authorization` header).
 *  2. **"Not configured" is a distinguishable answer, not a 401.** A missing secret row is
 *     `kind: 'not_configured'`; a row this process cannot decrypt is `kind: 'unreadable'` with
 *     the operator-actionable message `SecretUnreadableError` already writes. Collapsing the
 *     two into "auth failed" would send an operator to regenerate a token that was never saved.
 *
 * Storage coordinates come from the key registry (§7.6), never from constants declared here —
 * `settings/integrations.ts` reads the same rows for the schedule read model and the two must
 * not be able to disagree about what an unwritten row means.
 */

export type { WorkflowMode };
export { WORKFLOW_MODES };

export const GITHUB_SETTING_KEYS = Object.freeze({
  token: settingKey('integrations.github.token'),
  account: settingKey('integrations.github.account'),
  organizations: settingKey('integrations.github.organizations'),
  discoveryRoots: settingKey('integrations.github.discoveryRoots'),
  syncIntervalMinutes: settingKey('integrations.github.syncIntervalMinutes'),
  workflowMode: settingKey('integrations.github.workflowMode'),
} as const);

/** Everything the GitHub integration reads from Settings — **except** the token. */
export interface GithubIntegrationSettings {
  /** `secret_items` presence only (§7.1 `{ isSet }`). */
  readonly tokenIsSet: boolean;
  readonly account: string | null;
  readonly organizations: readonly string[];
  /** Absolute native paths (F8.1), in scan order. */
  readonly discoveryRoots: readonly string[];
  /** `0` = manual only — §7.7 reads `> 0` as "scheduled". */
  readonly syncIntervalMinutes: number;
  /**
   * PRD §4.3. **Phase 1 reads it and behaves identically either way** — assisted PR actions
   * (creation, descriptions, review summaries) are deferred to Phase 2 under sanctioned
   * deviation D8. See `workflow.ts` for the callout this integration is required to carry.
   */
  readonly workflowMode: WorkflowMode;
}

export function parseGithubIntegrationSettings(
  values: ReadonlyMap<string, unknown>,
  secretKeys: ReadonlySet<string>,
): GithubIntegrationSettings {
  return {
    tokenIsSet: secretKeys.has(GITHUB_SETTING_KEYS.token),
    account: normalizeSetting<string | null>(
      'integrations.github.account',
      values.get(GITHUB_SETTING_KEYS.account),
    ),
    organizations: normalizeSetting<readonly string[]>(
      'integrations.github.organizations',
      values.get(GITHUB_SETTING_KEYS.organizations),
    ),
    discoveryRoots: normalizeSetting<readonly string[]>(
      'integrations.github.discoveryRoots',
      values.get(GITHUB_SETTING_KEYS.discoveryRoots),
    ),
    syncIntervalMinutes: normalizeSetting<number>(
      'integrations.github.syncIntervalMinutes',
      values.get(GITHUB_SETTING_KEYS.syncIntervalMinutes),
    ),
    workflowMode: normalizeSetting<WorkflowMode>(
      'integrations.github.workflowMode',
      values.get(GITHUB_SETTING_KEYS.workflowMode),
    ),
  };
}

/** One `settings` read plus one `secret_items` presence read — both bounded by category. */
export async function readGithubIntegrationSettings(db: Db): Promise<GithubIntegrationSettings> {
  const [values, secretKeys] = await Promise.all([
    readCategoryValues(db, 'integrations'),
    readSecretKeys(db, 'integrations'),
  ]);
  return parseGithubIntegrationSettings(values, secretKeys);
}

/**
 * The stored PAT, or a stated reason there is none.
 *
 * `unreadable` carries `SecretUnreadableError.message`, which is written for an operator and
 * contains no ciphertext, no key material and no plaintext.
 */
export type GithubTokenRead =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'not_configured' }
  | { readonly kind: 'unreadable'; readonly message: string; readonly keyVersion: number };

export async function readGithubToken(db: Db, vault: SecretVault): Promise<GithubTokenRead> {
  const row = await findSecretRow(db, 'integrations', GITHUB_SETTING_KEYS.token);
  if (row === null) return { kind: 'not_configured' };

  const coordinate = { category: 'integrations', key: GITHUB_SETTING_KEYS.token } as const;

  try {
    return { kind: 'token', token: vault.open(coordinate, row) };
  } catch (error) {
    if (!(error instanceof SecretUnreadableError)) throw error;
    return { kind: 'unreadable', message: error.message, keyVersion: error.keyVersion };
  }
}

/** The message `POST /repositories/{id}/sync` and `/discover` return when no token is saved. */
export const GITHUB_NOT_CONFIGURED_MESSAGE =
  'No GitHub personal access token is saved. Add one in Settings → Integrations → GitHub, then sync.';
