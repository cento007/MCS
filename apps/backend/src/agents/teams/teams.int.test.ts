import { type EventEnvelope, newId, schema } from '@mc/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedAgent,
  seedProject,
  seedSession,
  seedUser,
  type TestApp,
  testDatabase,
  testWorkingDirectory,
  truncateAll,
} from '../../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';

/**
 * PRD §5.7 agent teams end to end — TDS 04 §13.2 — against a real database.
 *
 * Four claims this file exists to stop a reviewer having to take on trust:
 *
 *  1. **The scope agreement is PostgreSQL's, not the service's.** The first block writes
 *     membership and assignment rows directly, past every line of validation code, and the
 *     database still refuses the ones that would leak a project's agent into another project's
 *     roster. Each refusal is asserted **by constraint name**.
 *  2. **The NULL case is tested explicitly.** A CHECK passes when it evaluates to NULL, which is
 *     how 0006 accepted a half-written permission document (fixed in 0007). Every comparison in
 *     the new constraints is `coalesce`d, and there is a case here for each missing key.
 *  3. **`agent.assigned` fires when availability actually changed** and not otherwise — a
 *     re-sent `projectIds` produces no event.
 *  4. **The availability read agrees with the binding path.** Every agent it offers can be bound
 *     to a Session in that project; the ones it omits cannot. That is the whole reason the read
 *     exists, and asserting it is what keeps the two from drifting.
 */

let app: TestApp;
let cookie: string;
let projectId: string;
let userId: string;
let events: EventEnvelope[];

beforeEach(async () => {
  await truncateAll();

  app = createTestApp();

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
async function del(url: string) {
  return app.app.inject({ method: 'DELETE', url, headers: { cookie } });
}

/** Insert straight into `agent_teams`, with no service, no route and no validation in the way. */
async function rawTeam(values: Record<string, unknown>): Promise<void> {
  await testDatabase()
    .db.insert(schema.agentTeams)
    .values({ id: newId(), name: `Raw ${newId()}`, ...values } as never);
}

async function rawMember(values: Record<string, unknown>): Promise<void> {
  await testDatabase()
    .db.insert(schema.agentTeamMembers)
    .values({ id: newId(), ...values } as never);
}

async function rawAssignment(values: Record<string, unknown>): Promise<void> {
  await testDatabase()
    .db.insert(schema.agentTeamAssignments)
    .values({ id: newId(), ...values } as never);
}

/**
 * Assert that PostgreSQL refused a write, and that it refused it **by name**.
 *
 * Same helper and same reasoning as `agents.int.test.ts`: Drizzle wraps the driver error, so its
 * own `message` is only "Failed query: insert into …" and the constraint name lives on
 * `error.cause`. Matching the wrapper would pass for any failed write at all — including a typo
 * in the fixture — which would make every constraint test in this file vacuous.
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

/** A live team row written directly, for the constraint block. */
async function seedTeamRow(input: {
  scope: 'global' | 'project';
  projectId?: string | null;
  name?: string;
}): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.agentTeams)
    .values({
      id,
      name: input.name ?? `Team ${id.slice(0, 8)}`,
      scope: input.scope,
      projectId: input.projectId ?? null,
    });
  return id;
}

// ---------------------------------------------------------------------------------------------

describe('the team scope invariant is enforced by PostgreSQL', () => {
  it('stores each scope with exactly its own target', async () => {
    await expect(rawTeam({ scope: 'global' })).resolves.toBeUndefined();
    await expect(rawTeam({ scope: 'project', projectId })).resolves.toBeUndefined();
  });

  it('REJECTS a project-scoped team with no project', async () => {
    await expectRejectedBy(rawTeam({ scope: 'project' }), 'ck_agent_teams_scope_target');
  });

  it('REJECTS a global team that names a project', async () => {
    await expectRejectedBy(rawTeam({ scope: 'global', projectId }), 'ck_agent_teams_scope_target');
  });

  it('REJECTS a session scope, which a team can never have', async () => {
    // `AGENT_TEAM_SCOPES` has two members on purpose: a session agent belongs to one
    // conversation and cannot hold a standing seat. Two constraints refuse this row — the
    // vocabulary CHECK reports first, and `ck_agent_teams_scope_target`'s `ELSE false` is the
    // backstop that would still refuse it if the vocabulary CHECK were ever dropped.
    await expectRejectedBy(rawTeam({ scope: 'session' }), 'ck_agent_teams_scope');
  });
});

describe('team membership cannot leak an agent across projects', () => {
  it('accepts a global agent on a global team', async () => {
    const teamId = await seedTeamRow({ scope: 'global' });
    const agentId = await seedAgent({ name: 'Architect' });

    await expect(
      rawMember({
        teamId,
        teamScope: 'global',
        teamProjectId: null,
        agentId,
        agentScope: 'global',
        agentProjectId: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts a project agent on that project’s own team', async () => {
    const teamId = await seedTeamRow({ scope: 'project', projectId });
    const agentId = await seedAgent({ name: 'ERP Architect', scope: 'project', projectId });

    await expect(
      rawMember({
        teamId,
        teamScope: 'project',
        teamProjectId: projectId,
        agentId,
        agentScope: 'project',
        agentProjectId: projectId,
      }),
    ).resolves.toBeUndefined();
  });

  it('REJECTS a project agent on a global team', async () => {
    // The leak this table exists to prevent: a global team is assignable anywhere, so one member
    // that is only valid in project X would be offered on project Y and refused at bind.
    const teamId = await seedTeamRow({ scope: 'global' });
    const agentId = await seedAgent({ name: 'Scoped', scope: 'project', projectId });

    await expectRejectedBy(
      rawMember({
        teamId,
        teamScope: 'global',
        teamProjectId: null,
        agentId,
        agentScope: 'project',
        agentProjectId: projectId,
      }),
      'ck_agent_team_members_agent_scope',
    );
  });

  it('REJECTS a project agent from a different project than the team', async () => {
    const other = await seedProject('Other');
    const teamId = await seedTeamRow({ scope: 'project', projectId });
    const agentId = await seedAgent({
      name: 'Foreign',
      scope: 'project',
      projectId: other.projectId,
    });

    await expectRejectedBy(
      rawMember({
        teamId,
        teamScope: 'project',
        teamProjectId: projectId,
        agentId,
        agentScope: 'project',
        agentProjectId: other.projectId,
      }),
      'ck_agent_team_members_agent_scope',
    );
  });

  it('REJECTS a session-scoped agent outright', async () => {
    const teamId = await seedTeamRow({ scope: 'global' });
    const sessionId = await seedSession({ projectId, userId });
    const agentId = await seedAgent({ name: 'Release Manager', scope: 'session', sessionId });

    // `ELSE false` in the CASE: `session` is not one of the two arms, so the row fails.
    await expectRejectedBy(
      rawMember({
        teamId,
        teamScope: 'global',
        teamProjectId: null,
        agentId,
        agentScope: 'session',
        agentProjectId: null,
      }),
      'ck_agent_team_members_agent_scope',
    );
  });

  it('REJECTS a copied scope that does not match the agent', async () => {
    // The copies are not trusted: `(agent_id, agent_scope)` must exist in `agents (id, scope)`,
    // so relabelling a project agent as global fails the FK rather than the CHECK. Without this
    // the CHECK above would be defeated by one word in an INSERT.
    const teamId = await seedTeamRow({ scope: 'global' });
    const agentId = await seedAgent({ name: 'Liar', scope: 'project', projectId });

    await expectRejectedBy(
      rawMember({
        teamId,
        teamScope: 'global',
        teamProjectId: null,
        agentId,
        agentScope: 'global',
        agentProjectId: null,
      }),
      'agent_team_members_agent_scope_fk',
    );
  });

  it('REJECTS a copied project id that does not match the agent', async () => {
    const other = await seedProject('Other');
    const teamId = await seedTeamRow({ scope: 'project', projectId });
    const agentId = await seedAgent({
      name: 'Relabelled',
      scope: 'project',
      projectId: other.projectId,
    });

    await expectRejectedBy(
      rawMember({
        teamId,
        teamScope: 'project',
        teamProjectId: projectId,
        agentId,
        agentScope: 'project',
        agentProjectId: projectId,
      }),
      'agent_team_members_agent_project_fk',
    );
  });

  it('REJECTS a MISSING agent project id — the NULL case a CHECK would otherwise pass', async () => {
    // `agent_project_id = team_project_id` is NULL, not false, when the left side is missing, and
    // **a CHECK passes on NULL**. That is exactly the defect 0007 had to correct on `agents`.
    // Without the `coalesce` this row is accepted and the roster silently gains a foreign agent.
    const teamId = await seedTeamRow({ scope: 'project', projectId });
    const agentId = await seedAgent({ name: 'Nulled', scope: 'project', projectId });

    await expectRejectedBy(
      rawMember({
        teamId,
        teamScope: 'project',
        teamProjectId: projectId,
        agentId,
        agentScope: 'project',
        agentProjectId: null,
      }),
      'ck_agent_team_members_agent_scope',
    );
  });

  it('REJECTS a MISSING team project id on a project team', async () => {
    // The mirror case, and the reason `team_scope` is copied at all. With `team_project_id` NULL
    // the agent comparison has nothing to compare against — so the team half of the copy is
    // checked on its own, and this row is refused even though the *agent* half is impeccable.
    //
    // A **global** member is used deliberately: a project member would already fail
    // `ck_agent_team_members_agent_scope` (whose comparison coalesces to false against a NULL
    // team project), and the failure would prove nothing about the team constraint. Here the
    // agent CHECK passes and `agent_team_members_team_project_fk` is skipped for the NULL, so
    // `ck_agent_team_members_team_scope` is the only thing standing in the way.
    const teamId = await seedTeamRow({ scope: 'project', projectId });
    const agentId = await seedAgent({ name: 'Member' });

    await expectRejectedBy(
      rawMember({
        teamId,
        teamScope: 'project',
        teamProjectId: null,
        agentId,
        agentScope: 'global',
        agentProjectId: null,
      }),
      'ck_agent_team_members_team_scope',
    );
  });

  it('REJECTS a second seat for the same agent', async () => {
    const teamId = await seedTeamRow({ scope: 'global' });
    const agentId = await seedAgent({ name: 'Twice' });
    const values = {
      teamId,
      teamScope: 'global',
      teamProjectId: null,
      agentId,
      agentScope: 'global',
      agentProjectId: null,
    };

    await rawMember(values);
    await expectRejectedBy(rawMember(values), 'ux_agent_team_members_team_agent');
  });
});

describe('team assignment cannot cross a project boundary', () => {
  it('assigns a global team to any project', async () => {
    const teamId = await seedTeamRow({ scope: 'global' });

    await expect(
      rawAssignment({ teamId, teamScope: 'global', teamProjectId: null, projectId }),
    ).resolves.toBeUndefined();
  });

  it('REJECTS a project team assigned to a different project', async () => {
    const other = await seedProject('Other');
    const teamId = await seedTeamRow({ scope: 'project', projectId });

    await expectRejectedBy(
      rawAssignment({
        teamId,
        teamScope: 'project',
        teamProjectId: projectId,
        projectId: other.projectId,
      }),
      'ck_agent_team_assignments_scope',
    );
  });

  it('REJECTS a MISSING team project id — the NULL case again', async () => {
    const teamId = await seedTeamRow({ scope: 'project', projectId });

    await expectRejectedBy(
      rawAssignment({ teamId, teamScope: 'project', teamProjectId: null, projectId }),
      'ck_agent_team_assignments_scope',
    );
  });

  it('REJECTS a second team for the same project', async () => {
    const first = await seedTeamRow({ scope: 'global', name: 'First' });
    const second = await seedTeamRow({ scope: 'global', name: 'Second' });

    await rawAssignment({ teamId: first, teamScope: 'global', teamProjectId: null, projectId });
    await expectRejectedBy(
      rawAssignment({ teamId: second, teamScope: 'global', teamProjectId: null, projectId }),
      'ux_agent_team_assignments_project',
    );
  });

  it('REFUSES to delete a team a project still names', async () => {
    // The `409` on the route is the message; this is the rule. `NO ACTION` rather than
    // `RESTRICT` so that deleting a *project* — which removes the assignment and the team in one
    // statement — is not refused by a row that statement is already deleting.
    const teamId = await seedTeamRow({ scope: 'global' });
    await rawAssignment({ teamId, teamScope: 'global', teamProjectId: null, projectId });

    await expectRejectedBy(
      testDatabase().db.delete(schema.agentTeams).where(eq(schema.agentTeams.id, teamId)),
      'agent_team_assignments_team_scope_fk',
    );
  });

  it('lets a project be deleted even though it has a team and an assignment', async () => {
    const doomed = await seedProject('Doomed');
    const teamId = await seedTeamRow({ scope: 'project', projectId: doomed.projectId });
    await rawAssignment({
      teamId,
      teamScope: 'project',
      teamProjectId: doomed.projectId,
      projectId: doomed.projectId,
    });

    await expect(
      testDatabase().db.delete(schema.projects).where(eq(schema.projects.id, doomed.projectId)),
    ).resolves.toBeDefined();

    const remaining = await testDatabase()
      .db.select({ id: schema.agentTeams.id })
      .from(schema.agentTeams)
      .where(eq(schema.agentTeams.id, teamId));
    expect(remaining).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe('POST /api/v1/agent-teams', () => {
  it('creates PRD §5.7’s example team in one call', async () => {
    const ids = [];
    for (const name of ['Product Owner', 'Architect', 'Developer', 'QA', 'Security']) {
      ids.push(await seedAgent({ name }));
    }

    const response = await post('/api/v1/agent-teams', {
      name: 'Delivery',
      description: 'The standard five',
      scope: 'global',
      agentIds: ids,
      projectIds: [projectId],
    });

    expect(response.statusCode).toBe(201);
    const team = response.json().data;
    expect(team).toMatchObject({ name: 'Delivery', scope: 'global', projectId: null });
    expect(team.projectIds).toEqual([projectId]);
    // Sorted by agent name, because a team is a set with no ordinal — the order has to come from
    // somewhere stable or a refresh looks like a change.
    expect(team.members.map((member: { name: string }) => member.name)).toEqual([
      'Architect',
      'Developer',
      'Product Owner',
      'QA',
      'Security',
    ]);
  });

  it('emits agent_team.created and one agent.assigned per assigned project', async () => {
    const other = await seedProject('Other');
    const agentId = await seedAgent({ name: 'Architect' });

    const created = await post('/api/v1/agent-teams', {
      name: 'Delivery',
      scope: 'global',
      agentIds: [agentId],
      projectIds: [projectId, other.projectId],
    });

    expect(events.filter((event) => event.type === 'agent_team.created')).toHaveLength(1);

    const assigned = events.filter((event) => event.type === 'agent.assigned');
    expect(assigned).toHaveLength(2);
    expect(assigned[0]?.payload).toMatchObject({
      teamId: created.json().data.id,
      agentIds: [agentId],
    });
    expect(assigned.map((event) => event.payload['projectId']).sort()).toEqual(
      [projectId, other.projectId].sort(),
    );
  });

  it('emits no agent.assigned for a team with no members', async () => {
    // An empty team assigned to a project changes nobody's availability. An event that fires
    // when nothing changed is indistinguishable from one that matters.
    await post('/api/v1/agent-teams', {
      name: 'Empty',
      scope: 'global',
      projectIds: [projectId],
    });

    expect(events.filter((event) => event.type === 'agent.assigned')).toHaveLength(0);
  });

  it('records the roster in the audit log', async () => {
    const agentId = await seedAgent({ name: 'Architect' });
    const created = await post('/api/v1/agent-teams', {
      name: 'Delivery',
      scope: 'global',
      agentIds: [agentId],
    });

    const rows = await testDatabase()
      .db.select()
      .from(schema.auditLogEntries)
      .where(eq(schema.auditLogEntries.entityId, created.json().data.id));

    expect(rows[0]).toMatchObject({ actorType: 'user', action: 'agent_team.created' });
    expect(rows[0]?.after).toMatchObject({ name: 'Delivery', agentIds: [agentId] });
  });

  it('accepts a project agent on that project’s own team', async () => {
    const agentId = await seedAgent({ name: 'ERP Architect', scope: 'project', projectId });

    const response = await post('/api/v1/agent-teams', {
      name: 'ERP',
      scope: 'project',
      projectId,
      agentIds: [agentId],
      projectIds: [projectId],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.members).toHaveLength(1);
  });

  it('refuses a project agent on a global team, naming the field', async () => {
    const agentId = await seedAgent({ name: 'Scoped', scope: 'project', projectId });

    const response = await post('/api/v1/agent-teams', {
      name: 'Delivery',
      scope: 'global',
      agentIds: [agentId],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'agentIds', agentId },
    });
  });

  it('refuses a session-scoped agent as a standing member', async () => {
    const sessionId = await seedSession({ projectId, userId });
    const agentId = await seedAgent({ name: 'Release Manager', scope: 'session', sessionId });

    const response = await post('/api/v1/agent-teams', {
      name: 'Delivery',
      scope: 'global',
      agentIds: [agentId],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/one conversation/);
  });

  it('refuses to ADD an archived agent, with CONFLICT rather than a validation error', async () => {
    // The id is good and the agent exists; it has been retired, which is a state the operator
    // can undo. Same distinction the session binding path draws.
    const agentId = await seedAgent({ name: 'Retired', archivedAt: new Date() });

    const response = await post('/api/v1/agent-teams', {
      name: 'Delivery',
      scope: 'global',
      agentIds: [agentId],
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
  });

  it('refuses a project scope with no project, naming the field', async () => {
    const response = await post('/api/v1/agent-teams', { name: 'Orphan', scope: 'project' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.details).toMatchObject({ field: 'projectId' });
  });

  it('refuses an agent id that does not exist', async () => {
    const response = await post('/api/v1/agent-teams', {
      name: 'Ghosts',
      scope: 'global',
      agentIds: [newId()],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.details).toMatchObject({ field: 'agentIds' });
  });

  it('refuses assigning a project-scoped team anywhere but its own project', async () => {
    const other = await seedProject('Other');

    const response = await post('/api/v1/agent-teams', {
      name: 'ERP',
      scope: 'project',
      projectId,
      projectIds: [other.projectId],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.details).toMatchObject({ field: 'projectIds' });
  });

  it('refuses to take a project that already belongs to another team', async () => {
    await post('/api/v1/agent-teams', {
      name: 'Incumbent',
      scope: 'global',
      projectIds: [projectId],
    });

    const response = await post('/api/v1/agent-teams', {
      name: 'Challenger',
      scope: 'global',
      projectIds: [projectId],
    });

    // Refused, not silently transferred: the consequence of a transfer (a different roster is
    // offered on that project) is invisible at the call site.
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/Incumbent/);
  });

  it('refuses a second team with the same name in the same scope', async () => {
    await post('/api/v1/agent-teams', { name: 'Delivery', scope: 'global' });
    const duplicate = await post('/api/v1/agent-teams', { name: 'Delivery', scope: 'global' });

    expect(duplicate.statusCode).toBe(409);
  });

  it('collapses a repeated agent id rather than answering 409', async () => {
    const agentId = await seedAgent({ name: 'Architect' });

    const response = await post('/api/v1/agent-teams', {
      name: 'Delivery',
      scope: 'global',
      agentIds: [agentId, agentId],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.members).toHaveLength(1);
  });
});

describe('GET /api/v1/agent-teams', () => {
  it('paginates with an opaque cursor and carries each roster', async () => {
    const agentId = await seedAgent({ name: 'Architect' });
    await post('/api/v1/agent-teams', { name: 'A', scope: 'global', agentIds: [agentId] });
    await post('/api/v1/agent-teams', { name: 'B', scope: 'global' });

    const page = await get('/api/v1/agent-teams?limit=1');
    expect(page.statusCode).toBe(200);
    expect(page.json().data).toHaveLength(1);
    expect(page.json().meta).toMatchObject({ limit: 1, nextCursor: expect.any(String) });

    const all = await get('/api/v1/agent-teams');
    expect(all.json().data).toHaveLength(2);
    expect(all.json().data.flatMap((team: { members: unknown[] }) => team.members)).toHaveLength(1);
  });

  it('filters by scope and by the team’s own project', async () => {
    await post('/api/v1/agent-teams', { name: 'Global', scope: 'global' });
    await post('/api/v1/agent-teams', { name: 'Scoped', scope: 'project', projectId });

    const response = await get(`/api/v1/agent-teams?scope=project&projectId=${projectId}`);
    expect(response.json().data.map((team: { name: string }) => team.name)).toEqual(['Scoped']);
  });

  it('rejects an unknown filter instead of ignoring it', async () => {
    const response = await get('/api/v1/agent-teams?scoep=global');

    expect(response.statusCode).toBe(400);
    expect(response.json().error.details).toMatchObject({ unknownParameters: ['scoep'] });
  });
});

describe('PATCH /api/v1/agent-teams/{id}', () => {
  async function team(body: Record<string, unknown> = {}): Promise<string> {
    const created = await post('/api/v1/agent-teams', {
      name: 'Delivery',
      scope: 'global',
      ...body,
    });
    expect(created.statusCode).toBe(201);
    events.length = 0;
    return created.json().data.id;
  }

  it('replaces the roster, so removing a member needs no second route', async () => {
    const architect = await seedAgent({ name: 'Architect' });
    const qa = await seedAgent({ name: 'QA' });
    const teamId = await team({ agentIds: [architect, qa] });

    const response = await patch(`/api/v1/agent-teams/${teamId}`, { agentIds: [architect] });

    expect(response.statusCode).toBe(200);
    expect(
      response.json().data.members.map((member: { agentId: string }) => member.agentId),
    ).toEqual([architect]);
  });

  it('leaves the roster alone when agentIds is omitted', async () => {
    const architect = await seedAgent({ name: 'Architect' });
    const teamId = await team({ agentIds: [architect] });

    const response = await patch(`/api/v1/agent-teams/${teamId}`, { name: 'Renamed' });

    expect(response.json().data.name).toBe('Renamed');
    expect(response.json().data.members).toHaveLength(1);
  });

  it('empties the roster when agentIds is []', async () => {
    const architect = await seedAgent({ name: 'Architect' });
    const teamId = await team({ agentIds: [architect] });

    const response = await patch(`/api/v1/agent-teams/${teamId}`, { agentIds: [] });

    expect(response.json().data.members).toEqual([]);
  });

  it('keeps addedAt when a member is re-sent, so a rename does not reset the roster', async () => {
    const architect = await seedAgent({ name: 'Architect' });
    const teamId = await team({ agentIds: [architect] });

    const before = await get(`/api/v1/agent-teams/${teamId}`);
    await patch(`/api/v1/agent-teams/${teamId}`, { agentIds: [architect] });
    const after = await get(`/api/v1/agent-teams/${teamId}`);

    expect(after.json().data.members[0].addedAt).toBe(before.json().data.members[0].addedAt);
  });

  it('emits agent.assigned for a project the team just gained', async () => {
    const architect = await seedAgent({ name: 'Architect' });
    const teamId = await team({ agentIds: [architect] });

    await patch(`/api/v1/agent-teams/${teamId}`, { projectIds: [projectId] });

    const assigned = events.filter((event) => event.type === 'agent.assigned');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.payload).toMatchObject({ teamId, projectId, agentIds: [architect] });
  });

  it('emits nothing for a re-sent projectIds, because availability did not change', async () => {
    const architect = await seedAgent({ name: 'Architect' });
    const teamId = await team({ agentIds: [architect], projectIds: [projectId] });

    await patch(`/api/v1/agent-teams/${teamId}`, { projectIds: [projectId] });

    expect(events.filter((event) => event.type === 'agent.assigned')).toHaveLength(0);
    // The team document still changed hands, so `agent_team.updated` is produced; only the
    // availability claim is withheld.
    expect(events.filter((event) => event.type === 'agent_team.updated')).toHaveLength(1);
  });

  it('emits agent.assigned for an already-assigned project when a NEW member arrives', async () => {
    const architect = await seedAgent({ name: 'Architect' });
    const qa = await seedAgent({ name: 'QA' });
    const teamId = await team({ agentIds: [architect], projectIds: [projectId] });

    await patch(`/api/v1/agent-teams/${teamId}`, { agentIds: [architect, qa] });

    const assigned = events.filter((event) => event.type === 'agent.assigned');
    expect(assigned).toHaveLength(1);
    // Only the agent that is new to the project — the Architect was already available there.
    expect(assigned[0]?.payload).toMatchObject({ projectId, agentIds: [qa] });
  });

  it('unassigns a project when it is dropped from projectIds', async () => {
    const teamId = await team({ projectIds: [projectId] });

    const response = await patch(`/api/v1/agent-teams/${teamId}`, { projectIds: [] });

    expect(response.json().data.projectIds).toEqual([]);
    // Unassignment has no reserved event name of its own; the team document changed, and that is
    // what a client refetches on.
    expect(events.filter((event) => event.type === 'agent_team.updated')).toHaveLength(1);
  });

  it('supports the two-step hand-off between teams', async () => {
    const from = await team({ name: 'From', projectIds: [projectId] });
    const to = await team({ name: 'To' });

    const stolen = await patch(`/api/v1/agent-teams/${to}`, { projectIds: [projectId] });
    expect(stolen.statusCode).toBe(409);

    await patch(`/api/v1/agent-teams/${from}`, { projectIds: [] });
    const moved = await patch(`/api/v1/agent-teams/${to}`, { projectIds: [projectId] });
    expect(moved.statusCode).toBe(200);
  });

  it('refuses to change scope, at the boundary', async () => {
    const teamId = await team();

    const response = await patch(`/api/v1/agent-teams/${teamId}`, { scope: 'project', projectId });
    expect(response.statusCode).toBe(400);
  });

  it('answers NOT_FOUND for an unknown id', async () => {
    const response = await patch(`/api/v1/agent-teams/${newId()}`, { name: 'Nobody' });
    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/agent-teams/{id}', () => {
  it('deletes an unassigned team and keeps its roster in the audit trail', async () => {
    const architect = await seedAgent({ name: 'Architect' });
    const created = await post('/api/v1/agent-teams', {
      name: 'Delivery',
      scope: 'global',
      agentIds: [architect],
    });
    const teamId = created.json().data.id;

    const response = await del(`/api/v1/agent-teams/${teamId}`);
    expect(response.statusCode).toBe(204);
    expect((await get(`/api/v1/agent-teams/${teamId}`)).statusCode).toBe(404);

    const rows = await testDatabase()
      .db.select()
      .from(schema.auditLogEntries)
      .where(eq(schema.auditLogEntries.entityId, teamId));
    expect(rows.some((row) => row.action === 'agent_team.deleted')).toBe(true);
    expect(rows.find((row) => row.action === 'agent_team.deleted')?.before).toMatchObject({
      agentIds: [architect],
    });

    // The agent itself is untouched. This is the whole argument for allowing the delete: nothing
    // that outlives the team is lost with it.
    expect((await get(`/api/v1/agents/${architect}`)).statusCode).toBe(200);
  });

  it('refuses while a project is still assigned, naming the projects', async () => {
    const created = await post('/api/v1/agent-teams', {
      name: 'Delivery',
      scope: 'global',
      projectIds: [projectId],
    });

    const response = await del(`/api/v1/agent-teams/${created.json().data.id}`);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.details).toMatchObject({ projectIds: [projectId] });
  });

  it('emits agent_team.deleted', async () => {
    const created = await post('/api/v1/agent-teams', { name: 'Delivery', scope: 'global' });
    events.length = 0;

    await del(`/api/v1/agent-teams/${created.json().data.id}`);

    expect(events.filter((event) => event.type === 'agent_team.deleted')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('GET /api/v1/projects/{id}/available-agents', () => {
  it('offers global agents and this project’s own, and nothing else', async () => {
    const other = await seedProject('Other');
    const global = await seedAgent({ name: 'Architect' });
    const mine = await seedAgent({ name: 'ERP Architect', scope: 'project', projectId });
    const theirs = await seedAgent({
      name: 'Their Architect',
      scope: 'project',
      projectId: other.projectId,
    });
    const sessionId = await seedSession({ projectId, userId });
    const ephemeral = await seedAgent({ name: 'Release', scope: 'session', sessionId });
    const retired = await seedAgent({ name: 'Retired', archivedAt: new Date() });

    const response = await get(`/api/v1/projects/${projectId}/available-agents`);

    expect(response.statusCode).toBe(200);
    const offered = response.json().data.agents.map((agent: { id: string }) => agent.id);
    expect(offered).toContain(global);
    expect(offered).toContain(mine);
    // Another project's agent, a session agent and an archived one are all refused at bind, so
    // offering any of them would be offering a choice that then fails.
    expect(offered).not.toContain(theirs);
    expect(offered).not.toContain(ephemeral);
    expect(offered).not.toContain(retired);
  });

  it('every agent it offers can actually be bound to a session here', async () => {
    // The claim that keeps this read and `AgentBindingResolver` from drifting: the read is the
    // positive form of a rule that previously existed only as a refusal.
    //
    // The three ineligible agents are seeded on purpose. Without them a read that filtered
    // nothing would still pass this test, and a test that passes either way proves nothing.
    const other = await seedProject('Other');
    await seedAgent({ name: 'Architect' });
    await seedAgent({ name: 'ERP Architect', scope: 'project', projectId });
    await seedAgent({ name: 'Foreign', scope: 'project', projectId: other.projectId });
    await seedAgent({ name: 'Retired', archivedAt: new Date() });
    await seedAgent({
      name: 'Ephemeral',
      scope: 'session',
      sessionId: await seedSession({ projectId, userId }),
    });

    const response = await get(`/api/v1/projects/${projectId}/available-agents`);
    const offered = response.json().data.agents as { id: string }[];
    expect(offered.length).toBeGreaterThan(0);

    for (const agent of offered) {
      const created = await post('/api/v1/sessions', {
        projectId,
        workingDirectory: testWorkingDirectory(),
        agentId: agent.id,
      });
      expect(created.statusCode).toBe(201);
    }
  });

  it('reports no team, and still reports the agents, when none is assigned', async () => {
    await seedAgent({ name: 'Architect' });

    const response = await get(`/api/v1/projects/${projectId}/available-agents`);

    expect(response.json().data.team).toBeNull();
    expect(response.json().data.agents).toHaveLength(1);
    expect(response.json().data.agents[0].onTeam).toBe(false);
  });

  it('flags the assigned team’s members with onTeam', async () => {
    const architect = await seedAgent({ name: 'Architect' });
    await seedAgent({ name: 'Bystander' });

    const created = await post('/api/v1/agent-teams', {
      name: 'Delivery',
      scope: 'global',
      agentIds: [architect],
      projectIds: [projectId],
    });

    const response = await get(`/api/v1/projects/${projectId}/available-agents`);

    expect(response.json().data.team).toMatchObject({
      id: created.json().data.id,
      name: 'Delivery',
      memberCount: 1,
      archivedMemberCount: 0,
    });
    const byName = Object.fromEntries(
      response
        .json()
        .data.agents.map((agent: { name: string; onTeam: boolean }) => [agent.name, agent.onTeam]),
    );
    expect(byName).toEqual({ Architect: true, Bystander: false });
  });

  it('drops an archived member from the offer but counts the empty seat', async () => {
    // The question this slice had to answer: an agent is archived while a team names it. The
    // membership row survives (archive is reversible), the picker stops offering it, and
    // `archivedMemberCount` is what stops the team quietly shrinking from five to four with no
    // explanation.
    const architect = await seedAgent({ name: 'Architect' });
    const qa = await seedAgent({ name: 'QA' });
    await post('/api/v1/agent-teams', {
      name: 'Delivery',
      scope: 'global',
      agentIds: [architect, qa],
      projectIds: [projectId],
    });

    await patch(`/api/v1/agents/${qa}`, { archived: true });

    const response = await get(`/api/v1/projects/${projectId}/available-agents`);
    expect(response.json().data.team).toMatchObject({ memberCount: 2, archivedMemberCount: 1 });
    expect(response.json().data.agents.map((agent: { id: string }) => agent.id)).toEqual([
      architect,
    ]);

    // The seat itself is still on the roster, so the operator can see which one is empty.
    const team = await get(`/api/v1/agent-teams/${response.json().data.team.id}`);
    expect(team.json().data.members).toHaveLength(2);
    expect(
      team.json().data.members.find((member: { agentId: string }) => member.agentId === qa)
        .archivedAt,
    ).toEqual(expect.any(String));
  });

  it('restores the member when the agent is un-archived', async () => {
    const qa = await seedAgent({ name: 'QA' });
    await post('/api/v1/agent-teams', {
      name: 'Delivery',
      scope: 'global',
      agentIds: [qa],
      projectIds: [projectId],
    });

    await patch(`/api/v1/agents/${qa}`, { archived: true });
    await patch(`/api/v1/agents/${qa}`, { archived: false });

    const response = await get(`/api/v1/projects/${projectId}/available-agents`);
    expect(response.json().data.team).toMatchObject({ memberCount: 1, archivedMemberCount: 0 });
    expect(response.json().data.agents[0]).toMatchObject({ id: qa, onTeam: true });
  });

  it('answers NOT_FOUND for an unknown project rather than an empty roster', async () => {
    const response = await get(`/api/v1/projects/${newId()}/available-agents`);
    expect(response.statusCode).toBe(404);
  });

  // ------------------------------------------------------------------- the refusals, reported

  it('names every agent it does not offer, with the reason it does not', async () => {
    const other = await seedProject('Other');
    const sessionId = await seedSession({ projectId, userId });

    const theirs = await seedAgent({
      name: 'Their Architect',
      scope: 'project',
      projectId: other.projectId,
    });
    const ephemeral = await seedAgent({ name: 'Release', scope: 'session', sessionId });
    const retired = await seedAgent({ name: 'Retired', archivedAt: new Date() });

    const response = await get(`/api/v1/projects/${projectId}/available-agents`);
    const refused = response.json().data.refused as {
      agentId: string;
      reason: string;
      explanation: string;
    }[];

    const byId = Object.fromEntries(refused.map((entry) => [entry.agentId, entry]));
    expect(byId[theirs]).toMatchObject({ reason: 'other_project' });
    expect(byId[retired]).toMatchObject({ reason: 'archived' });
    // The one temporary refusal: bindable, but only after the Session exists. Flattening it into
    // "unavailable" would leave the picker unable to explain the difference.
    expect(byId[ephemeral]).toMatchObject({ reason: 'session_not_yet' });
    for (const entry of refused) expect(entry.explanation.length).toBeGreaterThan(40);
  });

  it('accounts for every agent in the install: offered ∪ refused, with no overlap', async () => {
    // The property that makes this read usable as the picker's whole source. An agent that is in
    // neither list is an absence the screen cannot explain, which is the defect the frontend was
    // reading the entire `/agents` table to avoid.
    const other = await seedProject('Other');
    const all = [
      await seedAgent({ name: 'Architect' }),
      await seedAgent({ name: 'ERP Architect', scope: 'project', projectId }),
      await seedAgent({ name: 'Foreign', scope: 'project', projectId: other.projectId }),
      await seedAgent({ name: 'Retired', archivedAt: new Date() }),
      await seedAgent({
        name: 'Ephemeral',
        scope: 'session',
        sessionId: await seedSession({ projectId, userId }),
      }),
    ];

    const body = (await get(`/api/v1/projects/${projectId}/available-agents`)).json().data;
    const offered = (body.agents as { id: string }[]).map((agent) => agent.id);
    const refused = (body.refused as { agentId: string }[]).map((entry) => entry.agentId);

    expect([...offered, ...refused].sort()).toEqual([...all].sort());
    expect(offered.filter((id) => refused.includes(id))).toEqual([]);
  });

  // --------------------------------------------------- the same question, about a real Session

  it('offers a session-scoped agent to the Session it names when ?sessionId= is given', async () => {
    // The capability the create-time answer cannot express: a session agent exists for exactly one
    // conversation, and against a context with no Session it is `session_not_yet` — including for
    // its own. Supplying the missing half of the context is what makes the PATCH surface usable.
    const sessionId = await seedSession({ projectId, userId });
    const mine = await seedAgent({ name: 'Release', scope: 'session', sessionId });

    const withoutSession = (await get(`/api/v1/projects/${projectId}/available-agents`)).json()
      .data;
    expect(withoutSession.sessionId).toBeNull();
    expect(withoutSession.agents.map((agent: { id: string }) => agent.id)).not.toContain(mine);
    expect(
      withoutSession.refused.find((entry: { agentId: string }) => entry.agentId === mine).reason,
    ).toBe('session_not_yet');

    const withSession = (
      await get(`/api/v1/projects/${projectId}/available-agents?sessionId=${sessionId}`)
    ).json().data;

    expect(withSession.sessionId).toBe(sessionId);
    expect(withSession.agents.map((agent: { id: string }) => agent.id)).toContain(mine);
    expect(withSession.refused.map((entry: { agentId: string }) => entry.agentId)).not.toContain(
      mine,
    );
  });

  it('reports another Session’s agent as session_elsewhere, not session_not_yet', async () => {
    const mine = await seedSession({ projectId, userId });
    const theirs = await seedSession({ projectId, userId });
    const stranger = await seedAgent({ name: 'Stranger', scope: 'session', sessionId: theirs });

    const body = (
      await get(`/api/v1/projects/${projectId}/available-agents?sessionId=${mine}`)
    ).json().data;

    const entry = body.refused.find((row: { agentId: string }) => row.agentId === stranger);
    expect(entry.reason).toBe('session_elsewhere');
    // Permanent rather than "not yet", and the sentence says so.
    expect(entry.explanation).toContain('exactly one conversation');
  });

  it('holds the ?sessionId= answer to what PATCH /sessions/{id} enforces', async () => {
    const created = await post('/api/v1/sessions', {
      projectId,
      workingDirectory: testWorkingDirectory(),
    });
    const sessionId = created.json().data.id as string;
    const mine = await seedAgent({ name: 'Release', scope: 'session', sessionId });
    const theirs = await seedAgent({
      name: 'Stranger',
      scope: 'session',
      sessionId: await seedSession({ projectId, userId }),
    });

    const body = (
      await get(`/api/v1/projects/${projectId}/available-agents?sessionId=${sessionId}`)
    ).json().data;
    expect(body.agents.map((agent: { id: string }) => agent.id)).toContain(mine);

    // Offered here, accepted there.
    const bound = await patch(`/api/v1/sessions/${sessionId}`, { agentId: mine });
    expect(bound.statusCode).toBe(200);
    expect(bound.json().data.agentId).toBe(mine);

    // Refused here, refused there — with the identical sentence, from the one function.
    const refusal = body.refused.find((row: { agentId: string }) => row.agentId === theirs);
    const rejected = await patch(`/api/v1/sessions/${sessionId}`, { agentId: theirs });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.message).toBe(refusal.explanation);
  });

  it('refuses a sessionId that does not exist, or belongs to another project', async () => {
    const unknown = await get(
      `/api/v1/projects/${projectId}/available-agents?sessionId=${newId()}`,
    );
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.details).toMatchObject({ field: 'sessionId' });

    const other = await seedProject('Other');
    const elsewhere = await seedSession({ projectId: other.projectId, userId });
    const mismatched = await get(
      `/api/v1/projects/${projectId}/available-agents?sessionId=${elsewhere}`,
    );
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json().error.details).toMatchObject({
      field: 'sessionId',
      sessionProjectId: other.projectId,
    });
  });

  it('rejects an unknown query parameter rather than answering the wrong question', async () => {
    // `registerQueryStrictness` — a mistyped `?sesionId=` must not read as "no session", which is
    // a different answer with the same shape.
    const response = await get(
      `/api/v1/projects/${projectId}/available-agents?sesionId=${newId()}`,
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('holds the refusal it reports to the one POST /sessions enforces — same reason, same words', async () => {
    // The whole point of the change: one function answers both. A refusal the read invented, or a
    // rejection the read did not predict, fails here.
    const other = await seedProject('Other');
    await seedAgent({ name: 'Their Architect', scope: 'project', projectId: other.projectId });
    await seedAgent({ name: 'Retired', archivedAt: new Date() });
    await seedAgent({
      name: 'Release',
      scope: 'session',
      sessionId: await seedSession({ projectId, userId }),
    });

    const refused = (await get(`/api/v1/projects/${projectId}/available-agents`)).json().data
      .refused as { agentId: string; reason: string; explanation: string }[];
    expect(refused.length).toBe(3);

    for (const entry of refused) {
      const attempt = await post('/api/v1/sessions', {
        projectId,
        workingDirectory: testWorkingDirectory(),
        agentId: entry.agentId,
      });

      expect(attempt.statusCode).toBe(entry.reason === 'archived' ? 409 : 400);
      // Not "an error mentioning something similar": the identical string, because both come
      // from `agentBindingRefusal`.
      expect(attempt.json().error.message).toBe(entry.explanation);
    }
  });
});
