import { Component, type ReactNode } from 'react';
import { reportClientError } from '../features/site/clientErrors';

const RELOAD_KEY = 'yoneda:reloaded-after-deploy';
/** A failure this soon after the last reload means the reload did not help; stop looping. */
const RELOAD_GUARD_MS = 60_000;

/**
 * A new deploy replaces hashed chunks; an open tab reloads instead of going blank. Each later
 * deploy may reload again, but never twice within the guard window.
 */
export function reloadAfterStaleChunk(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  reload: () => void,
  now = Date.now(),
) {
  const last = Number(storage.getItem(RELOAD_KEY));
  if (Number.isFinite(last) && last > 0 && now - last < RELOAD_GUARD_MS) return false;
  storage.setItem(RELOAD_KEY, String(now));
  reload();
  return true;
}

type State = { failed: boolean; reference: string | null };

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, reference: null };
  static getDerivedStateFromError(): State {
    return { failed: true, reference: null };
  }
  componentDidCatch(error: unknown) {
    void reportClientError(error).then((reference) => this.setState({ reference }));
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-crash" role="alert">
        <h1>Something went wrong</h1>
        <p>The page hit an unexpected error. Your work and runs are safe on the server.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
        {this.state.reference && (
          <small className="failure-reference">Reference {this.state.reference}</small>
        )}
      </main>
    );
  }
}
