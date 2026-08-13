import { agentPermissionsFromTemplate, type EventEnvelope, schema } from '@mc/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedAgent,
  seedProject,
  seedSession,
  seedUser,
  setSetting,
  type TestApp,
  testDatabase,
  testWorkingDirectory,
  truncateAll,
} from '../../test/integration/harness.js';
import { createFakeRuntime, type FakeRuntime } from '../../test/support/fake-runtime.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';

/**
 * The Agent framework end to end — PRD §5, TDS 04 §13.2 — against a real database.
 *
 * Three things are worth stating about what this file is for, because they are the three claims a
 * reviewer should not have to take on trust:
 *
 *  1. **The scope invariant is the database's**, not the service's. The first block writes rows
 *     directly, bypassing every line of validation code, and PostgreSQL still refuses them.
 *  2. **Permissions are not decoration.** The launch block reads back what the runtime port was
 *     actually handed, so "the agent's instructions reach the runtime" and "a denied capability
 *     removes tools" are observations rather than intentions.
 *  3. **`agents.defaultPermissionTemplate` is read.** There is a test that changes the setting and
 *     observes a different agent, which is the only thing that makes shipping it honest.
 */

let app: TestApp;
let cookie: string;
let runtime: FakeRuntime;
let projectId: string;
let userId: string;
let events: EventEnvelope[];

beforeEach(async () => {
  await truncateAll();

  runtime = createFakeRuntime();
  app = createTestApp({ runtime });

  events = [];
  app.bus.subscribeAll((event) => {
    events.push(event);
  });

  const user = await seedUser();
  userId = user.id;

  const login = await app.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = `${SESSION_COOKIE_NAME}=${cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME)}`;

  ({ projectId } = await seedProject());
});

async function post(url: string, body: Record<string, unknown> = {}) {
  return app.app.inject({ method: 'POST', url, headers: { cookie }, payload: body });
}
async function patch(url: string, body: Record<string, unknown> = {}) {
  return app.app.inject({ method: 'PATCH', url, headers: { cookie }, payload: body });
}
async function get(url: string) {
  return app.app.inject({ method: 'GET', url, headers: { cookie } });
}

/** Insert straight into `agents`, with no service, no route and no validation in the way. */
async function rawInsert(values: Record<string, unknown>): Promise<void> {
  await testDatabase()
    .db.insert(schema.agents)
    .values({
      name: 'Raw',
      permissions: agentPermissionsFromTemplate('read_only'),
      ...values,
    } as never);
}

/**
 * Assert that PostgreSQL refused a write, and that it refused it **by name**.
 *
 * Not `rejects.toThrow(/name/)`: Drizzle wraps the driver error, so its own `message` is only
 * "Failed query: insert into …" and the constraint name lives on `error.cause`. Matching the
 * wrapper would pass for any failed write at all — including a typo in the fixture — which would
 * make every constraint test in this file vacuous. (Same helper, same reasoning, as
 * `memory/memory.int.test.ts`.)
 */
async function expectRejectedBy(work: Promise<unknown>, constraint: string): Promise<void> {
  let thrown: unknown;
  try {
    await work;
  } catch (error) {
    thrown = error;
  }

  if (thrown === undefined) {
    throw new Error(`Expected the write to be rejected by ${constraint}, but it succeeded`);
  }

  const chain: string[] = [];
  let current: unknown = thrown;
  while (current instanceof Error) {
    chain.push(current.message);
    current = current.cause;
  }
  expect(chain.join(' | ')).toContain(constraint);
}

// ---------------------------------------------------------------------------------------------

describe('the scope invariant is enforced by PostgreSQL', () => {
  it('stores each scope with exactly its own target', async () => {
    const sessionId = await seedSession({ projectId, userId });

    await expect(rawInsert({ id: id(), scope: 'global' })).resolves.toBeUndefined();
    await expect(rawInsert({ id: id(), scope: 'project', projectId })).resolves.toBeUndefined();
    await expect(rawInsert({ id: id(), scope: 'session', sessionId })).resolves.toBeUndefined();
  });

  it('REJECTS a project-scoped agent with no project', async () => {
    // The whole reason this constraint exists: such an agent would be offered by no
    // project-scoped query and usable by nobody — present in the table and absent from the
    // product.
    await expectRejectedBy(rawInsert({ id: id(), scope: 'project' }), 'ck_agents_scope_target');
  });

  it('REJECTS a session-scoped agent with no session', async () => {
    await expectRejectedBy(rawInsert({ id: id(), scope: 'session' }), 'ck_agents_scope_target');
  });

  it('REJECTS a global agent that names a project or a session', async () => {
    const sessionId = await seedSession({ projectId, userId });

    await expectRejectedBy(
      rawInsert({ id: id(), scope: 'global', projectId }),
      'ck_agents_scope_target',
    );
    await expectRejectedBy(
      rawInsert({ id: id(), scope: 'global', sessionId }),
      'ck_agents_scope_target',
    );
  });

  it('REJECTS an agent that names both a project and a session', async () => {
    const sessionId = await seedSession({ projectId, userId });

    await expectRejectedBy(
      rawInsert({ id: id(), scope: 'project', projectId, sessionId }),
      'ck_agents_scope_target',
    );
  });

  it('REJECTS an unknown scope', async () => {
    await expectRejectedBy(rawInsert({ id: id(), scope: 'workspace' }), 'ck_agents_scope');
  });

  it('REJECTS a runtime that cannot be launched', async () => {
    // PRD §5.4 lists Ollama; nothing can run it, so the CHECK does not admit it.
    await expectRejectedBy(
      rawInsert({ id: id(), scope: 'global', runtime: 'ollama' }),
      'ck_agents_runtime',
    );
  });
});

describe('the permission document is enforced by PostgreSQL', () => {
  it('REJECTS a half-written permission object', async () => {
    // `disallowedToolsFor` has no `else` branch: a missing `write` would read as `undefined` and
    // produce a *smaller* deny list — a more capable agent than the row describes.
    await expectRejectedBy(
      rawInsert({ id: id(), scope: 'global', permissions: { repository: { read: true } } }),
      'ck_agents_permissions_shape',
    );
    await expectRejectedBy(
      rawInsert({ id: id(), scope: 'global', permissions: {} }),
      'ck_agents_permissions_shape',
    );
  });

  it('REJECTS a shell grant that outlives read or write', async () => {
    await expectRejectedBy(
      rawInsert({
        id: id(),
        scope: 'global',
        permissions: { repository: { read: true, write: false, shell: true } },
      }),
      'ck_agents_permissions_shell_subsumes',
    );
  });
});

// ---------------------------------------------------------------------------------------------

describe('POST /api/v1/agents', () => {
  it('creates a global agent and derives its deny list', async () => {
    const response = await post('/api/v1/agents', {
      name: 'Architect',
      description: 'Designs before it builds',
      scope: 'global',
      instructions: 'You are the Architect. Produce ADRs, not code.',
      permissions: { repository: { read: true, write: false, shell: false } },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      name: 'Architect',
      scope: 'global',
      projectId: null,
      sessionId: null,
      runtime: 'claude_code',
      permissions: { repository: { read: true, write: false, shell: false } },
      instructions: 'You are the Architect. Produce ADRs, not code.',
      archivedAt: null,
    });
    // Derived, not stored — the operator can see what the grant actually costs the runtime.
    expect(response.json().data.disallowedTools).toContain('Bash');
    expect(response.json().data.disallowedTools).toContain('Write');
    expect(response.json().data.disallowedTools).not.toContain('Read');
  });

  it('emits agent.created through the outbox', async () => {
    const created = await post('/api/v1/agents', { name: 'QA', scope: 'global' });

    const emitted = events.filter((event) => event.type === 'agent.created');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toMatchObject({
      agentId: created.json().data.id,
      scope: 'global',
    });
  });

  it('records the permission document in the audit log', async () => {
    const created = await post('/api/v1/agents', { name: 'QA', scope: 'global' });

    const rows = await testDatabase()
      .db.select()
      .from(schema.auditLogEntries)
      .where(eq(schema.auditLogEntries.entityId, created.json().data.id));

    expect(rows[0]).toMatchObject({ actorType: 'user', action: 'agent.created' });
    expect(rows[0]?.after).toMatchObject({
      permissions: { repository: { read: true, write: false, shell: false } },
    });
  });

  it('applies settings.agents.defaultPermissionTemplate when permissions are omitted', async () => {
    const before = await post('/api/v1/agents', { name: 'Default', scope: 'global' });
    expect(before.json().data.permissions).toEqual({
      repository: { read: true, write: false, shell: false },
    });

    // The test that makes shipping the setting honest: change it, and a later create differs.
    await setSetting('agents', 'default_permission_template', 'read_write');

    const after = await post('/api/v1/agents', { name: 'After', scope: 'global' });
    expect(after.json().data.permissions).toEqual({
      repository: { read: true, write: true, shell: false },
    });
  });

  it('distinguishes an omitted `permissions` from an empty one', async () => {
    // Omitted means "use the install default"; `{}` means "grant nothing". Collapsing the two
    // would make the strictest possible agent unexpressible.
    const empty = await post('/api/v1/agents', {
      name: 'Nothing',
      scope: 'global',
      permissions: {},
    });

    expect(empty.json().data.permissions).toEqual({
      repository: { read: false, write: false, shell: false },
    });
  });

  it('refuses a project scope with no project, naming the field', async () => {
    const response = await post('/api/v1/agents', { name: 'Orphan', scope: 'project' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'projectId' },
    });
    expect(response.json().error.requestId).toEqual(expect.any(String));
  });

  it('refuses a project that does not exist', async () => {
    const response = await post('/api/v1/agents', {
      name: 'Ghost',
      scope: 'project',
      projectId: id(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.details).toMatchObject({ field: 'projectId' });
  });

  it('refuses a shell grant without read and write', async () => {
    const response = await post('/api/v1/agents', {
      name: 'Half',
      scope: 'global',
      permissions: { repository: { read: true, write: false, shell: true } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.details).toMatchObject({
      field: 'permissions.repository.shell',
    });
  });

  it('refuses an unknown permission field rather than dropping it', async () => {
    // A misspelt `wrote` silently deleted by Ajv would read as `write: false` — the operator
    // would be told the agent may not write and be right for the wrong reason.
    const response = await post('/api/v1/agents', {
      name: 'Typo',
      scope: 'global',
      permissions: { repository: { read: true, wrote: true } },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a second live agent with the same name in the same scope', async () => {
    await post('/api/v1/agents', { name: 'Security', scope: 'global' });
    const duplicate = await post('/api/v1/agents', { name: 'Security', scope: 'global' });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('CONFLICT');
  });

  it('allows the same name in a different project', async () => {
    const other = await seedProject('Other');

    const first = await post('/api/v1/agents', { name: 'Architect', scope: 'project', projectId });
    const second = await post('/api/v1/agents', {
      name: 'Architect',
      scope: 'project',
      projectId: other.projectId,
    });

    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
  });
});

describe('GET /api/v1/agents', () => {
  it('paginates with an opaque cursor and hides archived agents by default', async () => {
    await seedAgent({ name: 'A' });
    await seedAgent({ name: 'B' });
    const retired = await seedAgent({ name: 'C', archivedAt: new Date() });

    const page = await get('/api/v1/agents?limit=2');
    expect(page.statusCode).toBe(200);
    expect(page.json().data).toHaveLength(2);
    expect(page.json().meta).toMatchObject({ limit: 2, nextCursor: expect.any(String) });

    const all = await get('/api/v1/agents');
    expect(all.json().data.map((row: { id: string }) => row.id)).not.toContain(retired);

    const withArchived = await get('/api/v1/agents?includeArchived=true');
    expect(withArchived.json().data.map((row: { id: string }) => row.id)).toContain(retired);
  });

  it('filters by scope and project', async () => {
    await seedAgent({ name: 'Global' });
    const scoped = await seedAgent({ name: 'Scoped', scope: 'project', projectId });

    const response = await get(`/api/v1/agents?scope=project&projectId=${projectId}`);
    expect(response.json().data.map((row: { id: string }) => row.id)).toEqual([scoped]);
  });

  it('rejects an unknown filter instead of ignoring it', async () => {
    const response = await get('/api/v1/agents?scoep=project');

    expect(response.statusCode).toBe(400);
    expect(response.json().error.details).toMatchObject({ unknownParameters: ['scoep'] });
  });
});

describe('PATCH /api/v1/agents/{id}', () => {
  it('updates permissions and re-derives the deny list', async () => {
    const agentId = await seedAgent({
      name: 'Dev',
      permissions: agentPermissionsFromTemplate('full'),
    });

    const response = await patch(`/api/v1/agents/${agentId}`, {
      permissions: { repository: { read: true, write: true, shell: false } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.disallowedTools).toContain('Bash');
    expect(response.json().data.disallowedTools).not.toContain('Write');
  });

  it('emits agent.updated with the fields that changed', async () => {
    const agentId = await seedAgent({ name: 'Dev' });

    await patch(`/api/v1/agents/${agentId}`, { instructions: 'Be terse.' });

    const emitted = events.filter((event) => event.type === 'agent.updated');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toMatchObject({
      agentId,
      changedFields: ['instructions'],
      archived: false,
    });
  });

  it('archives and un-archives, which is what this system has instead of DELETE', async () => {
    const agentId = await seedAgent({ name: 'Retiring' });

    const archived = await patch(`/api/v1/agents/${agentId}`, { archived: true });
    expect(archived.json().data.archivedAt).toEqual(expect.any(String));

    // Reversible — the whole argument for archive over delete is that nothing is lost.
    const restored = await patch(`/api/v1/agents/${agentId}`, { archived: false });
    expect(restored.json().data.archivedAt).toBeNull();
  });

  it('frees the name for a replacement once archived', async () => {
    const agentId = await seedAgent({ name: 'Architect' });
    await patch(`/api/v1/agents/${agentId}`, { archived: true });

    const replacement = await post('/api/v1/agents', { name: 'Architect', scope: 'global' });
    expect(replacement.statusCode).toBe(201);
  });

  it('refuses to change scope, at the boundary', async () => {
    const agentId = await seedAgent({ name: 'Fixed' });

    const response = await patch(`/api/v1/agents/${agentId}`, { scope: 'project', projectId });
    expect(response.statusCode).toBe(400);
  });

  it('answers NOT_FOUND for an unknown id', async () => {
    const response = await patch(`/api/v1/agents/${id()}`, { name: 'Nobody' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});

describe('there is no DELETE', () => {
  it('answers 404 rather than erasing an agent past sessions point at', async () => {
    const agentId = await seedAgent({ name: 'Permanent' });

    const response = await app.app.inject({
      method: 'DELETE',
      url: `/api/v1/agents/${agentId}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------

describe('binding an agent to a session', () => {
  async function createSession(body: Record<string, unknown> = {}) {
    return post('/api/v1/sessions', {
      projectId,
      workingDirectory: testWorkingDirectory(),
      ...body,
    });
  }

  it('binds a global agent at create time and reports it on the resource', async () => {
    const agentId = await seedAgent({ name: 'Architect' });

    const response = await createSession({ agentId });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.agentId).toBe(agentId);
  });

  it('refuses a project-scoped agent from another project', async () => {
    const other = await seedProject('Other');
    const agentId = await seedAgent({
      name: 'Foreign',
      scope: 'project',
      projectId: other.projectId,
    });

    const response = await createSession({ agentId });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.details).toMatchObject({ field: 'agentId' });
  });

  it('refuses an archived agent with CONFLICT, not with a validation error', async () => {
    const agentId = await seedAgent({ name: 'Retired', archivedAt: new Date() });

    const response = await createSession({ agentId });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
  });

  it('binds a session-scoped agent through PATCH, which is the only order that can work', async () => {
    const created = await createSession();
    const sessionId = created.json().data.id;

    // Session-scoped agents name the Session they belong to, so they cannot exist at create time.
    const agentId = await seedAgent({ name: 'Release Manager', scope: 'session', sessionId });

    const bound = await patch(`/api/v1/sessions/${sessionId}`, { agentId });
    expect(bound.statusCode).toBe(200);
    expect(bound.json().data.agentId).toBe(agentId);
  });

  it('refuses a session-scoped agent at create time, and says why', async () => {
    const sibling = await createSession();
    const agentId = await seedAgent({
      name: 'Elsewhere',
      scope: 'session',
      sessionId: sibling.json().data.id,
    });

    const response = await createSession({ agentId });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/does not exist yet/);
  });

  it('refuses to bind an agent to a session that has already started', async () => {
    const agentId = await seedAgent({ name: 'Late' });
    const sessionId = await seedSession({ projectId, userId, state: 'running' });

    const response = await patch(`/api/v1/sessions/${sessionId}`, { agentId });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/before launch/);
  });

  it('refuses to bind an agent to an observed session', async () => {
    const agentId = await seedAgent({ name: 'Observer' });
    const sessionId = await seedSession({ projectId, userId, sessionType: 'observed' });

    const response = await patch(`/api/v1/sessions/${sessionId}`, { agentId });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('OPERATION_NOT_SUPPORTED');
  });

  it('unbinds with null', async () => {
    const agentId = await seedAgent({ name: 'Temporary' });
    const created = await createSession({ agentId });

    const unbound = await patch(`/api/v1/sessions/${created.json().data.id}`, { agentId: null });
    expect(unbound.json().data.agentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe('the launch actually carries the agent (PRD §5.1)', () => {
  async function launch(sessionId: string): Promise<void> {
    const response = await post(`/api/v1/sessions/${sessionId}/start`);
    expect(response.statusCode).toBe(200);
  }

  it('hands the runtime nothing when the session has no agent', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'created' });

    await launch(sessionId);

    expect(runtime.launches).toHaveLength(1);
    expect(runtime.launches[0]?.agent).toBeNull();
  });

  it('hands the runtime the agent’s instructions as its system prompt', async () => {
    const instructions = 'You are the Architect. Produce ADRs, not code.';
    const agentId = await seedAgent({ name: 'Architect', instructions });
    const sessionId = await seedSession({ projectId, userId, state: 'created', agentId });

    await launch(sessionId);

    expect(runtime.launches[0]?.agent).toMatchObject({
      agentId,
      agentName: 'Architect',
      systemPromptAppend: instructions,
    });
  });

  it('hands the runtime a deny list that matches the agent’s permissions', async () => {
    const agentId = await seedAgent({
      name: 'Reader',
      permissions: agentPermissionsFromTemplate('read_only'),
    });
    const sessionId = await seedSession({ projectId, userId, state: 'created', agentId });

    await launch(sessionId);

    const denied = runtime.launches[0]?.agent?.disallowedTools ?? [];
    expect(denied).toContain('Bash');
    expect(denied).toContain('Write');
    expect(denied).not.toContain('Read');
    // A restricted agent must not be reachable through a locally-configured MCP server either.
    expect(runtime.launches[0]?.agent?.strictMcpConfig).toBe(true);
  });

  it('denies nothing for a fully-granted agent, so binding one is not a downgrade', async () => {
    const agentId = await seedAgent({
      name: 'Developer',
      permissions: agentPermissionsFromTemplate('full'),
      instructions: 'Ship it.',
    });
    const sessionId = await seedSession({ projectId, userId, state: 'created', agentId });

    await launch(sessionId);

    expect(runtime.launches[0]?.agent).toMatchObject({
      disallowedTools: [],
      strictMcpConfig: false,
      systemPromptAppend: 'Ship it.',
    });
  });

  it('reads the agent fresh at launch, so an edit between launches takes effect', async () => {
    const agentId = await seedAgent({
      name: 'Evolving',
      instructions: 'First draft.',
      permissions: agentPermissionsFromTemplate('full'),
    });
    const first = await seedSession({ projectId, userId, state: 'created', agentId });
    await launch(first);

    await patch(`/api/v1/agents/${agentId}`, {
      instructions: 'Second draft.',
      permissions: { repository: { read: true, write: false, shell: false } },
    });

    const second = await seedSession({ projectId, userId, state: 'created', agentId });
    await launch(second);

    expect(runtime.launches[0]?.agent?.systemPromptAppend).toBe('First draft.');
    expect(runtime.launches[1]?.agent?.systemPromptAppend).toBe('Second draft.');
    expect(runtime.launches[1]?.agent?.disallowedTools).toContain('Bash');
  });

  it('records the agent’s runtime on the session row', async () => {
    const agentId = await seedAgent({ name: 'Runtime' });
    const created = await post('/api/v1/sessions', {
      projectId,
      workingDirectory: testWorkingDirectory(),
      agentId,
    });

    const rows = await testDatabase()
      .db.select({ runtime: schema.sessions.runtime, agentId: schema.sessions.agentId })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, created.json().data.id));

    expect(rows[0]).toEqual({ runtime: 'claude_code', agentId });
  });

  it('carries the persona into a resumed session', async () => {
    const agentId = await seedAgent({ name: 'Continuing', instructions: 'Stay in character.' });
    const parent = await seedSession({
      projectId,
      userId,
      state: 'completed',
      agentId,
      runtimeSessionId: 'runtime-uuid',
    });

    const resumed = await post(`/api/v1/sessions/${parent}/resume`);

    expect(resumed.statusCode).toBe(201);
    expect(resumed.json().data.agentId).toBe(agentId);
  });
});

describe('an agent that has run cannot be erased', () => {
  it('is refused by the database, not merely by the absence of a route', async () => {
    const agentId = await seedAgent({ name: 'Historic' });
    await seedSession({ projectId, userId, agentId });

    // `sessions.agent_id ON DELETE RESTRICT` — the archive-only rule made structural. Nothing in
    // `store.ts` can issue this; it is written by hand precisely to show the floor is real.
    await expectRejectedBy(
      testDatabase().db.delete(schema.agents).where(eq(schema.agents.id, agentId)),
      'sessions_agent_id_agents_id_fk',
    );
  });
});

/** A UUIDv7 for rows this file inserts by hand. */
function id(): string {
  return crypto.randomUUID();
}
