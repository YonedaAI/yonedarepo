// Home before any repository: the product and sign-in when signed out, loading or a failed
// read, and the first "New repository" when the account has none.
import {
  ArrowRight,
  Download,
  GitBranch,
  History,
  LoaderCircle,
  Network,
  Plus,
} from 'lucide-react';
import { AccountPanel } from './AccountPanel';

export function WorkspaceWelcome({
  authenticated,
  loading,
  error,
  onRetry,
  onSignedIn,
  onNew,
}: {
  authenticated: boolean;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onSignedIn: () => void;
  onNew: () => void;
}) {
  if (loading || error)
    return (
      <section className="workspace-loading" aria-live="polite">
        {error ? <GitBranch size={28} /> : <LoaderCircle size={28} className="spin" />}
        <h1>{error ? 'Could not open your workspace' : 'Opening your workspace'}</h1>
        <p>{error || 'Loading repositories…'}</p>
        {error && (
          <button type="button" disabled={loading} onClick={onRetry}>
            Retry connection
          </button>
        )}
      </section>
    );
  if (!authenticated)
    return (
      <section className="welcome-onboarding">
        <div className="welcome-story">
          <div className="intent-symbol" aria-hidden="true">
            <GitBranch size={32} strokeWidth={1.6} />
          </div>
          <h1>
            Agent-First
            <br />
            Repository.
          </h1>
          <p>
            An API-first, Git-like transactional model where agents fetch only what they need,
            coordinate changes, and preserve context.
          </p>
          <div className="welcome-flow" aria-hidden="true">
            <span>
              <Download size={16} />
              Fetch
            </span>
            <ArrowRight size={16} />
            <span>
              <Network size={16} />
              Coordinate
            </span>
            <ArrowRight size={16} />
            <span>
              <History size={16} />
              Preserve
            </span>
          </div>
          <p className="welcome-note">Bring your agent. Give the next one a head start.</p>
        </div>
        <div className="welcome-access">
          <AccountPanel onConnected={onSignedIn} />
        </div>
      </section>
    );
  return (
    <section className="workspace-start">
      <div className="intent-symbol">
        <GitBranch size={28} />
      </div>
      <h1>Your first repository.</h1>
      <p>
        Create one here, then clone and push with Git, or connect an agent through the CLI or MCP.
        Commits are checked, reviewed and landed on the server.
      </p>
      <div className="workspace-start-actions">
        <button type="button" onClick={onNew}>
          <Plus size={17} />
          New repository
        </button>
      </div>
    </section>
  );
}
