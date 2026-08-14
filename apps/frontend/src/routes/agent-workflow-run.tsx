import { WorkflowRunPage } from '../features/agents/workflows/WorkflowRunPage.js';

/**
 * `/agents/runs/:runId` — one workflow run.
 *
 * Not `/agents/workflows/:workflowId/runs/:runId`: a run outlives its position in the definition's
 * page, it is linked to from toasts and from the Sessions area, and a URL that carries an id the
 * screen does not need is a URL that breaks when the workflow is archived.
 */
export function Component() {
  return <WorkflowRunPage />;
}
