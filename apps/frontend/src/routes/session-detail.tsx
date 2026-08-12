import { useParams } from 'react-router';
import { PagePlaceholder } from '../components/PagePlaceholder.js';
import { SessionDetailPage } from '../features/sessions/SessionDetailPage.js';

/**
 * `/sessions/:sessionId` — the Live Session view (TDS 05 §6, TDS 06 §5.5).
 *
 * A thin lazy entry module: this file is the code-split point (§2.3), and everything the
 * screen actually does lives in `features/sessions`. Keying the page on `sessionId` is
 * deliberate — switching Sessions is a route change, and a fresh component tree per Session
 * keeps per-Session view state (scroll position, panel activation, find state) from leaking
 * across the switch. The live buffers survive regardless, because they live in the store.
 */
export function Component() {
  const { sessionId = '' } = useParams();

  if (sessionId === '') {
    return (
      <PagePlaceholder title="Session" summary="No session id in the URL." owner="TDS 06 §5.5" />
    );
  }

  return <SessionDetailPage key={sessionId} sessionId={sessionId} />;
}
