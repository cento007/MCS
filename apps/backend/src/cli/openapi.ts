import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type { Db } from '@mc/shared';
import { buildApp } from '../app.js';
import {
  API_TYPES_PATH,
  OPENAPI_DOCUMENT_PATH,
  renderApiTypesFor,
  renderOpenApiYaml,
} from '../http/openapi/index.js';

/**
 * `pnpm api:spec` (write) and `pnpm api:spec:check` (fail if stale) — the F5.1 contract artifacts.
 *
 *   pnpm api:spec                 # regenerate openapi.yaml and the generated client types
 *   pnpm api:spec:check           # exit 1 if either file is not what the routes imply
 *   pnpm api:types                # the same command, named for the artifact people look for
 *   pnpm api:spec --out <path>    # write the document somewhere else; useful for diffing by hand
 *
 * **Two files, one command, on purpose.** `openapi.yaml` and
 * `apps/frontend/src/lib/api/types.generated.ts` are the same contract in two spellings: the
 * second is emitted from the first's components. Regenerating one without the other would
 * reintroduce exactly the gap this exists to close — a document that states a response shape and
 * a client that does not have it.
 *
 * **No database, no socket, no network.** The artifacts are a function of the route table, and the
 * route table exists as soon as the app is built — so this builds the app with a `db` handle that
 * throws if anything touches it, which is what keeps the command runnable on a fresh clone and in
 * CI before any service exists.
 *
 * **Staleness is caught in two places, on purpose.** This command is the one CI can run on its
 * own; `http/openapi/openapi.contract.test.ts` makes the same assertions inside `pnpm test`, so a
 * route added without regenerating fails the ordinary test run rather than waiting for someone to
 * remember a separate step. Both failures name the command that fixes it.
 */

const USAGE = `
Usage: pnpm api:spec [--check] [--out <path>] [--types-out <path>]

  --check             Do not write. Exit 1 if either file on disk differs from what is generated.
  --out <path>        Write the OpenAPI document to <path> instead of the repository-root openapi.yaml.
  --types-out <path>  Write the generated client types to <path>.
`;

interface Args {
  readonly check: boolean;
  readonly out: string;
  readonly typesOut: string;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let check = false;
  let out = OPENAPI_DOCUMENT_PATH;
  let typesOut = API_TYPES_PATH;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    // `pnpm run <script> -- --check` forwards the separator itself; swallow it rather than
    // making the idiomatic invocation an error.
    if (argument === '--') continue;
    if (argument === '--check') check = true;
    else if (argument === '--out' || argument === '--types-out') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} needs a path`);
      if (argument === '--out') out = path.resolve(value);
      else typesOut = path.resolve(value);
      index += 1;
    } else if (argument === '--help' || argument === '-h') help = true;
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }

  return { check, out, typesOut, help };
}

/**
 * A `Db` that throws on any access.
 *
 * The generator must never open a connection — it runs on machines with no PostgreSQL — and a
 * handle that throws proves that property instead of asserting it in a comment.
 */
const NO_DATABASE = new Proxy(
  {},
  {
    get() {
      throw new Error('openapi generation must not touch the database');
    },
  },
) as Db;

/** The first differing line, quoted — enough to see what changed without printing a diff. */
function firstDifference(committed: string, generated: string): string {
  const left = committed.split('\n');
  const right = generated.split('\n');
  const length = Math.max(left.length, right.length);

  for (let line = 0; line < length; line += 1) {
    if (left[line] === right[line]) continue;
    return [
      `First difference at line ${line + 1}:`,
      `  committed: ${left[line] ?? '<end of file>'}`,
      `  generated: ${right[line] ?? '<end of file>'}`,
    ].join('\n');
  }
  return 'The files differ only in trailing content.';
}

interface Artifact {
  readonly label: string;
  readonly file: string;
  readonly content: string;
}

async function check(artifact: Artifact): Promise<boolean> {
  const committed = await readFile(artifact.file, 'utf8').catch(() => null);
  if (committed === artifact.content) {
    process.stdout.write(`[api:spec] ${artifact.file} is up to date\n`);
    return true;
  }

  process.stderr.write(
    committed === null
      ? `\n[api:spec] ${artifact.file} does not exist. Run "pnpm api:spec".\n\n`
      : `\n[api:spec] ${artifact.file} is stale — the routes and the committed ${artifact.label} disagree.\n` +
          `     Run "pnpm api:spec" and commit the result.\n\n${firstDifference(committed, artifact.content)}\n\n`,
  );
  return false;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE.trim()}\n`);
    return;
  }

  const app = buildApp({ logLevel: 'silent', db: NO_DATABASE });
  let artifacts: readonly Artifact[];
  try {
    // Routes registered inside a plugin (the WS hub, the managed-session prompt route) reach
    // the route table only once the plugin tree is built, and a document missing them would be
    // wrong in exactly the way this command exists to prevent.
    await app.ready();
    artifacts = [
      { label: 'document', file: args.out, content: renderOpenApiYaml(app) },
      { label: 'client types', file: args.typesOut, content: renderApiTypesFor(app) },
    ];
  } finally {
    await app.close();
  }

  if (!args.check) {
    for (const artifact of artifacts) {
      await writeFile(artifact.file, artifact.content, 'utf8');
      process.stdout.write(`[api:spec] wrote ${artifact.file}\n`);
    }
    return;
  }

  // Every artifact is checked before exiting, so one run reports both problems rather than
  // sending whoever fixes the first back for a second round.
  const results = [];
  for (const artifact of artifacts) results.push(await check(artifact));
  if (results.some((ok) => !ok)) process.exitCode = 1;
}

await main();
