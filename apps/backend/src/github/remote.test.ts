import { describe, expect, it } from 'vitest';
import { canonicalGithubUrl, classifyRemote, parseGithubRemote } from './remote.js';

describe('classifyRemote', () => {
  it.each([
    ['https://github.com/cento007/MCS.git', 'cento007', 'MCS'],
    ['https://github.com/cento007/MCS', 'cento007', 'MCS'],
    ['https://github.com/cento007/MCS/', 'cento007', 'MCS'],
    ['http://github.com/cento007/MCS.git', 'cento007', 'MCS'],
    ['git@github.com:cento007/MCS.git', 'cento007', 'MCS'],
    ['git@github.com:cento007/MCS', 'cento007', 'MCS'],
    ['ssh://git@github.com/cento007/MCS.git', 'cento007', 'MCS'],
    ['git://github.com/cento007/MCS.git', 'cento007', 'MCS'],
    ['https://www.github.com/cento007/MCS.git', 'cento007', 'MCS'],
    ['  https://github.com/cento007/MCS.git\n', 'cento007', 'MCS'],
    // A browse URL somebody pasted into `origin` still names the repository.
    ['https://github.com/cento007/MCS/tree/main', 'cento007', 'MCS'],
    // Names GitHub itself allows.
    ['https://github.com/my-org/some.repo_name-2', 'my-org', 'some.repo_name-2'],
  ])('parses %s', (raw, owner, repo) => {
    const classified = classifyRemote(raw);
    expect(classified).toEqual({
      kind: 'github',
      remote: { host: 'github.com', owner, repo, canonicalUrl: canonicalGithubUrl(owner, repo) },
    });
  });

  describe('credentials embedded in the remote', () => {
    // The security property, not a formatting nicety: a git remote is an ordinary place to find
    // a live PAT, and `canonicalUrl` is what lands in `repositories.remote_url` and in the API.
    const withToken = 'https://x-access-token:ghp_LIVE_TOKEN_VALUE@github.com/cento007/MCS.git';

    it('parses the repository', () => {
      expect(parseGithubRemote(withToken)).toEqual({
        host: 'github.com',
        owner: 'cento007',
        repo: 'MCS',
        canonicalUrl: 'https://github.com/cento007/MCS',
      });
    });

    it('never returns the credential in any field', () => {
      const serialized = JSON.stringify(classifyRemote(withToken));
      expect(serialized).not.toContain('ghp_LIVE_TOKEN_VALUE');
      expect(serialized).not.toContain('x-access-token');
      expect(serialized).not.toContain('@');
    });

    it('strips a bare username too', () => {
      expect(parseGithubRemote('https://someone@github.com/cento007/MCS.git')?.canonicalUrl).toBe(
        'https://github.com/cento007/MCS',
      );
    });

    it('strips credentials from an ssh URL', () => {
      expect(parseGithubRemote('ssh://git:secret@github.com:22/cento007/MCS.git')).toEqual({
        host: 'github.com',
        owner: 'cento007',
        repo: 'MCS',
        canonicalUrl: 'https://github.com/cento007/MCS',
      });
    });
  });

  describe('remotes that are not github.com', () => {
    it.each([
      ['https://gitlab.com/group/project.git', 'gitlab.com'],
      ['git@bitbucket.org:team/repo.git', 'bitbucket.org'],
      // GitHub Enterprise Server: a real GitHub, on a host this build has no API base URL for.
      ['https://github.mycorp.example/team/repo.git', 'github.mycorp.example'],
      ['https://githubbb.com/o/r.git', 'githubbb.com'],
      // Lookalike hosts must not pass.
      ['https://github.com.evil.test/o/r.git', 'github.com.evil.test'],
    ])('classifies %s as another host', (raw, host) => {
      expect(classifyRemote(raw)).toEqual({ kind: 'other_host', host });
    });
  });

  describe('remotes that are not remotes', () => {
    it.each([
      [''],
      ['   '],
      ['not a url at all'],
      // A local path remote, which git accepts. `D:` is a drive letter, not a hostname.
      ['D:/Repos/other-clone'],
      ['/srv/git/mirror.git'],
      ['../sibling'],
      // github.com with nothing after it.
      ['https://github.com/'],
      ['https://github.com/only-owner'],
      ['git@github.com:'],
      // A path segment that is not a legal GitHub name.
      ['https://github.com/own er/repo'],
    ])('classifies %j as unparseable', (raw) => {
      const classified = classifyRemote(raw);
      expect(classified.kind === 'unparseable' || classified.kind === 'other_host').toBe(true);
      expect(parseGithubRemote(raw)).toBeNull();
    });
  });
});
