import type {
  AgentBindingRefusalReason,
  ProjectAvailableAgents,
  RefusedAgent,
} from '../api/types.generated.js';
import { type AgentView, readAgent } from './shape.js';

/**
 * `GET /projects/{id}/available-agents`, projected — **the server's answer to "which agents may a
 * Session in this Project be bound to", including its own account of the ones it left out.**
 *
 * ## Why this replaced a client-side rule engine
 *
 * This module used to be `binding.ts`'s `agentBindingRefusal` / `partitionAgentsForBinding`: a
 * transcription of `AgentBindingResolver.resolveForSession`'s refusals, maintained by hand on this
 * side of the wire. It was correct on the day it was written and nothing kept it correct. A fifth
 * refusal added server-side would have left the picker offering an agent `POST /sessions` then
 * rejects — the same root cause as `Session.agentId` never reaching the hand-written client type
 * and making the whole agent binding unreachable from the browser. Response schemas fixed
 * duplicated *shapes*; this fixes a duplicated *rule*.
 *
 * So bindability is now asked, never derived. The Backend answers it from the same availability
 * function the binding path enforces, and this file's entire job is to read that answer without
 * improving on it.
 *
 * ## The one thing this module is allowed to decide
 *
 * Whether the Backend actually answered. *Not offered* and *cannot tell whether it would be
 * offered* are different facts (the Memory screen's four-empty-states doctrine), and collapsing
 * them is how a picker ends up implying knowledge it does not have. Hence `refusalsStated`: a
 * document carrying `refused: []` says "nothing was refused", and a document carrying no refusal
 * array at all says nothing — the second must not be rendered as the first.
 *
 * ## The context this answer was computed in
 *
 * The Backend evaluates the rule with `sessionId: null` — the **create-time** question, "which
 * agent may a *new* Session in this Project be launched as". Two of the five reasons depend on
 * that (`session_not_yet`, `session_elsewhere`); the other three do not. A screen binding an agent
 * to a Session that already exists therefore holds an answer computed for a different moment, and
 * `AgentField` says so rather than reprinting `session_not_yet` at a Session that plainly exists.
 *
 * ## The seam, checked twice
 *
 * The field names below are **typed against the generated contract** (`types.generated.ts`, emitted
 * from the Backend's own response schemas by `pnpm api:spec`), in both directions: a renamed or
 * dropped key is a compile error, and a key the document grows that nothing here reads is a
 * compile error too. That is the guard that matters, because a client reading `refused` from a
 * Backend that now serves `refusedAgents` would degrade to a permanent, plausible "cannot tell".
 *
 * The runtime `unrecognised` list is the second half, for the case types cannot cover: a Backend
 * newer than the SPA build being served. It surfaces on the screen rather than in a log.
 */

/**
 * Keys this build reads off the availability document.
 *
 * `satisfies` binds every entry to the generated resource; `_NoDocumentFieldMissed` binds the
 * generated resource back to this list.
 */
const DOCUMENT_FIELDS = [
  'projectId',
  // The Session the refusals were computed against (`?sessionId=`), or `null` for the
  // create-time question. It is what separates `session_not_yet` from `session_elsewhere` —
  // so reading it is what lets this build tell "not yet" from "belongs to another session".
  'sessionId',
  'team',
  'agents',
  'refused',
] as const satisfies readonly (keyof ProjectAvailableAgents)[];

type _NoDocumentFieldMissed = [
  Exclude<keyof ProjectAvailableAgents, (typeof DOCUMENT_FIELDS)[number]>,
] extends [never]
  ? true
  : never;
const _documentFieldsAreExhaustive: _NoDocumentFieldMissed = true;
void _documentFieldsAreExhaustive;

/** The refusal fields this build renders. Bound to the resource the same way. */
const REFUSAL_FIELDS = {
  agentId: 'agentId',
  name: 'name',
  reason: 'reason',
  explanation: 'explanation',
} as const satisfies Record<string, keyof RefusedAgent>;

const KNOWN_DOCUMENT_FIELDS: ReadonlySet<string> = new Set(DOCUMENT_FIELDS);

/** An agent the server offers, and whether it is on the Project's team. */
export interface OfferedAgent {
  readonly agent: AgentView;
  /** PRD §5.7 emphasis. `false` is the normal case and costs nothing. */
  readonly onTeam: boolean;
}

/**
 * An agent the server named and declined to offer.
 *
 * `reason` is typed `string` rather than the generated `AgentBindingRefusalReason`, for the same
 * reason `AgentView.scope` is: a Backend that adds a sixth refusal before this build ships must
 * render its own code and its own sentence, not a blank line. The *known* half is checked at
 * compile time instead — see `REFUSAL_PENDING_SESSION` below.
 *
 * `explanation` is the server's sentence, rendered verbatim; `null` means the Backend served a
 * code and no prose, which the picker states rather than paraphrasing one of its own.
 */
export interface RefusedAgentView {
  readonly agentId: string;
  readonly name: string;
  readonly reason: string;
  readonly explanation: string | null;
}

/**
 * The one reason that means *not yet* rather than *not here*.
 *
 * A session-scoped agent is unbindable at create time because it names a Session that does not
 * exist, and bindable afterwards through `PATCH /sessions/{id}`. That distinction is the reason
 * the picker's explanations exist at all, so it is named once rather than left as a bare string
 * comparison in the view — and it is **typed as the generated union**, so a Backend that renames
 * or drops it is a compile error here rather than a screen that quietly stops special-casing the
 * one refusal with a way out.
 */
export const REFUSAL_PENDING_SESSION: AgentBindingRefusalReason = 'session_not_yet';

/** The Project's assigned team, for emphasis only. */
export interface AssignedTeamView {
  readonly name: string | null;
  /** Roster seats held by an archived agent — the difference between "5 members" and 4 offered. */
  readonly archivedMemberCount: number;
}

export interface ProjectAgentAvailability {
  readonly offered: readonly OfferedAgent[];
  readonly refused: readonly RefusedAgentView[];
  /**
   * Whether the Backend **stated** its refusals.
   *
   * `false` does not mean "nothing was refused" — it means the document carried no refusal array,
   * so the offered set is still the server's answer but the absences behind it are unaccounted
   * for. The picker says so instead of implying a complete list.
   */
  readonly refusalsStated: boolean;
  readonly team: AssignedTeamView | null;
  /** Rows on either list that carried no usable identity. Counted, never silently dropped. */
  readonly unreadable: number;
  /** Document keys this build neither reads nor understands — including a renamed refusal array. */
  readonly unrecognised: readonly string[];
}

export const NO_AVAILABILITY: ProjectAgentAvailability = {
  offered: [],
  refused: [],
  refusalsStated: false,
  team: null,
  unreadable: 0,
  unrecognised: [],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringAt(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Project the availability document.
 *
 * Defensive in the same way `readAgent` is, and for the same reason: this read is younger than
 * everything else the launch dialog calls, and `AppShell` has no error boundary of its own — the
 * nearest is on the `RequireAuth` parent — so a throw here would replace the whole authenticated
 * area rather than one field.
 */
export function readProjectAgentAvailability(document: unknown): ProjectAgentAvailability {
  const record = asRecord(document);
  if (record === null) return NO_AVAILABILITY;

  const offered: OfferedAgent[] = [];
  let unreadable = 0;
  const rows = record['agents'];
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const agent = readAgent(row);
      if (agent === null) {
        unreadable += 1;
        continue;
      }
      const entry = asRecord(row);
      offered.push({ agent, onTeam: entry?.['onTeam'] === true });
    }
  }

  const rawRefused = record['refused'];
  // Present-and-an-array is the only shape that counts as an answer. A Backend that omits the key
  // has not said "nothing was refused"; it has said nothing.
  const refusalsStated = Array.isArray(rawRefused);
  const refused: RefusedAgentView[] = [];
  if (Array.isArray(rawRefused)) {
    for (const row of rawRefused) {
      const entry = asRecord(row);
      if (entry === null) continue;
      const agentId = stringAt(entry, REFUSAL_FIELDS.agentId);
      const name = stringAt(entry, REFUSAL_FIELDS.name);
      const reason = stringAt(entry, REFUSAL_FIELDS.reason);
      // A refusal with no id, no name or no reason cannot be rendered as a *named* absence, which
      // is the only thing it is for. It joins the `unreadable` count rather than becoming a blank
      // bullet — the count is the difference between a list that is short and one that is quietly
      // short.
      if (agentId === null || name === null || reason === null) {
        unreadable += 1;
        continue;
      }
      refused.push({
        agentId,
        name,
        reason,
        explanation: stringAt(entry, REFUSAL_FIELDS.explanation),
      });
    }
  }

  const team = asRecord(record['team']);

  return {
    offered,
    refused,
    refusalsStated,
    team:
      team === null
        ? null
        : {
            name: stringAt(team, 'name'),
            archivedMemberCount:
              typeof team['archivedMemberCount'] === 'number' ? team['archivedMemberCount'] : 0,
          },
    unreadable,
    unrecognised: Object.keys(record).filter((key) => !KNOWN_DOCUMENT_FIELDS.has(key)),
  };
}
