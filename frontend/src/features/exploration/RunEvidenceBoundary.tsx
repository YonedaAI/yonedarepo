import { Component, type ReactNode } from 'react';

/**
 * An unavailable lazy asset or an unreadable record must not remove the workspace or the pending
 * decision. With `onClose`, the failure stays inside its dialog, which the owner can dismiss.
 */
export class RunEvidenceBoundary extends Component<
  { children: ReactNode; label: string; onClose?: () => void },
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
          {this.props.onClose && (
            <button type="button" className="quiet" onClick={this.props.onClose}>
              Close
            </button>
          )}
        </div>
      );
    return this.props.children;
  }
}
