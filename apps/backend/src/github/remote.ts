/**
 * Git remote URL -> GitHub coordinates. Pure, total, and deliberately strict.
 *
 * Three properties matter here and each of them is a defect we would otherwise ship:
 *
 *  1. **Embedded credentials are stripped, always.** `https://x-access-token:ghp_…@github.com/o/r`
 *     is a perfectly ordinary thing to find in an operator's `origin` remote, and it carries a
 *     live token. Nothing in this module ever returns, stores or reports a URL with userinfo in
 *     it — `canonicalUrl` is rebuilt from `host/owner/repo` rather than trimmed, so there is no
 *     "we forgot that form" case.
 *  2. **Only github.com is GitHub.** GitHub Enterprise Server lives on a customer hostname and
 *     needs an API base URL that no setting in the registry provides (§7.2 has `token`,
 *     `account`, `organizations`, `discoveryRoots`, `syncIntervalMinutes`, `workflowMode` and
 *     nothing else). Claiming to sync a GHE remote against api.github.com would 404 forever;
 *     classifying it as `remote_not_github` says the true thing.
 *  3. **A parse failure is `null`, never a throw.** Discovery runs this over whatever the
 *     filesystem happens to contain.
 */

/** The one host this integration can talk to. `www.` is accepted because git accepts it. */
const GITHUB_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com']);

/** `owner` and `repo` as GitHub itself constrains them, so a junk path cannot become a URL. */
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** `git@host:owner/repo.git` — scp-like syntax, which is not a URL and `new URL` rejects. */
const SCP_LIKE = /^(?:([^@/]+)@)?([^:/]+):(.+)$/;

export interface GithubRemote {
  /** Always `github.com` — the canonical spelling, `www.` folded away. */
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  /**
   * `https://github.com/{owner}/{repo}` — rebuilt, never echoed. This is what lands in
   * `repositories.remote_url`: it identifies the same remote, it is clickable in the UI, and
   * it cannot carry a credential.
   */
  readonly canonicalUrl: string;
}

export type RemoteClassification =
  | { readonly kind: 'github'; readonly remote: GithubRemote }
  /** A syntactically valid remote pointing somewhere that is not github.com. */
  | { readonly kind: 'other_host'; readonly host: string }
  /** Not parseable as a remote at all. */
  | { readonly kind: 'unparseable' };

/**
 * Classify a raw `git remote get-url` value.
 *
 * Handles every form git writes: `https://`, `http://`, `ssh://`, `git://`, `git+ssh://` and
 * the scp-like `git@github.com:owner/repo.git`.
 */
export function classifyRemote(raw: string): RemoteClassification {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'unparseable' };

  const parts = splitRemote(trimmed);
  if (parts === null) return { kind: 'unparseable' };

  const host = parts.host.toLowerCase();
  if (!GITHUB_HOSTS.has(host)) return { kind: 'other_host', host };

  const segments = parts.path.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return { kind: 'unparseable' };

  // `owner/repo` are the FIRST two segments, not the last two: a `.git` suffix and a trailing
  // slash are noise, but so is anything deeper — `github.com/o/r/tree/main` is a browse URL
  // someone pasted, and it still names `o/r`.
  const owner = segments[0] ?? '';
  const repo = stripGitSuffix(segments[1] ?? '');

  if (!NAME_PATTERN.test(owner) || !NAME_PATTERN.test(repo)) return { kind: 'unparseable' };

  return {
    kind: 'github',
    remote: { host: 'github.com', owner, repo, canonicalUrl: canonicalGithubUrl(owner, repo) },
  };
}

/** Convenience for callers that only care about the happy path. */
export function parseGithubRemote(raw: string): GithubRemote | null {
  const classified = classifyRemote(raw);
  return classified.kind === 'github' ? classified.remote : null;
}

export function canonicalGithubUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

interface RemoteParts {
  readonly host: string;
  readonly path: string;
}

function splitRemote(raw: string): RemoteParts | null {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    try {
      const url = new URL(raw);
      // `url.hostname` drops userinfo and the port by construction — this is the reason the
      // WHATWG parser is used here rather than a regex over the whole string.
      return url.hostname.length === 0 ? null : { host: url.hostname, path: url.pathname };
    } catch {
      return null;
    }
  }

  const match = SCP_LIKE.exec(raw);
  if (match === null) return null;

  const host = match[2] ?? '';
  const path = match[3] ?? '';
  // `C:/Repos/thing` on Windows matches the scp-like shape. A single-character "host" is a
  // drive letter, never a hostname.
  if (host.length < 2 || !host.includes('.')) return null;
  return { host, path };
}

function stripGitSuffix(segment: string): string {
  return segment.endsWith('.git') ? segment.slice(0, -'.git'.length) : segment;
}
