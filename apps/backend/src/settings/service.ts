import type {
  Db,
  DbTransaction,
  DocumentCategory,
  IntegrationSlug,
  IntegrationsSettings,
  SettingsCategory,
  SettingsDocument,
} from '@mc/shared';
import { recordAuditEntry } from '../audit/index.js';
import { auditActorContext, type Principal } from '../auth/principal.js';
import type { Outbox, OutboxTransaction } from '../events/index.js';
import type { RequestContext } from '../http/context.js';
import {
  categoryDocument,
  categoryWritePlan,
  integrationDocument,
  integrationsDocument,
  integrationWritePlan,
  type StoredCategory,
  valuesEqual,
  type WritePlan,
} from './documents.js';
import type { SecretVault } from './secrets.js';
import { deleteSecret, deleteSetting, upsertSecret, upsertSetting } from './store.js';
import {
  type DbLike,
  readAllSecretRows,
  readAllSettingRows,
  readCategoryValues,
  readSecretPresence,
  type SecretPresence,
} from './values.js';

/**
 * The Settings service (TDS 04 §7.1–§7.3, PRD §4.4).
 *
 * Three properties, in the order they matter:
 *
 *  1. **A secret is never served.** Reads produce `{ isSet, updatedAt }`; nothing in this file
 *    decrypts anything. The only path out of `secret_items` is Test Connection, which hands a
 *    plaintext to the integration it belongs to and returns a *result*.
 *  2. **A write is one transaction.** Settings rows, secret rows, the audit entries and the
 *    `setting.updated` job all commit together through the outbox (F6.3) — so a worker can
 *    never be woken by a config-changed event whose config change then rolls back, and a
 *    change can never happen without its audit row.
 *  3. **Only real changes are recorded.** `changedKeys` is computed by comparing *normalized*
 *    values, so re-saving an unchanged panel writes no rows, emits no event, and leaves no
 *    audit noise. An operator who opens Settings and presses Save has not changed anything and
 *    the log should not claim they did.
 */

export interface SettingsServiceOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly vault: SecretVault;
}

/** One secret's transition. Presence only — never a value, not even a length (§7.1). */
interface SecretChange {
  readonly key: string;
  readonly entityId: string | null;
  readonly wasSet: boolean;
  readonly isSet: boolean;
}

/** What one write actually changed. Keys and presence — never secret values (§7.6). */
interface ChangeSet {
  readonly changedKeys: readonly string[];
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
  readonly secrets: readonly SecretChange[];
}

export class SettingsService {
  readonly #db: Db;
  readonly #outbox: Outbox;
  readonly #vault: SecretVault;

  constructor(options: SettingsServiceOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#vault = options.vault;
  }

  // ------------------------------------------------------------------------------- reading

  /** `GET /api/v1/settings` — every category, secrets masked (§7.3). */
  async readAll(): Promise<SettingsDocument> {
    const [settingRows, secretRows] = await Promise.all([
      readAllSettingRows(this.#db),
      readAllSecretRows(this.#db),
    ]);

    const byCategory = new Map<
      string,
      { values: Map<string, unknown>; secrets: Map<string, SecretPresence> }
    >();
    const bucket = (category: string) => {
      let entry = byCategory.get(category);
      if (entry === undefined) {
        entry = { values: new Map(), secrets: new Map() };
        byCategory.set(category, entry);
      }
      return entry;
    };
    for (const row of settingRows) bucket(row.category).values.set(row.key, row.value);
    for (const row of secretRows) {
      bucket(row.category).secrets.set(row.key, {
        id: row.id,
        updatedAt: row.updatedAt,
        keyVersion: row.keyVersion,
      });
    }
    const stored = (category: SettingsCategory): StoredCategory =>
      byCategory.get(category) ?? { values: new Map(), secrets: new Map() };

    return {
      general: categoryDocument<SettingsDocument['general']>('general', stored('general')),
      integrations: integrationsDocument(stored('integrations')),
      notifications: categoryDocument<SettingsDocument['notifications']>(
        'notifications',
        stored('notifications'),
      ),
      memory: categoryDocument<SettingsDocument['memory']>('memory', stored('memory')),
      // Phase 4: the category exists in the storage CHECK and in the Settings rail, and it has
      // no fields yet. `{}` is the honest answer; inventing placeholder fields would create
      // settings nothing reads and a migration to remove them. `memory` was the same until its
      // two PRD §4.4 fields acquired a consumer — the indexer and the retention sweep.
      agents: {},
      security: categoryDocument<SettingsDocument['security']>('security', stored('security')),
    };
  }

  /** `GET /api/v1/settings/{category}` for the five document categories (§7.3). */
  async readCategory(category: DocumentCategory): Promise<Record<string, unknown>> {
    return categoryDocument(category, await readStored(this.#db, category));
  }

  /** `GET /api/v1/settings/integrations` — all six, masked (§7.3). */
  async readIntegrations(): Promise<IntegrationsSettings> {
    return integrationsDocument(await readStored(this.#db, 'integrations'));
  }

  // ------------------------------------------------------------------------------- writing

  /** `PUT /api/v1/settings/{category}` — full-category replace (§7.3, A14). */
  async replaceCategory(
    principal: Principal,
    category: DocumentCategory,
    body: unknown,
    ctx: RequestContext,
  ): Promise<Record<string, unknown>> {
    return this.#replace({
      principal,
      ctx,
      category,
      integration: null,
      plan: categoryWritePlan(category, body),
      render: (stored) => categoryDocument(category, stored),
    });
  }

  /** `PUT /api/v1/settings/integrations/{integration}` (§7.3, A14). */
  async replaceIntegration(
    principal: Principal,
    slug: IntegrationSlug,
    body: unknown,
    ctx: RequestContext,
  ): Promise<Record<string, unknown>> {
    return this.#replace({
      principal,
      ctx,
      category: 'integrations',
      integration: slug,
      plan: integrationWritePlan(slug, body),
      render: (stored) => integrationDocument(slug, stored),
    });
  }

  async #replace(input: {
    readonly principal: Principal;
    readonly ctx: RequestContext;
    readonly category: SettingsCategory;
    readonly integration: IntegrationSlug | null;
    readonly plan: WritePlan;
    readonly render: (stored: StoredCategory) => Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const { principal, ctx, category, integration, plan, render } = input;

    return this.#outbox.run(async (outboxTx) => {
      const tx = outboxTx.tx;
      const current = await readStored(tx, category);

      const changes = await this.#applyPlan(tx, category, plan, current);

      if (changes.changedKeys.length > 0) {
        await outboxTx.emit(
          this.#outbox.event('setting.updated', {
            category,
            integration,
            // Registry DB keys — names only, never values (§7.6, §15.2 event 21).
            changedKeys: [...changes.changedKeys],
            actorId: principal.userId,
          }),
        );

        await this.#recordAudit(outboxTx, principal, ctx, category, integration, changes);
      }

      // Re-read inside the transaction rather than projecting the plan: it proves the database
      // accepted every row (the `value_type` CHECK is the authority, not this process), and it
      // is the only way to answer with the *real* `secret_items.updated_at` — the A15 timestamp
      // that is the operator's sole confirmation that a write-only value landed.
      return render(await readStored(tx, category));
    });
  }

  async #applyPlan(
    tx: DbTransaction,
    category: SettingsCategory,
    plan: WritePlan,
    current: StoredCategory,
  ): Promise<ChangeSet> {
    const changedKeys: string[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const secrets: SecretChange[] = [];

    for (const [key, { entry, value }] of plan.values) {
      const currentValue = entry.normalize(current.values.get(key));
      if (valuesEqual(currentValue, value)) continue;

      if (value === null) {
        await deleteSetting(tx, category, key);
      } else {
        await upsertSetting(tx, { category, key, value, valueType: entry.valueType });
      }

      changedKeys.push(key);
      before[key] = currentValue;
      after[key] = value;
    }

    for (const [key, { instruction }] of plan.secrets) {
      const existing = current.secrets.get(key);
      const wasSet = existing !== undefined;

      if (instruction.kind === 'clear') {
        // Clearing an unset secret is not a change: no row to delete, nothing to audit.
        if (!wasSet) continue;
        await deleteSecret(tx, category, key);
        changedKeys.push(key);
        secrets.push({ key, entityId: existing.id, wasSet, isSet: false });
        continue;
      }

      // A `set` is always recorded as a change, even when the plaintext happens to equal the
      // stored one: deciding otherwise would mean decrypting the old value to compare, and a
      // deliberate credential rotation must appear in the audit log either way.
      const sealed = this.#vault.seal({ category, key }, instruction.plaintext);
      const entityId = await upsertSecret(tx, {
        category,
        key,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        keyVersion: sealed.keyVersion,
      });
      changedKeys.push(key);
      secrets.push({ key, entityId, wasSet, isSet: true });
    }

    return { changedKeys, before, after, secrets };
  }

  async #recordAudit(
    outboxTx: OutboxTransaction,
    principal: Principal,
    ctx: RequestContext,
    category: SettingsCategory,
    integration: IntegrationSlug | null,
    changes: ChangeSet,
  ): Promise<void> {
    const actor = auditActorContext(principal);
    const scope = { category, integration };

    if (Object.keys(changes.after).length > 0) {
      // Setting values are nested under `values` so a key called `authMethod` could never be
      // confused with the actor context §12 requires at the top level of `after`.
      const auditId = await recordAuditEntry(outboxTx.tx, {
        actorType: 'user',
        actorId: principal.userId,
        action: 'setting.updated',
        entityType: 'settings',
        before: { ...scope, values: changes.before },
        after: { ...scope, values: changes.after, ...actor },
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
      });
      await outboxTx.emit(
        this.#outbox.event('audit.entry_recorded', {
          auditLogEntryId: auditId,
          action: 'setting.updated',
        }),
      );
    }

    for (const secret of changes.secrets) {
      // TDS 03 §3.13, verbatim: audit entries for secret writes record **that** the value
      // changed, `before`/`after` = `{ set: true | false }` — never the value, never a prefix,
      // never a length.
      const auditId = await recordAuditEntry(outboxTx.tx, {
        actorType: 'user',
        actorId: principal.userId,
        action: 'secret_item.updated',
        entityType: 'secret_items',
        entityId: secret.isSet ? secret.entityId : null,
        before: { set: secret.wasSet },
        after: { set: secret.isSet, ...scope, key: secret.key, ...actor },
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
      });
      await outboxTx.emit(
        this.#outbox.event('audit.entry_recorded', {
          auditLogEntryId: auditId,
          action: 'secret_item.updated',
        }),
      );
    }
  }
}

/**
 * One category's rows: values plus secret presence. Two bounded queries, never a join.
 *
 * Sequential rather than `Promise.all`, because this is also called with a transaction handle
 * — a Drizzle transaction is one `pg` client, and issuing overlapping statements on it is a
 * property of the driver's queue rather than something this code should rely on.
 */
export async function readStored(db: DbLike, category: SettingsCategory): Promise<StoredCategory> {
  const values = await readCategoryValues(db, category);
  const secrets = await readSecretPresence(db, category);
  return { values, secrets };
}
