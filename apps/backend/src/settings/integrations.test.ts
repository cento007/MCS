import { describe, expect, it } from 'vitest';
import { parseScheduleIntegrationSettings } from './integrations.js';

/**
 * The schedule read model's inputs (§7.7). The property that matters here is honesty about
 * *absence*: an unwritten interval row means "never configured", so it reads as `0` — "manual
 * only" — rather than as the value the Settings form happens to pre-fill.
 */
describe('parseScheduleIntegrationSettings (§7.2 / §7.6)', () => {
  it('reads configured values from the DB keys the registry derivation rule produces', () => {
    const settings = parseScheduleIntegrationSettings(
      new Map<string, unknown>([
        ['obsidian_vault_path', 'D:\\Vaults\\Engineering'],
        ['obsidian_sync_mode', 'two_way'],
        ['obsidian_sync_interval_minutes', 15],
        ['github_sync_interval_minutes', 30],
        ['telegram_enabled', true],
      ]),
      new Set(['github_token', 'telegram_bot_token']),
    );

    expect(settings.obsidian).toEqual({
      vaultPath: 'D:\\Vaults\\Engineering',
      syncMode: 'two_way',
      syncIntervalMinutes: 15,
    });
    expect(settings.github).toEqual({ tokenIsSet: true, syncIntervalMinutes: 30 });
    expect(settings.telegram).toEqual({ enabled: true, botTokenIsSet: true });
  });

  it('reads an unconfigured instance as unconfigured, not as a default schedule', () => {
    const settings = parseScheduleIntegrationSettings(new Map(), new Set());

    expect(settings.obsidian.vaultPath).toBeNull();
    expect(settings.obsidian.syncIntervalMinutes).toBe(0);
    expect(settings.github.syncIntervalMinutes).toBe(0);
    expect(settings.github.tokenIsSet).toBe(false);
    expect(settings.telegram.enabled).toBe(false);
  });

  it('reports secret presence without ever reading a secret', () => {
    const withToken = parseScheduleIntegrationSettings(new Map(), new Set(['github_token']));
    const without = parseScheduleIntegrationSettings(new Map(), new Set());

    expect(withToken.github.tokenIsSet).toBe(true);
    expect(without.github.tokenIsSet).toBe(false);
  });

  it('falls back to a known sync mode on a corrupt row', () => {
    const settings = parseScheduleIntegrationSettings(
      new Map<string, unknown>([['obsidian_sync_mode', 'sideways']]),
      new Set(),
    );

    expect(settings.obsidian.syncMode).toBe('two_way');
  });
});
