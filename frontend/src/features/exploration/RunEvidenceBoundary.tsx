import { Component, type ReactNode } from 'react';

/** An unavailable lazy asset must not remove the workspace or the pending decision. */
export class RunEvidenceBoundary extends Component<
  { children: ReactNode; label: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed)
      return (
        <div className="evidence-error" role="alert">
          <h3>Couldn’t load {this.props.label}</h3>
          <p>
            Reload the workspace to load the current app and try again. Recorded source and
            decisions are preserved.
          </p>
          <button type="button" className="quiet" onClick={() => window.location.reload()}>
            Reload workspace
          </button>
        </div>
      );
    return this.props.children;
  }
}
