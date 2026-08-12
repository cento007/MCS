import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import process from 'node:process';

/** The file whose presence marks the monorepo root (F8.1 layout). */
export const WORKSPACE_ROOT_MARKER = 'pnpm-workspace.yaml';

export const ENV_FILE_NAME = '.env';

/** Sub-directories created under `MC_DATA_DIR` (TDS 02 §1.2). */
export const DATA_DIR_SUBTREE = ['exports', 'hooks', 'tmp'] as const;

/**
 * Walk up from `startDir` to the filesystem root looking for the workspace marker.
 * Returns `null` when not found (e.g. a production install laid out at
 * /opt/mission-control without the marker — that deployment supplies env via systemd
 * `EnvironmentFile`, so no `.env` discovery is needed).
 */
export function findWorkspaceRoot(startDir: string = process.cwd()): string | null {
  let current = resolve(startDir);
  const { root } = parse(current);

  for (;;) {
    if (existsSync(join(current, WORKSPACE_ROOT_MARKER))) return current;
    if (current === root) return null;
    current = dirname(current);
  }
}

/**
 * Locate the single root `.env` (TDS 02 §8.2 — one file, all processes).
 * `MC_ENV_FILE` overrides discovery entirely, which is the production escape hatch.
 */
export function findEnvFile(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = process.cwd(),
): string | null {
  const override = env['MC_ENV_FILE'];
  if (override && override.length > 0) return resolve(override);

  const root = findWorkspaceRoot(startDir);
  if (root === null) return null;

  const candidate = join(root, ENV_FILE_NAME);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Platform default for `MC_DATA_DIR` (F8.1 path rules).
 *
 * Production on Ubuntu overrides this to /var/lib/mission-control via the systemd
 * EnvironmentFile (deploy/systemd/) — the Linux default below is a developer-writable
 * location, deliberately not /var/lib.
 */
export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    if (localAppData && localAppData.length > 0) return join(localAppData, 'MissionControl');
    return join(homedir(), 'AppData', 'Local', 'MissionControl');
  }

  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'MissionControl');
  }

  const xdgDataHome = env['XDG_DATA_HOME'];
  if (xdgDataHome && xdgDataHome.length > 0) return join(xdgDataHome, 'mission-control');
  return join(homedir(), '.local', 'share', 'mission-control');
}
