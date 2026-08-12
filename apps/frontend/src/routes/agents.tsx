import { PhasePlaceholder } from '../components/PhasePlaceholder.js';

/** `/agents` — Phase 4 placeholder route (TDS 05 §10, TDS 06 §6.2). */
export function Component() {
  return (
    <PhasePlaceholder
      phase={4}
      title="Agents"
      description="Agents are personas running on runtimes, not models. This page will manage agent definitions, teams and assignments."
    />
  );
}
