import {
  type AgentPermissionTemplate,
  type Db,
  normalizeSetting,
  schema,
  settingDefault,
  settingKey,
} from '@mc/shared';
import { and, eq } from 'drizzle-orm';

/**
 * The one `agents` setting that has a consumer (TDS 04 §7.2, PRD §4.4):
 *
 *   `agents.defaultPermissionTemplate` -> `('agents', 'default_permission_template')`, string
 *
 * Read by `POST /api/v1/agents` when the request names no permissions. Read as a single row on
 * that path rather than through the settings service, for the same reason `security.ts` does it:
 * the value is needed on a request path that has no business assembling a whole category
 * document. Its default and its repair rule come from the key registry (§7.6), so this reader and
 * the Settings page cannot disagree about what an empty database means.
 *
 * §7.2's other reserved key, `defaultRuntime`, has no reader here because it has no reader
 * anywhere — see `AGENT_KEYS` in the registry.
 */

export const AGENT_SETTING_KEYS = Object.freeze({
  defaultPermissionTemplate: settingKey('agents.defaultPermissionTemplate'),
} as const);

export const DEFAULT_AGENT_PERMISSION_TEMPLATE_SETTING = settingDefault<AgentPermissionTemplate>(
  'agents.defaultPermissionTemplate',
);

export async function readDefaultPermissionTemplate(db: Db): Promise<AgentPermissionTemplate> {
  const rows = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.category, 'agents'),
        eq(schema.settings.key, AGENT_SETTING_KEYS.defaultPermissionTemplate),
      ),
    )
    .limit(1);

  return normalizeSetting<AgentPermissionTemplate>(
    'agents.defaultPermissionTemplate',
    rows[0]?.value,
  );
}
