import process from 'node:process';
import { loadConfigOrExit, schema } from '@mc/shared';
import { asc } from 'drizzle-orm';
import { AuthService } from '../auth/service.js';
import { createDatabase } from '../db/index.js';
import {
  HOOK_INGEST_PATH,
  type HookScope,
  installHookProfile,
  readInstallState,
  resolveSettingsPath,
  uninstallHookProfile,
} from '../sessions/observed/hooks-installer.js';

/**
 * `pnpm hooks:install` / `hooks:uninstall` / `hooks:status` — the observed-session hooks
 * profile (TDS 02 §6.2).
 *
 * A command rather than startup logic, for the same reason `auth:create-user` is: writing into
 * a file the operator owns is an act they should perform deliberately, and it needs a decision
 * this server cannot make for itself (user scope — every session on the machine — or one
 * repository).
 *
 *   pnpm hooks:install                          # user scope, mints a fresh ingest token
 *   pnpm hooks:install --scope project --project-root D:\Repos\MCS
 *   pnpm hooks:install --token mct_…            # reuse an existing ingest-scoped token
 *   pnpm hooks:install --url http://host:8710/api/v1/hook-events
 *   pnpm hooks:status
 *   pnpm hooks:uninstall                        # every recorded install
 *   pnpm hooks:uninstall --settings <path>      # just one
 *
 * Re-running `install` is the repair path: the merge is surgical and idempotent, so it replaces
 * Mission Control's own entries and leaves every other hook in the file untouched.
 */

const USAGE = `
Usage: pnpm hooks:<install|uninstall|status> [options]

  --scope <user|project>   Where to install. Default: user (observes every session).
  --project-root <path>    Required for --scope project.
  --url <url>              Ingest URL. Default: http://<MC_HOST>:<MC_PORT>${HOOK_INGEST_PATH}
  --token <mct_…>          Reuse an existing ingest-scoped API token instead of minting one.
  --settings <path>        uninstall only: limit removal to one settings file.

The token is written into the target settings.json (the runtime needs it in plaintext to send
it) and recorded in MC_DATA_DIR/hooks/state.json. Both files are written 0600.
`;

interface Args {
  readonly command: string;
  readonly scope: HookScope;
  readonly projectRoot: string | null;
  readonly url: string | null;
  readonly token: string | null;
  readonly settings: string | null;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let command = '';
  let scope: HookScope = 'user';
  let projectRoot: string | null = null;
  let url: string | null = null;
  let token: string | null = null;
  let settings: string | null = null;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case 'install':
      case 'uninstall':
      case 'status':
        command = arg;
        break;
      case '--scope': {
        const value = argv[++i];
        if (value !== 'user' && value !== 'project') fail(`--scope must be user or project`);
        scope = value;
        break;
      }
      case '--project-root':
        projectRoot = argv[++i] ?? null;
        break;
      case '--url':
        url = argv[++i] ?? null;
        break;
      case '--token':
        token = argv[++i] ?? null;
        break;
      case '--settings':
        settings = argv[++i] ?? null;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        fail(`Unknown argument: ${String(arg)}${USAGE}`);
    }
  }

  return { command, scope, projectRoot, url, token, settings, help };
}

function fail(message: string): never {
  process.stderr.write(`\n[hooks] ${message}\n\n`);
  process.exit(1);
}

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command.length === 0) {
    out(USAGE);
    return;
  }

  const config = loadConfigOrExit();

  if (args.command === 'status') {
    const state = await readInstallState(config.dataDir);
    if (state.installs.length === 0) {
      out('No Mission Control hook profile is installed.');
      return;
    }
    for (const install of state.installs) {
      out(
        `${install.scope.padEnd(7)} ${install.settingsPath}\n` +
          `        url    ${install.ingestUrl}\n` +
          `        token  ${install.tokenPrefix}…\n` +
          `        events ${install.events.join(', ')}\n` +
          `        since  ${install.installedAt}`,
      );
    }
    return;
  }

  if (args.command === 'uninstall') {
    const result = await uninstallHookProfile({
      dataDir: config.dataDir,
      ...(args.settings === null ? {} : { settingsPath: args.settings }),
    });

    for (const path of result.removedFrom) out(`Removed Mission Control hooks from ${path}`);
    for (const path of result.missing) out(`Nothing of ours found in ${path} — left alone`);
    if (result.removedFrom.length === 0 && result.missing.length === 0) {
      out('No recorded installs. Nothing to do.');
    }
    return;
  }

  const ingestUrl = args.url ?? `http://${config.host}:${config.port}${HOOK_INGEST_PATH}`;
  const settingsPath = resolveSettingsPath({
    scope: args.scope,
    ...(args.projectRoot === null ? {} : { projectRoot: args.projectRoot }),
  });

  const token = args.token ?? (await mintIngestToken(config.databaseUrl, args.scope));

  const result = await installHookProfile({
    ingestUrl,
    token,
    scope: args.scope,
    settingsPath,
    dataDir: config.dataDir,
  });

  out(`Installed the Mission Control hook profile into ${result.settingsPath}`);
  out(`  events   ${result.events.join(', ')}`);
  out(`  url      ${ingestUrl}`);
  if (result.replaced > 0) out(`  replaced ${result.replaced} earlier Mission Control entr(y|ies)`);
  if (result.backupPath !== null) out(`  backup   ${result.backupPath}`);
  out(`  state    ${result.statePath}`);
  if (args.token === null) {
    out(`  token    ${token.slice(0, 8)}… (scope: ingest — it can call only ${HOOK_INGEST_PATH})`);
  }
}

/**
 * Mint an `ingest`-scoped token for this install.
 *
 * Scope `ingest` is the entire security story of the hook channel: the token lives in a
 * plaintext settings file that any process running as the operator can read, so it must be able
 * to do exactly one thing — post hook events. The guard enforces that (`INGEST_ROUTE`), and it
 * cannot open a WebSocket, read a transcript or touch settings.
 */
async function mintIngestToken(connectionString: string, scope: HookScope): Promise<string> {
  const database = createDatabase({ connectionString, maxConnections: 2 });

  try {
    const users = await database.db
      .select({ id: schema.users.id, username: schema.users.username })
      .from(schema.users)
      .orderBy(asc(schema.users.id))
      .limit(1);

    const user = users[0];
    if (user === undefined) {
      fail('No local account exists yet. Run `pnpm auth:create-user --username <name>` first.');
    }

    const auth = new AuthService({ db: database.db });
    const created = await auth.createApiToken(
      {
        userId: user.id,
        username: user.username,
        authMethod: 'token',
        scopes: ['full'],
        authSession: null,
        apiToken: null,
      },
      { name: `claude-code-hooks (${scope}) ${new Date().toISOString()}`, scopes: ['ingest'] },
      { requestId: 'cli:hooks:install', ipAddress: null, userAgent: null },
    );

    return created.token;
  } finally {
    await database.close();
  }
}

await main();
