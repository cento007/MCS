import { describe, expect, it } from 'vitest';
import { WORKING_TREE_UNAVAILABLE_REASONS } from '../../lib/api/index.js';
import { makeStatus } from './test-support.js';
import { describeWorkingTree, unavailableSentence, workingTreeColorVar } from './working-tree.js';

/**
 * The working-tree read model, rendered honestly (TDS 06 §5.3.2 / WC11).
 *
 * The single rule under test: **nothing that failed to read may render as clean.** The endpoint
 * answers `200` with an `unavailableReason` rather than an error, which makes it very easy for a
 * client to treat "no dirty-file count" as "no dirty files" — the one misreading that costs the
 * operator uncommitted work.
 */

describe('a readable working tree', () => {
  it('reports a clean tree as clean, with its branch', () => {
    const summary = describeWorkingTree(makeStatus({ currentBranch: 'DEV', uncommittedFiles: 0 }));

    expect(summary.kind).toBe('clean');
    expect(summary.branchLabel).toBe('DEV');
    expect(summary.headline).toBe('clean');
  });

  it('counts uncommitted files and pluralises them', () => {
    expect(describeWorkingTree(makeStatus({ uncommittedFiles: 1 })).headline).toBe(
      '1 uncommitted file',
    );
    expect(describeWorkingTree(makeStatus({ uncommittedFiles: 3 })).headline).toBe(
      '3 uncommitted files',
    );
    expect(describeWorkingTree(makeStatus({ uncommittedFiles: 3 })).kind).toBe('dirty');
  });

  it('names a detached HEAD instead of inventing a branch', () => {
    const summary = describeWorkingTree(
      makeStatus({ detachedHead: true, currentBranch: null, uncommittedFiles: 0 }),
    );
    expect(summary.branchLabel).toBe('detached HEAD');
    expect(summary.kind).toBe('clean');
  });

  it('renders divergence from upstream, and says so when there is none', () => {
    expect(describeWorkingTree(makeStatus({ ahead: 2, behind: 1 })).divergence).toBe('↑2 ↓1');
    expect(describeWorkingTree(makeStatus({ ahead: 0, behind: 0 })).divergence).toBe(
      'up to date with upstream',
    );
    // No upstream is a real, common state (a fresh local branch) and must not read as in-sync.
    expect(describeWorkingTree(makeStatus({ ahead: null, behind: null })).divergence).toBeNull();
  });

  it('mentions a branch with no commits yet rather than showing a bare clean', () => {
    const summary = describeWorkingTree(makeStatus({ headSha: null, uncommittedFiles: 0 }));
    expect(summary.detail).toBe('no commits on this branch yet');
  });
});

describe('an unreadable working tree is never clean', () => {
  it.each(WORKING_TREE_UNAVAILABLE_REASONS)('renders %s as "cannot verify"', (reason) => {
    const summary = describeWorkingTree(
      makeStatus({
        isGitWorkingTree: false,
        currentBranch: null,
        headSha: null,
        uncommittedFiles: null,
        ahead: null,
        behind: null,
        unavailableReason: reason,
      }),
    );

    expect(summary.kind).toBe('unverifiable');
    expect(summary.headline).toBe('cannot verify');
    expect(summary.headline).not.toBe('clean');
    // Every reason gets a sentence naming something the operator can act on.
    expect(summary.detail).toContain(unavailableSentence(reason));
  });

  it('passes git’s own complaint through when the server supplied one', () => {
    const summary = describeWorkingTree(
      makeStatus({
        isGitWorkingTree: false,
        uncommittedFiles: null,
        unavailableReason: 'not_a_git_repository',
        detail: 'fatal: not a git repository',
      }),
    );
    expect(summary.detail).toContain('fatal: not a git repository');
  });

  it('treats a missing status (never read, or the request failed) as unverifiable', () => {
    expect(describeWorkingTree(null).kind).toBe('unverifiable');
    expect(describeWorkingTree(undefined).kind).toBe('unverifiable');
    expect(describeWorkingTree(null).headline).toBe('cannot verify');
  });

  it('refuses to call a tree clean when git reported no file count', () => {
    // `unavailableReason: null` says the tree was read, but with no count there is nothing to
    // report as clean — the safe reading is the honest one.
    const summary = describeWorkingTree(makeStatus({ uncommittedFiles: null }));
    expect(summary.kind).toBe('unverifiable');
  });

  it('colours an unverifiable tree as a warning, not as a neutral', () => {
    expect(workingTreeColorVar('unverifiable')).toBe('--color-warning');
    expect(workingTreeColorVar('clean')).toBe('--color-success');
    expect(workingTreeColorVar('dirty')).toBe('--color-warning');
  });
});
