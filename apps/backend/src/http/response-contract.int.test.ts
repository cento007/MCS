import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedAgent,
  seedProject,
  seedRepository,
  seedSession,
  seedUser,
  type TestApp,
  truncateAll,
} from '../../test/integration/harness.js';
import { agentSchema } from '../agents/response-schemas.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';
import { projectSchema } from '../projects/response-schemas.js';
import { repositorySchema, repositoryStatusSchema } from '../repositories/response-schemas.js';
import { sessionFilesSchema, sessionSchema } from '../sessions/response-schemas.js';
import { conformanceModeFromEnv } from './response-conformance.js';
import type { ResponseSchema } from './response-schema.js';

/**
 * **Full-shape assertions against real responses** — the proof that declaring 100-odd response
 * schemas did not quietly remove a field.
 *
 * The rest of this tier already carries the same guarantee implicitly: `registerResponseConformance`
 * is on under `NODE_ENV=test`, so every one of the ~890 integration tests validates every reply it
 * produces against the schema its route publishes, in both directions. That is broad but silent —
 * it proves the property only for shapes some other test happened to exercise, and it proves it by
 * *not* failing.
 *
 * This file states it directly and narrowly: for the resources whose drift already cost something,
 * the set of keys the API returns is compared to the set of keys the schema declares, key for key.
 * A field the serializer emits and the schema forgot fails here as an extra; a field the schema
 * declares and the serializer stopped emitting fails as a missing one. Spot-checking a couple of
 * fields would not do — the defect being guarded against is precisely a field nobody thought to
 * assert on.
 */

let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let userId: string;

beforeEach(async () => {
  await truncateAll();

  const user = await seedUser();
  userId = user.id;

  built = createTestApp({ cookieSecure: false });
  app = built.app;

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME);
});

afterEach(async () => {
  await built?.sessions.registry.stop();
  await built?.app.close();
});

async function get(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'GET',
    url,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
  });
  return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
}

/** The property names a schema declares, in sorted order. */
function declaredKeys(schema: ResponseSchema): string[] {
  return Object.keys((schema['properties'] ?? {}) as Record<string, unknown>).sort();
}

function servedKeys(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>).sort();
}

describe('every declared response schema matches the resource the API actually serves', () => {
  it('is checking at all — the conformance hook is on in this tier', () => {
    // If this ever reads `off`, every other assertion in the tier stops being a contract check
    // and the silence below means nothing.
    expect(conformanceModeFromEnv()).toBe('on');
  });

  it('Session — the resource whose missing `agentId` made the agent binding unreachable', async () => {
    const { projectId } = await seedProject();
    const agentId = await seedAgent({ scope: 'global' });
    const repositoryId = await seedRepository(projectId);
    const sessionId = await seedSession({
      projectId,
      userId,
      repositoryId,
      agentId,
      title: 'Narrow the runtime CHECK',
    });

    const { status, body } = await get(`/api/v1/sessions/${sessionId}`);
    expect(status).toBe(200);
    expect(servedKeys(body['data'])).toEqual(declaredKeys(sessionSchema));

    // Named explicitly, because a key-set comparison would still pass if both sides lost it
    // together — and this is the field that was lost.
    expect((body['data'] as { agentId: string }).agentId).toBe(agentId);
  });

  it('Session, as a list item — the same schema, so the same keys', async () => {
    const { projectId } = await seedProject();
    await seedSession({ projectId, userId });

    const { body } = await get('/api/v1/sessions');
    const rows = body['data'] as readonly unknown[];
    expect(rows).toHaveLength(1);
    expect(servedKeys(rows[0])).toEqual(declaredKeys(sessionSchema));
    expect(servedKeys(body['meta'])).toEqual(['limit', 'nextCursor']);
  });

  it('Agent — including `disallowedTools`, which is derived and easy to forget', async () => {
    const agentId = await seedAgent({ scope: 'global' });

    const { body } = await get(`/api/v1/agents/${agentId}`);
    expect(servedKeys(body['data'])).toEqual(declaredKeys(agentSchema));
    expect(Array.isArray((body['data'] as { disallowedTools: unknown }).disallowedTools)).toBe(
      true,
    );
  });

  it('Project', async () => {
    const { projectId } = await seedProject();
    const { body } = await get(`/api/v1/projects/${projectId}`);
    expect(servedKeys(body['data'])).toEqual(declaredKeys(projectSchema));
  });

  it('Repository, and the computed working-tree read model beside it', async () => {
    const { projectId } = await seedProject();
    const repositoryId = await seedRepository(projectId);

    const repository = await get(`/api/v1/repositories/${repositoryId}`);
    expect(servedKeys(repository.body['data'])).toEqual(declaredKeys(repositorySchema));

    const status = await get(`/api/v1/repositories/${repositoryId}/status`);
    expect(status.status).toBe(200);
    expect(servedKeys(status.body['data'])).toEqual(declaredKeys(repositoryStatusSchema));
  });

  it('the Session Files read model, whose `completeness` fields are contractual', async () => {
    const { projectId } = await seedProject();
    const sessionId = await seedSession({ projectId, userId });

    const { status, body } = await get(`/api/v1/sessions/${sessionId}/files`);
    expect(status).toBe(200);
    expect(servedKeys(body['data'])).toEqual(declaredKeys(sessionFilesSchema));
    // §1.2: a bounded read model carries no `meta`, and the schema is what says so.
    expect(servedKeys(body)).toEqual(['data']);
  });
});
