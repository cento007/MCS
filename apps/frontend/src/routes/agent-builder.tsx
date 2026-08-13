import { AgentBuilderPage } from '../features/agents/AgentBuilderPage.js';

/**
 * `/agents/new` and `/agents/:agentId` — the Agent Builder (PRD §5.8).
 *
 * One module behind both paths. `new` is registered as its own route rather than being sniffed
 * out of `:agentId`, so `useParams().agentId` is `undefined` in create mode and the two modes are
 * distinguished by the router rather than by a magic string that a real UUIDv7 could one day
 * collide with.
 */
export function Component() {
  return <AgentBuilderPage />;
}
