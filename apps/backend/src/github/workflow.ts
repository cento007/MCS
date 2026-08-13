import type { WorkflowMode } from '@mc/shared';

/**
 * Workflow Modes (PRD §4.3, TDS 04 §5.3, arbitration A10).
 *
 * > **Phase 2 — interface only.** This module is a placeholder/extension point for assisted
 * > actions. Detailed design is out of TDS scope per the project-plan scope guard.
 *
 * **Sanctioned deviation D8: assisted-mode PR *actions* are deferred to Phase 2.** Only the
 * Manual/Assisted *mode setting* is Phase 1 — globally as `integrations.github.workflowMode`
 * (§7.2) and per Project as `projects.workflow_mode` (`null` = inherit). PR creation, PR
 * description generation and review summaries depend on Phase 2 knowledge generation and do not
 * exist in this build. TDS 04 §5.3 states the consequence directly: "there are therefore **no
 * write endpoints on `pull-requests`** in this contract; `pull-requests` is read-only in
 * Phase 1."
 *
 * ## How Phase 1 "respects the setting"
 *
 * `manual` means read-only tracking, and in this build **so does `assisted`** — the two behave
 * identically, by design, and the mode is surfaced in the discover/sync responses so an
 * operator who has selected Assisted can see that Mission Control read the choice and that
 * nothing acts on it yet.
 *
 * That is not merely unimplemented, it is unrepresentable: `GithubHttpPort` (`http.ts`) has no
 * method field and its only implementation issues `GET`. There is no code path in this
 * integration that can `POST` to GitHub, so no bug, no setting and no operator action can make
 * Mission Control write to a repository in Phase 1. When assisted actions land, the port gains
 * a method and this file gains the gate — deliberately in that order.
 */

export type { WorkflowMode };

/** The phase in which assisted actions become real (deviation D8). */
export const ASSISTED_ACTIONS_PHASE = 2;

/**
 * The mode that applies to a Project (arbitration A10): the Project's own override when it has
 * one, otherwise the global setting. `null` on the Project means **inherit**, which is a third
 * value distinct from an explicit `manual` — a Project pinned to Manual must not silently
 * become Assisted when the global default changes.
 */
export function effectiveWorkflowMode(
  projectMode: WorkflowMode | null | undefined,
  globalMode: WorkflowMode,
): WorkflowMode {
  return projectMode ?? globalMode;
}

/**
 * What this build actually does with the effective mode. Both answers are `read_only` in
 * Phase 1; the function exists so the Phase 2 change is one branch in one place rather than a
 * search for every site that assumed read-only.
 */
export function githubCapability(mode: WorkflowMode): 'read_only' {
  // Referencing the parameter keeps the D8 contract visible at the type level: the day this
  // returns something else for `assisted`, every caller is recompiled against the new union.
  void mode;
  return 'read_only';
}
