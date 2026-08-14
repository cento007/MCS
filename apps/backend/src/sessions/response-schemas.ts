import { MESSAGE_ROLES, SESSION_STATES } from '@mc/shared';
import {
  type Assert,
  arrayOf,
  booleanValue,
  describe,
  type ExactShape,
  entityId,
  enumSchema,
  integerValue,
  nullable,
  nullableEntityId,
  nullableInteger,
  nullableNumber,
  nullableString,
  nullableTimestamp,
  objectSchema,
  type ResponseSchema,
  stringEnum,
  stringValue,
  timestampValue,
} from '../http/response-schema.js';
import type { SessionFilesReadModel, SessionFileTouch } from './files.js';
import type {
  MessageResource,
  SessionObservation,
  SessionResource,
  TimelineEntryResource,
} from './serialize.js';
import type { InterruptResult } from './service.js';

/**
 * The response shapes of `/api/v1/sessions/*` (TDS 04 §6), declared against the serializers in
 * `serialize.ts` and `files.ts`.
 *
 * **Every schema here is bound to its serializer's own TypeScript type** by an `ExactShape`
 * assertion, which is not decoration: `Session.agentId` was added to `SessionResource` in Phase 4
 * slice 1 and never reached the hand-written client type, so the whole agent runtime binding was
 * unreachable from the browser until slice 2 noticed. With the client types generated from these
 * schemas, the one remaining way to lose a field is to add it to the serializer and forget it
 * here — and that is now a compile error rather than a silent omission.
 *
 * These schemas never strip anything (`http/response-schema.ts` explains why and how), so a
 * mistake here costs documentation accuracy, not data.
 */

export const sessionObservationSchema = objectSchema('SessionObservation', {
  channel: stringEnum(['hooks_and_transcript', 'hooks_only', 'transcript_only']),
  degraded: booleanValue,
  reason: nullableString,
  driftCount: integerValue,
  updatedAt: timestampValue,
});
export type _SessionObservationShape = Assert<
  ExactShape<SessionObservation, typeof sessionObservationSchema>
>;

export const sessionRuntimeSchema = objectSchema('SessionRuntimeInfo', {
  kind: stringValue,
  /** Claude Code's own UUIDv4, not one of ours (F1.5). */
  runtimeSessionId: nullableString,
  claudeVersion: nullableString,
  model: nullableString,
  machine: nullableString,
  environment: nullableString,
});
export type _SessionRuntimeShape = Assert<
  ExactShape<SessionResource['runtime'], typeof sessionRuntimeSchema>
>;

const sessionTokenUsageSchema = objectSchema('SessionTokenUsage', {
  input: integerValue,
  output: integerValue,
  cacheRead: integerValue,
  cacheWrite: integerValue,
});
export type _SessionTokenUsageShape = Assert<
  ExactShape<SessionResource['tokenUsage'], typeof sessionTokenUsageSchema>
>;

/** F7's canonical state list, read from `@mc/shared` so the document cannot invent a sixth. */
export const sessionStateSchema = enumSchema('SessionState', SESSION_STATES);
export const sessionTypeSchema = enumSchema('SessionType', ['managed', 'observed']);

export const sessionSchema = objectSchema('Session', {
  id: entityId,
  projectId: entityId,
  repositoryId: nullableEntityId,
  sessionType: sessionTypeSchema,
  state: sessionStateSchema,
  title: describe(
    stringValue,
    "Always a string; '' is the unset value, not a title of zero length. Display falls back to a derived label.",
  ),
  failureReason: describe(
    nullableString,
    'Why a `failed` Session failed - spawn_error, process_crash, backend_restart. `null` in every other state, and legitimately `null` in `failed` too when the transition carried no reason. It is the whole triage signal.',
  ),
  notes: nullableString,
  branch: nullableString,
  workingDirectory: stringValue,
  agentId: describe(
    nullableEntityId,
    'The Agent persona this Session runs as (PRD 5.1), or null. The id ONLY - the Agent resource is served by GET /agents/{id}, because inlining a persona would put a 20 000-character system prompt on the session list.',
  ),
  runtime: sessionRuntimeSchema,
  observation: nullable(sessionObservationSchema),
  costUsd: nullableNumber,
  tokenUsage: nullable(sessionTokenUsageSchema),
  durationSeconds: nullableInteger,
  resumedFromSessionId: nullableEntityId,
  clonedFromSessionId: nullableEntityId,
  createdAt: timestampValue,
  startedAt: nullableTimestamp,
  completedAt: nullableTimestamp,
  archivedAt: nullableTimestamp,
  updatedAt: timestampValue,
});
export type _SessionShape = Assert<ExactShape<SessionResource, typeof sessionSchema>>;

/**
 * Blocks are opaque past `type` (§6.2): a Claude Code upgrade may add a block kind, and a closed
 * schema would turn that into a stripped transcript. `additionalProperties: true` is the contract,
 * not a gap — clients render an unknown kind with a neutral fallback.
 */
export const messageContentBlockSchema: ResponseSchema = {
  title: 'MessageContentBlock',
  type: 'object',
  additionalProperties: true,
  required: ['type'],
  properties: { type: stringValue },
};

export const messageSchema = objectSchema('Message', {
  id: entityId,
  sessionId: entityId,
  /** Per-session ordering key; the messages cursor is keyed on this, never on `id` (§6.6). */
  ordinal: integerValue,
  role: enumSchema('MessageRole', MESSAGE_ROLES),
  status: stringEnum(['complete', 'pending', 'interrupted']),
  content: arrayOf(messageContentBlockSchema),
  model: nullableString,
  tokenUsage: nullable(
    objectSchema('MessageTokenUsage', { input: integerValue, output: integerValue }),
  ),
  runtimeUuid: nullableString,
  occurredAt: timestampValue,
  createdAt: timestampValue,
});
export type _MessageShape = Assert<ExactShape<MessageResource, typeof messageSchema>>;

export const timelineEntrySchema = objectSchema(
  'TimelineEntry',
  {
    id: entityId,
    occurredAt: timestampValue,
    /** The F6 event name, verbatim. `kind` is derived from it (§6.7). */
    type: stringValue,
    kind: enumSchema('TimelineKind', [
      'state_changed',
      'commit_linked',
      'prompt_submitted',
      'tool_used',
      'observation_changed',
      'other',
    ]),
    trigger: stringEnum(['user', 'system']),
    fromState: sessionStateSchema,
    toState: sessionStateSchema,
    refType: stringEnum(['commit', 'message']),
    refId: entityId,
    detail: stringValue,
  },
  // §6.7's serializer omits these keys rather than sending `null`, so they are optional here
  // and optional in the generated client type — which is what stops a consumer treating a
  // missing `fromState` as a state that exists.
  { optional: ['fromState', 'toState', 'refType', 'refId', 'detail'] },
);
export type _TimelineEntryShape = Assert<
  ExactShape<TimelineEntryResource, typeof timelineEntrySchema>
>;

export const sessionFileTouchSchema = objectSchema('SessionFileTouch', {
  /** Root-relative with `/` separators — or the absolute native path when `outsideRoot`. */
  path: stringValue,
  outsideRoot: booleanValue,
  touchCount: integerValue,
  toolTouchCount: integerValue,
  commitCount: integerValue,
  sources: arrayOf(stringEnum(['tool', 'commit'])),
  /**
   * git's own status letter mapped to a word, or `null`.
   *
   * Typed as an open string rather than the four-value union a client might expect, because
   * `files.ts` copies it straight out of `commits.files` — a JSONB column whose elements no CHECK
   * constrains. Narrowing it here would publish a promise the data does not keep.
   */
  status: nullableString,
  additions: nullableInteger,
  deletions: nullableInteger,
  lastTouchedAt: timestampValue,
});
export type _SessionFileTouchShape = Assert<
  ExactShape<SessionFileTouch, typeof sessionFileTouchSchema>
>;

export const sessionFilesSchema = objectSchema('SessionFiles', {
  root: stringValue,
  files: arrayOf(sessionFileTouchSchema),
  totalFiles: integerValue,
  truncated: booleanValue,
  commitsAsOf: nullableTimestamp,
  completeness: describe(
    stringEnum(['complete', 'partial']),
    'Contractual: a Files tab that merely looks short is indistinguishable from a Session that genuinely touched few files, so `partial` must be rendered and never quietly absorbed.',
  ),
  completenessReason: nullable(stringEnum(['observation_degraded', 'hooks_not_installed'])),
});
export type _SessionFilesShape = Assert<
  ExactShape<SessionFilesReadModel, typeof sessionFilesSchema>
>;

export const interruptResultSchema = objectSchema('InterruptResult', {
  sessionId: entityId,
  /** The retained partial Message; `null` when the turn produced no persisted content. */
  messageId: nullableEntityId,
});
export type _InterruptResultShape = Assert<
  ExactShape<InterruptResult, typeof interruptResultSchema>
>;

/**
 * `meta.launch` on `start` and in-place `resume` (§6.2.1).
 *
 * Saturation is never an error: `queued` means the Session stayed in its pre-launch state and a
 * durable `session.launch` job will move it.
 */
export const launchMetaSchema = objectSchema('LaunchMeta', {
  launch: describe(
    stringEnum(['started', 'queued']),
    "`queued` means the Session stayed in its pre-launch state and a durable session.launch job will move it. Render it as 'Queued for launch', never as a failure.",
  ),
});
