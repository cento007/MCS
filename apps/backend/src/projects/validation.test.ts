import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors.js';
import { serializeProject } from './serialize.js';
import { normalizeDescription, normalizeProjectName, parseArchivedAt } from './validation.js';

/** The pure Project rules and the §4 projection — no database, no Fastify (TDS 07 §1). */

function capture(work: () => unknown): ApiError {
  try {
    work();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected an ApiError, but the call succeeded');
}

describe('normalizeProjectName', () => {
  it('trims before enforcing the 200-character CHECK', () => {
    expect(normalizeProjectName('  Mission Control  ')).toBe('Mission Control');
    expect(normalizeProjectName('x'.repeat(200))).toHaveLength(200);
  });

  it('rejects whitespace-only and over-long names on the name field', () => {
    expect(capture(() => normalizeProjectName('   ')).details).toMatchObject({ field: 'name' });
    expect(capture(() => normalizeProjectName('x'.repeat(201))).code).toBe('VALIDATION_FAILED');
  });
});

describe('normalizeDescription', () => {
  it('gives "absent" exactly one storage form', () => {
    expect(normalizeDescription(undefined)).toBeNull();
    expect(normalizeDescription(null)).toBeNull();
    expect(normalizeDescription('')).toBeNull();
    expect(normalizeDescription('   ')).toBeNull();
    expect(normalizeDescription('  a note ')).toBe('a note');
  });
});

describe('parseArchivedAt', () => {
  it('accepts an ISO 8601 instant and null', () => {
    expect(parseArchivedAt('2026-08-12T10:00:00.000Z')?.toISOString()).toBe(
      '2026-08-12T10:00:00.000Z',
    );
    expect(parseArchivedAt(null)).toBeNull();
  });

  it('rejects a value that is not a timestamp rather than writing an Invalid Date', () => {
    expect(capture(() => parseArchivedAt('yesterday')).details).toMatchObject({
      field: 'archivedAt',
    });
  });
});

describe('serializeProject (TDS 04 §4)', () => {
  const row = {
    id: '018f6b2e-1111-7abc-8def-0123456789ab',
    workspaceId: '018f6b2e-0000-7abc-8def-0123456789ab',
    name: 'Mission Control',
    description: null,
    status: 'active',
    workflowMode: null,
    archivedAt: null,
    createdAt: new Date('2026-08-12T09:00:00.000Z'),
    updatedAt: new Date('2026-08-12T09:30:00.000Z'),
  };

  it('emits exactly the §4 field set — no `status`, timestamps ISO 8601 with Z (F4.2)', () => {
    const resource = serializeProject(row);

    expect(Object.keys(resource).sort()).toEqual([
      'archivedAt',
      'createdAt',
      'description',
      'id',
      'name',
      'updatedAt',
      'workflowMode',
      'workspaceId',
    ]);
    expect(resource.createdAt).toBe('2026-08-12T09:00:00.000Z');
    expect(resource.archivedAt).toBeNull();
  });

  it('carries workflowMode through, with null meaning inherit', () => {
    expect(serializeProject(row).workflowMode).toBeNull();
    expect(serializeProject({ ...row, workflowMode: 'assisted' }).workflowMode).toBe('assisted');
    expect(serializeProject({ ...row, workflowMode: 'manual' }).workflowMode).toBe('manual');
    // A value the CHECK constraint cannot produce still has to project to something total.
    expect(serializeProject({ ...row, workflowMode: 'nonsense' }).workflowMode).toBeNull();
  });

  it('serializes archivedAt when the Project is archived', () => {
    const archived = serializeProject({
      ...row,
      status: 'archived',
      archivedAt: new Date('2026-08-12T11:00:00.000Z'),
    });

    expect(archived.archivedAt).toBe('2026-08-12T11:00:00.000Z');
  });
});
