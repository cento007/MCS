/**
 * `lib/agents` — the Agent domain vocabulary, projection and binding rules.
 *
 *   vocabulary.ts   scope/runtime names and labels, re-exported from `@mc/shared/types`
 *   permissions.ts  the read half of PRD §5.5: three switches, and the evidence for them
 *   shape.ts        the defensive `Agent` -> `AgentView` projection every screen renders
 *   binding.ts      which agents a Session may be bound to, and why the others may not
 *
 * It lives in `lib/` because **two feature slices need it** — `features/agents/` builds agents and
 * `features/sessions/` runs them — and TDS 05 §2.1 forbids one feature slice from importing
 * another. The form/draft half of the model (draft keys, patch bodies, validation) is not here:
 * only the Agent Builder needs it, so it stays in `features/agents/`.
 */
export * from './binding.js';
export * from './permissions.js';
export * from './shape.js';
export * from './vocabulary.js';
