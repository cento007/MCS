import {
  type Db,
  INTEGRATION_SLUGS,
  type IntegrationSlug,
  type IntegrationsSettings,
  type SettingsDocument,
} from '@mc/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../auth/principal.js';
import { registerHttpConventions } from '../http/index.js';
import { registerSettingsRoutes, type SettingsPort, type TestConnectionPort } from './routes.js';
import { SecretVault } from './secrets.js';
import { TestConnectionService } from './test-connection/index.js';

/**
 * The `/api/v1/settings/*` routing surface — **no database, no auth guard** (TDS 07 §1; the
 * guard is covered by the integration tier).
 *
 * What is worth testing at this layer is exactly what the layer decides: which path reaches
 * which handler, what an unknown category answers, and what the router does — and does not do
 * — to a body on its way through.
 */

const NO_DATABASE = new Proxy(
  {},
  {
    get() {
      throw new Error('unit tests must not touch the database');
    },
  },
) as Db;

const PRINCIPAL: Principal = {
  userId: '018f6b2e-1111-7abc-8def-0123456789ab',
  username: 'operator',
  authMethod: 'cookie',
  scopes: ['full'],
  authSession: null,
  apiToken: null,
};

function fakeSettings(overrides: Partial<SettingsPort> = {}): SettingsPort {
  return {
    readAll: overrides.readAll ?? (async () => ({ general: {} }) as unknown as SettingsDocument),
    readCategory: overrides.readCategory ?? (async (category) => ({ category })),
    readIntegrations:
      overrides.readIntegrations ?? (async () => ({}) as unknown as IntegrationsSettings),
    replaceCategory: overrides.replaceCategory ?? (async (_p, category) => ({ category })),
    replaceIntegration: overrides.replaceIntegration ?? (async (_p, slug) => ({ slug })),
  };
}

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

function build(
  settings: SettingsPort = fakeSettings(),
  testConnection: TestConnectionPort = new TestConnectionService({
    // The real service by default. Every executor reads persisted settings before it does
    // anything, so the proxy above is what proves a route reached the handler at all.
    db: NO_DATABASE,
    vault: new SecretVault({ encryptionKey: null }),
  }),
): FastifyInstance {
  const instance = Fastify({ logger: false });
  registerHttpConventions(instance);
  // The guard is not registered here; a principal is supplied so `requirePrincipal` behaves as
  // it does in production without pulling the whole auth stack into a routing test.
  instance.decorateRequest('principal', null);
  instance.addHook('onRequest', async (request) => {
    request.principal = PRINCIPAL;
  });

  registerSettingsRoutes(instance, { settings, testConnection });

  app = instance;
  return instance;
}

/** Records which slug the router dispatched, and answers a fixed result. */
function recordingTestConnection(): TestConnectionPort & { readonly slugs: IntegrationSlug[] } {
  const slugs: IntegrationSlug[] = [];
  return {
    slugs,
    async run(slug) {
      slugs.push(slug);
      return {
        ok: true,
        checkedAt: '2026-08-13T09:00:00.000Z',
        latencyMs: 1,
        message: `checked ${slug}`,
        detail: null,
      };
    },
  };
}

describe('reads (§7.3)', () => {
  it('serves one category', async () => {
    const response = await build().inject({ method: 'GET', url: '/api/v1/settings/general' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { category: 'general' } });
  });

  it('serves the whole document', async () => {
    const response = await build().inject({ method: 'GET', url: '/api/v1/settings' });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json<{ data: unknown }>())).toEqual(['data']);
  });

  it('routes `integrations` to the static route, not to the category handler', async () => {
    const readCategory = vi.fn<SettingsPort['readCategory']>(async () => ({}));
    const response = await build(fakeSettings({ readCategory })).inject({
      method: 'GET',
      url: '/api/v1/settings/integrations',
    });

    expect(response.statusCode).toBe(200);
    expect(readCategory).not.toHaveBeenCalled();
  });

  it('answers NOT_FOUND for a category that does not exist (§7.3)', async () => {
    const response = await build().inject({ method: 'GET', url: '/api/v1/settings/favourites' });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('serves the Phase 3/4 placeholder categories rather than 404ing them', async () => {
    // They exist in the storage CHECK and in the Settings rail; a 404 would tell the UI the
    // category is unknown, which is a different statement from "it has no fields yet".
    for (const category of ['memory', 'agents']) {
      const response = await build().inject({
        method: 'GET',
        url: `/api/v1/settings/${category}`,
      });
      expect(response.statusCode).toBe(200);
    }
  });
});

describe('writes (§7.3)', () => {
  it('replaces a category and answers with the masked document', async () => {
    const replaceCategory = vi.fn<SettingsPort['replaceCategory']>(async () => ({
      theme: 'light',
    }));
    const response = await build(fakeSettings({ replaceCategory })).inject({
      method: 'PUT',
      url: '/api/v1/settings/general',
      payload: { theme: 'light' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { theme: 'light' } });
    expect(replaceCategory.mock.calls[0]?.[0]).toBe(PRINCIPAL);
  });

  it('rejects a value outside the registry schema before the domain sees it', async () => {
    const replaceCategory = vi.fn<SettingsPort['replaceCategory']>(async () => ({}));
    const response = await build(fakeSettings({ replaceCategory })).inject({
      method: 'PUT',
      url: '/api/v1/settings/general',
      payload: { theme: 'chartreuse' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
    expect(replaceCategory).not.toHaveBeenCalled();
  });

  it('rejects an unknown field by name instead of stripping it', async () => {
    // Ajv would delete it under `removeAdditional: true`, and a deleted field is a *reset*
    // under full-replace semantics: `instanceNam` vanishes, `instanceName` reads as omitted,
    // and the operator's instance name is quietly overwritten with the registry default.
    //
    // This used to be caught one layer in, by the write planner, and the assertion here was
    // that the field *arrived* so the planner could name it. The global body guard
    // (`http/body-strictness.ts`) now answers first with the same verdict, so the field never
    // reaches the domain at all — a 400 naming `instanceNam`, and no write attempted. The
    // planner keeps its own check for callers that do not come in over HTTP; that is
    // `documents.test.ts`.
    const replaceCategory = vi.fn<SettingsPort['replaceCategory']>(async () => ({}));
    const response = await build(fakeSettings({ replaceCategory })).inject({
      method: 'PUT',
      url: '/api/v1/settings/general',
      payload: { theme: 'dark', instanceNam: 'typo' },
    });

    expect(response.statusCode).toBe(400);
    const error = response.json<{ error: { code: string; details: Record<string, unknown> } }>()
      .error;
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details['unknownFields']).toEqual(['instanceNam']);
    expect(replaceCategory).not.toHaveBeenCalled();
  });

  it('accepts a secret as a string or as `null`, and refuses `""`', async () => {
    const instance = build();

    const set = await instance.inject({
      method: 'PUT',
      url: '/api/v1/settings/integrations/github',
      payload: { token: 'ghp_example' },
    });
    const cleared = await instance.inject({
      method: 'PUT',
      url: '/api/v1/settings/integrations/github',
      payload: { token: null },
    });
    const empty = await instance.inject({
      method: 'PUT',
      url: '/api/v1/settings/integrations/github',
      payload: { token: '' },
    });

    expect(set.statusCode).toBe(200);
    expect(cleared.statusCode).toBe(200);
    expect(empty.statusCode).toBe(400);
  });

  it('points a `PUT /settings/integrations` at the per-integration route', async () => {
    const response = await build().inject({
      method: 'PUT',
      url: '/api/v1/settings/integrations',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const error = response.json<{ error: { code: string; message: string } }>().error;
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toContain('/settings/integrations/{integration}');
  });

  it('answers NOT_FOUND for a PUT to an unknown category or integration', async () => {
    const instance = build();

    const category = await instance.inject({
      method: 'PUT',
      url: '/api/v1/settings/favourites',
      payload: {},
    });
    const integration = await instance.inject({
      method: 'PUT',
      url: '/api/v1/settings/integrations/pinecone',
      payload: {},
    });

    expect(category.statusCode).toBe(404);
    expect(integration.statusCode).toBe(404);
  });
});

describe('test connection (§7.4)', () => {
  it('routes every defined integration to the service, Phase 3 ones included', async () => {
    // `qdrant` and `ollama` used to be refused here with "Phase 3 — there is no client for it
    // yet". There is now: both are reached like any other integration and answer from persisted
    // settings, so what this layer still owns is only *which slug reached the service*.
    const service = recordingTestConnection();
    const instance = build(fakeSettings(), service);

    for (const slug of INTEGRATION_SLUGS) {
      const response = await instance.inject({
        method: 'POST',
        url: `/api/v1/settings/integrations/${slug}/test-connection`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ data: { message: string } }>().data.message).toBe(`checked ${slug}`);
    }

    expect(service.slugs).toEqual([...INTEGRATION_SLUGS]);
  });

  it('has no test-connection route for an integration nobody defined', async () => {
    const response = await build().inject({
      method: 'POST',
      url: '/api/v1/settings/integrations/pinecone/test-connection',
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a request body — a test can only ever cover persisted state (WS5 §5.7.2)', async () => {
    const service = recordingTestConnection();
    const response = await build(fakeSettings(), service).inject({
      method: 'POST',
      url: '/api/v1/settings/integrations/qdrant/test-connection',
      payload: { host: 'unsaved-value' },
    });

    // The body used to be ignored, and the answer was the same as without it. That is the worst
    // of both: a caller who sends `{ host }` believes they are testing an unsaved value, and
    // gets a verdict about the *stored* one with nothing to distinguish the two. The route
    // declares no body schema, so the body guard says so — 400, naming `host`.
    expect(response.statusCode).toBe(400);
    const error = response.json<{ error: { code: string; details: Record<string, unknown> } }>()
      .error;
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details['unknownFields']).toEqual(['host']);
    // And it was refused *before* the service ran: an unsaved value must never be tested, not
    // even by a check that would have ignored it.
    expect(service.slugs).toEqual([]);

    // Without a body the same route reaches the service and returns its result.
    const bodiless = await build(fakeSettings(), service).inject({
      method: 'POST',
      url: '/api/v1/settings/integrations/qdrant/test-connection',
    });
    expect(bodiless.statusCode).toBe(200);
    expect(service.slugs).toEqual(['qdrant']);
  });
});
