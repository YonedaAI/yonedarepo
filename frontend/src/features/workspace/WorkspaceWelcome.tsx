import {
  ArrowRight,
  Bot,
  GitBranch,
  GitCompareArrows,
  LoaderCircle,
  Network,
  Plus,
} from 'lucide-react';
import type { useRepository } from '../../hooks/useRepository';
import { api } from '../../lib/api';
import { AccountPanel } from './AccountPanel';

export function WorkspaceWelcome({
  state,
  onProject,
  onProviders,
}: {
  state: ReturnType<typeof useRepository>;
  onProject: () => void;
  onProviders: () => void;
}) {
  if (state.loading || state.id)
    return (
      <section className="workspace-loading" aria-live="polite">
        {state.project?.status === 'failed' ? (
          <GitBranch size={28} />
        ) : (
          <LoaderCircle size={28} className="spin" />
        )}
        <h1>
          {state.project?.status === 'failed'
            ? 'Repository setup needs attention'
            : 'Opening your workspace'}
        </h1>
        <p>
          {state.project?.error ??
            (state.project?.status === 'provisioning'
              ? 'Preparing your repository. This page updates automatically.'
              : 'Loading repositories and recorded context…')}
        </p>
        {state.project?.status === 'failed' && (
          <button
            type="button"
            onClick={async () => {
              try {
                await api(`projects/${state.id}/retry`, {});
                await state.discover();
              } catch (error) {
                state.setError((error as Error).message);
              }
            }}
          >
            Retry setup
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
            Build together.
            <br />
            Keep the why.
          </h1>
          <p>
            One intent. Multiple approaches. A shared memory of what worked, what didn't, and why
            you chose it.
          </p>
          <div className="welcome-flow" aria-hidden="true">
            <span>
              <GitBranch size={16} />
              Intent
            </span>
            <ArrowRight size={16} />
            <span>
              <GitCompareArrows size={16} />
              Approaches
            </span>
            <ArrowRight size={16} />
            <span>
              <Network size={16} />
              Context
            </span>
          </div>
          <p className="welcome-note">Bring your agent. Give the next one a head start.</p>
        </div>
        <AccountPanel
          onConnected={() => {
            void state.discover();
          }}
        />
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
        Prefer your local agent? Add a repository, then choose <strong>Connect local agent</strong>.
      </p>
    </section>
  );
}
