import { settingKey, settingsForCategory, settingsForIntegration } from '@mc/shared';
import { describe, expect, it } from 'vitest';
import type { ApiError } from '../http/errors.js';
import {
  categoryDocument,
  categoryWritePlan,
  EMPTY_CATEGORY,
  integrationDocument,
  integrationsDocument,
  integrationWritePlan,
  planWrite,
  type StoredCategory,
  valuesEqual,
} from './documents.js';
import type { SecretPresence } from './values.js';

/**
 * Category documents in and out (TDS 04 §7.1–§7.3, arbitration A14) — **no database, no
 * Fastify**. Everything that decides what a save means is pure and lives here, which is why
 * the semantics that would otherwise only be observable through PostgreSQL are provable in the
 * unit tier (TDS 07 §1).
 */

const key = settingKey;

function stored(
  values: Record<string, unknown>,
  secrets: Record<string, Date> = {},
): StoredCategory {
  return {
    values: new Map(Object.entries(values)),
    secrets: new Map<string, SecretPresence>(
      Object.entries(secrets).map(([secretKey, updatedAt]) => [
        secretKey,
        { id: `id-${secretKey}`, updatedAt, keyVersion: 1 },
      ]),
    ),
  };
}

describe('reading a document (§7.1–§7.2)', () => {
  it('serves a complete document from an empty database', () => {
    // The first boot has zero rows. A blank form would look like configuration; defaults are
    // what let the Settings page render the truth on day one.
    expect(categoryDocument('general', EMPTY_CATEGORY)).toEqual({
      instanceName: 'Mission Control',
      timezone: 'UTC',
      dateFormat: 'YYYY-MM-DD',
      timeFormat: '24h',
      theme: 'dark',
      defaultLandingPage: 'dashboard',
    });

    expect(categoryDocument('security', EMPTY_CATEGORY)).toEqual({
      sessionTimeoutMinutes: 10_080,
      auditLogRetentionDays: 180,
      allowedOrigins: [],
    });
  });

  it('overlays stored rows on the defaults, field by field', () => {
    const document = categoryDocument('general', stored({ timezone: 'Europe/Amsterdam' }));

    expect(document['timezone']).toBe('Europe/Amsterdam');
    expect(document['theme']).toBe('dark');
  });

  it('repairs a corrupt row instead of failing the page', () => {
    const document = categoryDocument(
      'general',
      stored({ timezone: 'Mars/Olympus', theme: 42, dateFormat: null }),
    );

    expect(document).toMatchObject({ timezone: 'UTC', theme: 'dark', dateFormat: 'YYYY-MM-DD' });
  });

  it('masks a secret as `{ isSet, updatedAt }` and never as a value (§7.1, A15)', () => {
    const savedAt = new Date('2026-08-10T09:14:00.000Z');
    const document = integrationDocument(
      'github',
      stored({}, { [key('integrations.github.token')]: savedAt }),
    );

    expect(document['token']).toEqual({ isSet: true, updatedAt: '2026-08-10T09:14:00.000Z' });
    expect(JSON.stringify(document)).not.toContain('ciphertext');
  });

  it('reports an unset secret as `{ isSet: false, updatedAt: null }`', () => {
    expect(integrationDocument('telegram', EMPTY_CATEGORY)['botToken']).toEqual({
      isSet: false,
      updatedAt: null,
    });
  });

  it('builds all six integrations under their camelCase document fields', () => {
    const document = integrationsDocument(EMPTY_CATEGORY);

    expect(Object.keys(document)).toEqual([
      'github',
      'claudeCode',
      'telegram',
      'obsidian',
      'qdrant',
      'ollama',
    ]);
    expect(document.claudeCode.costBudget).toEqual({
      dailyUsd: null,
      perSessionUsd: null,
      alertThresholdPercent: 80,
    });
  });
});

describe('full-category replace (arbitration A14)', () => {
  it('plans a value for EVERY field in scope, not only the ones sent', () => {
    const plan = categoryWritePlan('general', { timezone: 'Europe/Amsterdam' });

    expect([...plan.values.keys()].sort()).toEqual(
      settingsForCategory('general')
        .map((entry) => entry.key)
        .sort(),
    );
  });

  it('resets an omitted non-secret field to its registry default', () => {
    // This is the whole of A14: the body is the new state of the category, in full. A partial
    // body against a full replace is how untouched fields get silently erased — so the
    // semantics are stated here rather than left to whichever client sends the request.
    const plan = categoryWritePlan('general', { theme: 'light' });

    expect(plan.values.get(key('general.theme'))?.value).toBe('light');
    expect(plan.values.get(key('general.timezone'))?.value).toBe('UTC');
    expect(plan.values.get(key('general.instanceName'))?.value).toBe('Mission Control');
  });

  it('keeps an omitted secret — the client cannot resend what it may not read (§7.1)', () => {
    const plan = integrationWritePlan('github', { account: 'cento007' });

    expect(plan.secrets.size).toBe(0);
  });

  it('clears a secret sent as `null`', () => {
    const plan = integrationWritePlan('github', { token: null });

    expect(plan.secrets.get(key('integrations.github.token'))?.instruction).toEqual({
      kind: 'clear',
    });
  });

  it('sets a secret sent as a string, and carries the plaintext no further than the plan', () => {
    const plan = integrationWritePlan('github', { token: 'ghp_example' });

    expect(plan.secrets.get(key('integrations.github.token'))?.instruction).toEqual({
      kind: 'set',
      plaintext: 'ghp_example',
    });
    // The plan is internal; nothing serialises it. The document built from storage is what a
    // response is made of, and it has no field that could carry the value.
    expect(JSON.stringify(integrationDocument('github', EMPTY_CATEGORY))).not.toContain(
      'ghp_example',
    );
  });

  it('canonicalises values on the way in, so a read-back equals the write', () => {
    const plan = integrationWritePlan('github', {
      discoveryRoots: [' D:\\Repos ', 'D:\\Repos', ''],
      account: '   ',
    });

    expect(plan.values.get(key('integrations.github.discoveryRoots'))?.value).toEqual([
      'D:\\Repos',
    ]);
    expect(plan.values.get(key('integrations.github.account'))?.value).toBeNull();
  });

  it('rejects an unknown field by name rather than ignoring it', () => {
    // Ajv would silently *delete* it (`removeAdditional: true`), and a deleted field under
    // full-replace semantics is a reset of the field the caller meant to set.
    let thrown: ApiError | null = null;
    try {
      categoryWritePlan('general', { instanceNam: 'typo', timezone: 'UTC' });
    } catch (error) {
      thrown = error as ApiError;
    }

    expect(thrown?.code).toBe('VALIDATION_FAILED');
    expect(thrown?.message).toContain('instanceNam');
    expect(thrown?.details?.['unknownFields']).toEqual(['instanceNam']);
  });

  it('treats a non-object body as "everything omitted" rather than throwing', () => {
    const plan = planWrite(settingsForIntegration('ollama'), null);

    expect(plan.values.get(key('integrations.ollama.port'))?.value).toBe(11434);
  });

  it('ignores a secret sent as an empty string — an empty secret is not a secret', () => {
    // `encryptSecret` refuses to seal `''` (TDS 03 §3.13: clearing is a DELETE), so the plan
    // must not produce an instruction the store cannot carry out.
    const plan = integrationWritePlan('telegram', { botToken: '' });

    expect(plan.secrets.size).toBe(0);
  });
});

describe('valuesEqual', () => {
  it('compares normalized values structurally, including nested objects and lists', () => {
    expect(valuesEqual({ a: 1, b: null }, { a: 1, b: null })).toBe(true);
    expect(valuesEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(valuesEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(valuesEqual(null, undefined)).toBe(true);
    expect(valuesEqual(0, null)).toBe(false);
  });
});
