import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The structural half of TDS 02 §2's rule: **`sessions/state-machine.ts` is the ONLY code path
 * that mutates `sessions.state`.**
 *
 * Two layers already enforce it inside the type system:
 *   1. `repository.ts`'s `SessionUpdate` is `Omit<…, 'state'>`, so `updateSession()` cannot
 *      carry a state — passing one is a compile error;
 *   2. `insertSession()` writes the literal `INITIAL_SESSION_STATE` and takes no state
 *      parameter, because a row's birth is F7's `[*] --> created`, not a transition.
 *
 * Neither stops somebody writing a fresh `db.update(schema.sessions).set({ state })` in a new
 * file, and that is the failure this test exists to catch. It scans the Backend sources for any
 * `UPDATE sessions … SET state` outside the state machine and fails the build if it finds one.
 * A grep is a blunt instrument; it is also the only instrument that survives a developer who
 * has never read this paragraph.
 */

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The one file allowed to write the column, relative to `src/`. */
const STATE_WRITER = join('sessions', 'state-machine.ts');

/**
 * `.update(<something>sessions)` … `.set({ … })`, across lines. Deliberately greedy about what
 * counts as "the sessions table" (`schema.sessions`, `sessions`, an aliased import) and
 * deliberately narrow about the distance between the two calls, so a chained Drizzle builder is
 * matched and two unrelated statements are not.
 */
const SESSION_UPDATE_WITH_SET =
  /\.update\(\s*(?:[A-Za-z_$][\w$]*\.)?sessions\s*\)[\s\S]{0,600}?\.set\(\s*\{([\s\S]*?)\}\s*\)/g;

const STATE_ASSIGNMENT = /(^|[\s,{])state\s*:/;

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    files.push(full);
  }
  return files;
}

describe('single-writer rule for sessions.state (TDS 02 §2)', () => {
  it('finds the state machine where the rule says it is', () => {
    const files = sourceFiles(SOURCE_ROOT).map((file) => relative(SOURCE_ROOT, file));
    expect(files).toContain(STATE_WRITER);
  });

  it('lets no module outside state-machine.ts write sessions.state', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SOURCE_ROOT)) {
      const relativePath = relative(SOURCE_ROOT, file);
      if (relativePath === STATE_WRITER) continue;

      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(SESSION_UPDATE_WITH_SET)) {
        if (STATE_ASSIGNMENT.test(match[1] ?? '')) {
          offenders.push(relativePath.split(sep).join('/'));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('still detects a violation — the guard is not vacuous', () => {
    const violation = `
      await tx
        .update(schema.sessions)
        .set({ state: 'running', updatedAt: new Date() })
        .where(eq(schema.sessions.id, id));
    `;

    const matches = [...violation.matchAll(SESSION_UPDATE_WITH_SET)];
    expect(matches).toHaveLength(1);
    expect(STATE_ASSIGNMENT.test(matches[0]?.[1] ?? '')).toBe(true);
  });

  it('does not flag an update that leaves state alone', () => {
    const benign = `
      await db
        .update(schema.sessions)
        .set({ title, updatedAt: new Date() })
        .where(eq(schema.sessions.id, id));
    `;

    const matches = [...benign.matchAll(SESSION_UPDATE_WITH_SET)];
    expect(matches).toHaveLength(1);
    expect(STATE_ASSIGNMENT.test(matches[0]?.[1] ?? '')).toBe(false);
  });

  it('confirms the state machine is the module that does write it', () => {
    const source = readFileSync(join(SOURCE_ROOT, STATE_WRITER), 'utf8');
    const matches = [...source.matchAll(SESSION_UPDATE_WITH_SET)];

    expect(matches).toHaveLength(1);
    expect(STATE_ASSIGNMENT.test(matches[0]?.[1] ?? '')).toBe(true);
  });
});
