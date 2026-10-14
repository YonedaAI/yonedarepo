import { Component, type ReactNode } from 'react';

const RELOAD_KEY = 'yoneda:reloaded-after-deploy';

/** A new deploy replaces hashed chunks; an open tab reloads once instead of going blank. */
export function reloadAfterStaleChunk(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  reload: () => void,
) {
  if (storage.getItem(RELOAD_KEY)) return false;
  storage.setItem(RELOAD_KEY, String(Date.now()));
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
