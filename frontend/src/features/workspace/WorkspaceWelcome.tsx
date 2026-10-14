import {
  ArrowRight,
  Bot,
  Download,
  GitBranch,
  History,
  LoaderCircle,
  Network,
  Plus,
} from 'lucide-react';
import type { useRepository } from '../../hooks/useRepository';
import { AccountPanel } from './AccountPanel';
import { ReviewerAccess } from './ReviewerAccess';
import { SetupProgress } from './SetupProgress';

export function WorkspaceWelcome({
  reviewer = false,
  state,
  onProject,
  onProviders,
  onGuidedDemo,
}: {
  reviewer?: boolean;
  state: ReturnType<typeof useRepository>;
  onProject: () => void;
  onProviders: () => void;
  onGuidedDemo?: () => void;
}) {
  if (state.project && ['provisioning', 'failed'].includes(state.project.status))
    return (
      <SetupProgress
        reviewer={reviewer}
        key={state.id}
        project={state.project}
        error={state.error}
        onRetry={state.retrySetup}
        onRefresh={state.refresh}
      />
    );
  if (state.loading || state.id)
    return (
      <section className="workspace-loading" aria-live="polite">
        {state.error ? <GitBranch size={28} /> : <LoaderCircle size={28} className="spin" />}
        <h1>{state.error ? 'Could not open your workspace' : 'Opening your workspace'}</h1>
        <p>{state.error || 'Loading repositories and recorded context…'}</p>
        {state.error && (
          <button
            type="button"
            disabled={state.loading}
            onClick={() => void (state.id ? state.refresh() : state.discover())}
          >
            Retry connection
          </button>
        )}
      </section>
    );
  if (!state.authenticated)
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
          <ReviewerAccess
            onConnected={() => {
              void state.discover();
            }}
          />
          <AccountPanel
            onConnected={() => {
              void state.discover();
            }}
          />
        </div>
      </section>
    );
  if (reviewer)
    return (
      <section className="workspace-start">
        <h1>Your reviewer sandbox</h1>
        <p>Your funded sandbox will appear here when it is ready.</p>
      </section>
    );
  return (
    <section className="workspace-start">
      <div className="intent-symbol">
        <GitBranch size={28} />
      </div>
      <h1>
        A new project.
        <br />A shared starting point.
      </h1>
      <p>Create a repository, give your agents a brief, and explore what they build together.</p>
      <button type="button" onClick={onProject}>
        <Plus size={17} />
        Add repository
      </button>
      {onGuidedDemo && (
        <button type="button" className="quiet" onClick={onGuidedDemo}>
          Try guided demo
        </button>
      )}
      <div className="getting-started">
        <div>
          <GitBranch size={21} />
          <h2>Your source</h2>
          <p>Start from a website template or import a public repository.</p>
        </div>
        <button type="button" onClick={onProviders}>
          <Bot size={21} />
          <strong>Your agents</strong>
          <span>Connect a provider for hosted runs.</span>
          <ArrowRight size={16} />
        </button>
        <div>
          <Network size={21} />
          <h2>Your context</h2>
          <p>Keep intent, alternatives and evidence connected to the code.</p>
        </div>
      </div>
      <p className="welcome-note">
        Choose <strong>Connect Agents</strong> in the sidebar to set up hosted agents or connect
        your own agent.
      </p>
    </section>
  );
}
