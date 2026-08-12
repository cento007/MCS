import process from 'node:process';
import { createInterface } from 'node:readline';
import { loadConfigOrExit } from '@mc/shared';
import { BootstrapError, bootstrapLocalUser } from '../auth/bootstrap.js';
import { MIN_PASSWORD_LENGTH } from '../auth/passwords.js';
import { createDatabase } from '../db/index.js';

/**
 * `pnpm auth:create-user` — creates the single local account (F4.1) on a fresh install.
 *
 * Why a command and not startup logic: see the GAP note at the top of `auth/bootstrap.ts`.
 * The TDS says the first-run seed is "application startup logic (idempotent upsert)" but
 * never says where the password comes from, and no correct answer exists that a server can
 * invent for itself.
 *
 * Non-interactive by default so it works from a provisioning script or a systemd one-shot:
 *
 *   MC_BOOTSTRAP_PASSWORD=… pnpm auth:create-user --username operator
 *   echo 'correct horse battery staple' | pnpm auth:create-user --username operator
 *   pnpm auth:create-user --username operator            # prompts, hidden, on a TTY
 *
 * `MC_BOOTSTRAP_PASSWORD` is **tooling-only** and is never read by application code — it is
 * not part of the F8.2 bootstrap variable set, which stays locked (the same treatment
 * TDS 07 §3.1 gives `TEST_DATABASE_URL`). The password is never accepted as a command-line
 * argument: argv is visible to every process on the machine.
 *
 * Re-running is safe: an existing account is reported, never overwritten. `--reset-password`
 * is the explicit lockout escape hatch and must name the account that already exists.
 */

interface Args {
  username: string | null;
  displayName: string | null;
  resetPassword: boolean;
  help: boolean;
}

const USAGE = `
Usage: pnpm auth:create-user --username <name> [--display-name <name>] [--reset-password]

Password source, in order:
  1. MC_BOOTSTRAP_PASSWORD          tooling-only env var; not part of the app config set
  2. stdin, when it is piped        echo 'my passphrase' | pnpm auth:create-user --username op
  3. hidden prompt                  when stdin is a TTY

The password is never taken from a command-line argument (argv is world-readable).
Minimum length: ${MIN_PASSWORD_LENGTH} characters.
`;

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { username: null, displayName: null, resetPassword: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      // pnpm inserts a bare `--` when forwarding through a workspace script
      // (`pnpm --filter … run auth:create-user --`), and it arrives in argv. Skipping it here
      // rather than in the root script keeps the command working however it is invoked —
      // directly, through pnpm, or through another layer that adds its own separator.
      case '--':
        break;
      case '--username':
        args.username = argv[++i] ?? null;
        break;
      case '--display-name':
        args.displayName = argv[++i] ?? null;
        break;
      case '--reset-password':
        args.resetPassword = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (arg?.startsWith('--password')) {
          fail(`${arg} is not supported — see the password sources below.${USAGE}`);
        }
        fail(`Unknown argument: ${String(arg)}${USAGE}`);
    }
  }

  return args;
}

function fail(message: string): never {
  process.stderr.write(`\n[auth:create-user] ${message}\n\n`);
  process.exit(1);
}

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** Read every byte of piped stdin as the password. Trailing newline from `echo` is stripped. */
async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

/**
 * Hidden TTY prompt. `readline` has no built-in masking, so the interface's output writer is
 * replaced for the duration — the documented workaround, and the reason this path is only
 * ever reached when stdin is an interactive terminal.
 */
async function promptHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const muted = rl as unknown as { _writeToOutput: (chunk: string) => void };
  const write = muted._writeToOutput.bind(rl);

  process.stdout.write(question);
  muted._writeToOutput = () => {
    /* swallow every echoed character, including the prompt redraw */
  };

  try {
    return await new Promise<string>((resolve) => {
      rl.question('', (answer) => resolve(answer));
    });
  } finally {
    muted._writeToOutput = write;
    rl.close();
    process.stdout.write('\n');
  }
}

async function resolvePassword(): Promise<string> {
  // Real process environment wins over piped input, the same precedence the bootstrap config
  // loader applies (TDS 02 §8.2). It also keeps this command from blocking forever when it is
  // spawned with an open-but-idle stdin pipe, which is how most provisioning tools spawn.
  const fromEnv = process.env['MC_BOOTSTRAP_PASSWORD'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;

  if (!process.stdin.isTTY) {
    const piped = await readPasswordFromStdin();
    if (piped.length > 0) return piped;

    fail(`No password supplied on stdin and MC_BOOTSTRAP_PASSWORD is unset.${USAGE}`);
  }

  const password = await promptHidden('Password: ');
  const confirm = await promptHidden('Confirm password: ');
  if (password !== confirm) fail('Passwords did not match. Nothing was changed.');
  return password;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    out(USAGE);
    return;
  }
  if (args.username === null || args.username.length === 0) {
    fail(`--username is required.${USAGE}`);
  }

  const password = await resolvePassword();
  const config = loadConfigOrExit();
  const database = createDatabase({ connectionString: config.databaseUrl, maxConnections: 2 });

  try {
    const result = await bootstrapLocalUser(database.db, {
      username: args.username,
      password,
      displayName: args.displayName,
      allowPasswordReset: args.resetPassword,
    });

    switch (result.status) {
      case 'created':
        out(`Created local account '${result.username}'. Sign in at the dashboard to continue.`);
        break;
      case 'password_reset':
        out(`Password replaced for local account '${result.username}'.`);
        break;
      case 'already_exists':
        process.stderr.write(
          `\n[auth:create-user] An account already exists ('${result.username}') and nothing was ` +
            'changed.\n     Mission Control V1 has exactly one local account (F4.1).\n' +
            `     To replace its password: pnpm auth:create-user --username ${result.username} --reset-password\n\n`,
        );
        process.exitCode = 1;
        break;
    }
  } catch (error) {
    if (error instanceof BootstrapError) fail(error.message);
    throw error;
  } finally {
    await database.close();
  }
}

await main();
