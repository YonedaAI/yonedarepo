import { Component, type ReactNode } from 'react';

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

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
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
      </main>
    );
  }
}
