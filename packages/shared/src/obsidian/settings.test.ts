import { describe, expect, it } from 'vitest';
import { settingKey } from '../settings/registry.js';
import {
  isScheduledSyncDue,
  type ObsidianSyncSettings,
  parseObsidianSettings,
  syncBlockedReason,
} from './settings.js';

const KEYS = {
  vaultPath: settingKey('integrations.obsidian.vaultPath'),
  syncMode: settingKey('integrations.obsidian.syncMode'),
  interval: settingKey('integrations.obsidian.syncIntervalMinutes'),
  policy: settingKey('integrations.obsidian.conflictPolicy'),
};

const configured: ObsidianSyncSettings = {
  vaultPath: 'D:\\Vault',
  syncMode: 'two_way',
  syncIntervalMinutes: 15,
  conflictPolicy: 'newer_wins',
};

describe('reading the settings document', () => {
  it('applies the registry defaults when no rows exist', () => {
    const settings = parseObsidianSettings(new Map());

    expect(settings).toEqual({
      vaultPath: null,
      syncMode: 'two_way',
      // 0 = "manual only": an unwritten row must not promise a sync nobody scheduled.
      syncIntervalMinutes: 0,
      conflictPolicy: 'newer_wins',
    });
  });

  it('keeps a Windows path intact', () => {
    const settings = parseObsidianSettings(
      new Map<string, unknown>([[KEYS.vaultPath, 'D:\\Repos\\Vault\\Notes']]),
    );
    expect(settings.vaultPath).toBe('D:\\Repos\\Vault\\Notes');
  });

  it('degrades a corrupt row to the documented default rather than throwing', () => {
    const settings = parseObsidianSettings(
      new Map<string, unknown>([
        [KEYS.syncMode, 'sideways'],
        [KEYS.interval, 'soon'],
        [KEYS.policy, { nested: true }],
      ]),
    );

    expect(settings.syncMode).toBe('two_way');
    expect(settings.syncIntervalMinutes).toBe(0);
    expect(settings.conflictPolicy).toBe('newer_wins');
  });
});

describe('syncBlockedReason', () => {
  it('blocks with no vault path', () => {
    expect(syncBlockedReason({ ...configured, vaultPath: null })).toBe('vault_path_missing');
    expect(syncBlockedReason({ ...configured, vaultPath: '   ' })).toBe('vault_path_missing');
  });

  it('blocks when paused', () => {
    expect(syncBlockedReason({ ...configured, syncMode: 'paused' })).toBe('sync_paused');
  });

  it('allows two-way and one-way', () => {
    expect(syncBlockedReason(configured)).toBeNull();
    expect(syncBlockedReason({ ...configured, syncMode: 'one_way' })).toBeNull();
  });
});

describe('isScheduledSyncDue', () => {
  const now = new Date('2026-08-13T12:00:00.000Z');

  it('is never due while paused or unconfigured', () => {
    expect(
      isScheduledSyncDue({ settings: { ...configured, syncMode: 'paused' }, lastRunAt: null, now }),
    ).toBe(false);
    expect(
      isScheduledSyncDue({ settings: { ...configured, vaultPath: null }, lastRunAt: null, now }),
    ).toBe(false);
  });

  it('is never due when the interval is 0 — that means manual only', () => {
    expect(
      isScheduledSyncDue({
        settings: { ...configured, syncIntervalMinutes: 0 },
        lastRunAt: null,
        now,
      }),
    ).toBe(false);
  });

  it('is due immediately when nothing has ever run', () => {
    expect(isScheduledSyncDue({ settings: configured, lastRunAt: null, now })).toBe(true);
  });

  it('waits out the interval after the last run', () => {
    expect(
      isScheduledSyncDue({
        settings: configured,
        lastRunAt: new Date('2026-08-13T11:50:00.000Z'),
        now,
      }),
    ).toBe(false);

    expect(
      isScheduledSyncDue({
        settings: configured,
        lastRunAt: new Date('2026-08-13T11:45:00.000Z'),
        now,
      }),
    ).toBe(true);
  });
});
