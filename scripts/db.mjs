#!/usr/bin/env node
/**
 * Database task runner — the ONLY entry point for drizzle-kit in this repo.
 *
 * Why it exists: every `db:*` script needs a live PostgreSQL instance, and a developer who
 * has not installed PostgreSQL yet deserves a sentence explaining that, not a connection
 * stack trace from inside a migration tool. This script preflights and then hands off.
 *
 * Cross-platform by construction (F8.1): pure Node, `execFile`-style spawning with no
 * shell, no `NODE_ENV=x cmd` prefixes, no bash-isms. Behaves identically on Windows 11 and
 * Ubuntu.
 *
 * Usage: node scripts/db.mjs <generate|migrate|push|studio|check> [drizzle-kit flags...]
 *
 * Extra arguments are forwarded verbatim, which is what makes hand-written SQL reachable
 * through this entry point rather than around it (TDS 03 §8):
 *   node scripts/db.mjs generate --custom --name=include_and_fillfactor
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_DIR = join(REPO_ROOT, 'packages', 'shared');

/** Commands that talk to a database. `generate` only diffs the schema files. */
const NEEDS_DATABASE = new Set(['migrate', 'push', 'studio', 'check']);
const KNOWN_COMMANDS = new Set(['generate', 'migrate', 'push', 'studio', 'check']);

const command = process.argv[2];

if (command === undefined || !KNOWN_COMMANDS.has(command)) {
  fail(
    `Unknown db command: ${command ?? '(none)'}`,
    `Usage: node scripts/db.mjs <${[...KNOWN_COMMANDS].join('|')}>`,
  );
}

/** Print a readable failure and exit 1. Never a stack trace. */
function fail(headline, ...details) {
  process.stderr.write(`\n[db] ${headline}\n`);
  for (const line of details) process.stderr.write(`     ${line}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

/** Minimal .env read — this script must not import the TypeScript config loader. */
function readDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const envFile = process.env.MC_ENV_FILE ?? join(REPO_ROOT, '.env');
  if (!existsSync(envFile)) {
    fail(
      'DATABASE_URL is not set and no .env file was found.',
      `Expected: ${envFile}`,
      'Fix: copy .env.example to .env at the repository root and fill it in.',
    );
  }

  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*?)\s*$/.exec(line);
    if (match) return match[1].replace(/^["']|["']$/g, '');
  }

  fail(
    `DATABASE_URL is missing from ${envFile}.`,
    'Fix: add it — see .env.example for the expected format.',
  );
  return '';
}

function parseTarget(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    return { host: url.hostname || '127.0.0.1', port: Number(url.port || 5432) };
  } catch {
    fail(
      'DATABASE_URL is not a valid connection string.',
      'Expected: postgres://USER:PASSWORD@HOST:PORT/DATABASE',
    );
    return { host: '', port: 0 };
  }
}

function canConnect({ host, port }, timeoutMs = 2000) {
  return new Promise((resolveConnect) => {
    const socket = new net.Socket();
    const done = (ok) => {
      socket.destroy();
      resolveConnect(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * drizzle-kit is a dependency of `packages/shared`, and pnpm's strict node_modules layout
 * means it is NOT hoisted to the repo root. Its `exports` map does not expose `bin.cjs`
 * either, so `require.resolve` cannot find it — hence explicit candidate paths.
 */
function resolveDrizzleKitBin() {
  const candidates = [
    join(SHARED_DIR, 'node_modules', 'drizzle-kit', 'bin.cjs'),
    join(REPO_ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    fail(
      'drizzle-kit is not installed.',
      'Fix: run `pnpm install` at the repository root.',
      `Looked in:\n       ${candidates.join('\n       ')}`,
    );
  }
  return found;
}

function runDrizzleKit(args) {
  const child = spawn(process.execPath, [resolveDrizzleKitBin(), ...args], {
    cwd: SHARED_DIR,
    stdio: 'inherit',
    env: process.env,
  });
  child.on('error', (error) => {
    fail(
      'Could not start drizzle-kit.',
      error.message,
      'Fix: run `pnpm install` at the repository root.',
    );
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

const databaseUrl = readDatabaseUrl();
process.env.DATABASE_URL = databaseUrl;

if (NEEDS_DATABASE.has(command)) {
  const target = parseTarget(databaseUrl);
  const reachable = await canConnect(target);

  if (!reachable) {
    fail(
      `PostgreSQL is not reachable at ${target.host}:${target.port}.`,
      '',
      'This repository requires a native PostgreSQL install — there is no Docker and no',
      'embedded fallback (TDS F8.1). Nothing else in the toolchain needs it:',
      '`pnpm install`, `pnpm typecheck`, `pnpm lint` and `pnpm test` all pass without a',
      'database.',
      '',
      'Windows : winget install PostgreSQL.PostgreSQL.17   (runs as a Windows service)',
      'Ubuntu  : sudo apt install postgresql-17            (PGDG repo)',
      '',
      'Then create the role and database, and check DATABASE_URL in .env.',
      'See deploy/windows/README.md for the full first-run sequence.',
    );
  }
}

// drizzle.config.ts lives in packages/shared (schema source + migration output, TDS 03 §8).
runDrizzleKit([command, '--config', 'drizzle.config.ts', ...process.argv.slice(3)]);
