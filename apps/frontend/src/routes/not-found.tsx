import { Link } from 'react-router';
import { EmptyState } from '../components/EmptyState.js';

/** `*` — not found. Deep links must reach this, not the Backend's 404 (F2.3 SPA fallback). */
export function Component() {
  return (
    <EmptyState
      title="That page does not exist."
      hint="Check the address, or head back to the dashboard."
      action={
        <Link
          to="/"
          className="mt-2 rounded-sm border border-border-control px-3 py-1 text-sm text-text"
        >
          Go to Dashboard
        </Link>
      }
    />
  );
}
