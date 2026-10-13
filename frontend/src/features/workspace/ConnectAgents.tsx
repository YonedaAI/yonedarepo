import { Bot, Terminal } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { AgentConnections } from './AgentConnections';

const ProviderSettings = lazy(() =>
  import('./ProviderSettings').then((module) => ({ default: module.ProviderSettings })),
);

export function ConnectAgents({
  repo,
  onProject,
  onClose,
}: {
  repo?: string;
  onProject?: () => void;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState<'hosted' | 'external' | null>(null);
  return (
    <section className="connect-agents">
      {choice ? (
        <button type="button" className="quiet" onClick={() => setChoice(null)}>
          Back to connection options
        </button>
      ) : (
        <>
          <p>Choose how your agents work with YonedaRepo.</p>
          <div className="agent-connection-options">
            <button type="button" className="quiet" onClick={() => setChoice('hosted')}>
              <Bot size={24} aria-hidden="true" />
              <strong>Hosted agents</strong>
              <span>Connect a model provider. YonedaRepo runs and coordinates agents for you.</span>
            </button>
            <button type="button" className="quiet" onClick={() => setChoice('external')}>
              <Terminal size={24} aria-hidden="true" />
              <strong>Your own agent</strong>
              <span>Connect Claude Code, Codex or another MCP client, wherever it runs.</span>
            </button>
          </div>
        </>
      )}
      {choice === 'hosted' && (
        <Suspense fallback={<p role="status">Loading connections…</p>}>
          <ProviderSettings onClose={onClose} />
        </Suspense>
      )}
      {choice === 'external' &&
        (repo ? (
          <AgentConnections repo={repo} onClose={onClose} />
        ) : (
          <div>
            <h3>Choose a repository first</h3>
            <p>
              Agent access is scoped to a repository. Add one, then return here to create a
              connection key.
            </p>
            {onProject && (
              <button type="button" onClick={onProject}>
                Add repository
              </button>
            )}
          </div>
        ))}
    </section>
  );
}
