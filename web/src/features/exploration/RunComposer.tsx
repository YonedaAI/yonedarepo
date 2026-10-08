import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Repository, Snapshot } from '../../lib/types';
import type { Provider } from '../workspace/ProviderSettings';
export function RunComposer({
  busy,
  snapshot,
  onStart,
  onClose,
}: {
  busy: boolean;
  snapshot: Snapshot;
  onStart: (body: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [intent, setIntent] = useState('Build a responsive website for ');
  const [criteria, setCriteria] = useState(
    'Works on mobile and desktop\nKeyboard accessible navigation\nClear content and useful interactions',
  );
  const [providers, setProviders] = useState<Provider[]>([]);
  const [agents, setAgents] = useState([
    {
      id: crypto.randomUUID(),
      provider: '',
      strategy: 'Small, focused implementation with clear content',
    },
    {
      id: crypto.randomUUID(),
      provider: '',
      strategy: 'Explore a different design with accessible interactions',
    },
  ]);
  const [context, setContext] = useState<string[]>([]);
  const [policy, setPolicy] = useState(JSON.stringify(snapshot.repository.policy?.build, null, 2));
  const [error, setError] = useState('');
  const [approving, setApproving] = useState(false);
  useEffect(() => {
    void api<{ providers: Provider[] }>('settings')
      .then((r) => {
        setProviders(r.providers);
        setAgents((a) =>
          a.map((v, i) => ({
            ...v,
            provider: r.providers[i % r.providers.length]?.provider ?? '',
          })),
        );
      })
      .catch((e) => setError(e.message));
  }, []);
  async function start() {
    setApproving(true);
    setError('');
    try {
      let current: Repository = snapshot.repository;
      const build = JSON.parse(policy);
      if (JSON.stringify(build) !== JSON.stringify(current.policy?.build)) {
        const next = {
          ...current.policy,
          version: `policy-${crypto.randomUUID()}`,
          suite: 'commands-v1',
          environment: 'linux-node24-rust1.94-v1',
          build,
          required_checks: build.checks.map((c: { name: string }) => c.name),
        };
        current = await api<Repository>(`repos/${current.id}/update_policy`, {
          policy: next,
          expected_commit: current.head_commit,
          expected_version: current.version,
          expected_policy: current.policy?.version,
        });
      }
      await onStart({
        intent: intent.trim(),
        criteria: criteria
          .split('\n')
          .map((c) => c.trim())
          .filter(Boolean),
        context,
        agents: agents.map((a) => ({
          ...a,
          model: providers.find((p) => p.provider === a.provider)?.model,
        })),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApproving(false);
    }
  }
  const locked = busy || approving;
  return (
    <form
      className="run-composer"
      aria-label="Approve run brief"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <h2>Approve a shared brief</h2>
      <p>
        Both agents start concurrently from the same source revision, brief, and selected context.
        Each works in an isolated workspace. Approval starts paid inference using your provider
        keys.
      </p>
      <label>
        What should they build?
        <textarea
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          required
          maxLength={16000}
          disabled={locked}
        />
      </label>
      <label>
        Acceptance criteria (one per line)
        <textarea
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
          required
          disabled={locked}
        />
      </label>
      <h3>Independent approaches</h3>
      {agents.map((a, i) => (
        <div className="agent-inputs" key={a.id}>
          <label>
            Agent {i + 1} provider
            <select
              required
              disabled={locked}
              value={a.provider}
              onChange={(e) =>
                setAgents((all) =>
                  all.map((v, n) => (n === i ? { ...v, provider: e.target.value } : v)),
                )
              }
            >
              <option value="">Connect a provider first</option>
              {providers.map((p) => (
                <option key={p.provider} value={p.provider}>
                  {p.provider}: {p.model}
                </option>
              ))}
            </select>
          </label>
          <label>
            Approach
            <input
              value={a.strategy}
              onChange={(e) =>
                setAgents((all) =>
                  all.map((v, n) => (n === i ? { ...v, strategy: e.target.value } : v)),
                )
              }
              required
              maxLength={256}
              disabled={locked}
            />
          </label>
        </div>
      ))}
      <details>
        <summary>Reuse existing context ({context.length} selected)</summary>
        {snapshot.nodes
          .filter((n) =>
            [
              'intent',
              'requirement',
              'constraint',
              'assumption',
              'finding',
              'alternative',
              'proposed_decision',
              'question',
              'decision',
            ].includes(n.kind),
          )
          .map((n) => (
            <label key={n.id}>
              <span>
                <input
                  type="checkbox"
                  checked={context.includes(n.id)}
                  onChange={(e) =>
                    setContext((all) =>
                      e.target.checked ? [...all, n.id] : all.filter((id) => id !== n.id),
                    )
                  }
                />{' '}
                {n.kind}: {n.label}
              </span>
            </label>
          ))}
      </details>
      <details>
        <summary>Build and independent check commands</summary>
        <p>
          The default website check only confirms an HTML entrypoint, title and viewport. Add
          meaningful tests for your project. Commands run in a clean Node 24 / Rust 1.94 / Python
          standard library environment. Static output is served from static_dir.
        </p>
        <label>
          Approved build profile (JSON)
          <textarea
            className="profile-input"
            value={policy}
            onChange={(e) => setPolicy(e.target.value)}
            required
            disabled={locked}
          />
        </label>
      </details>
      {error && <p role="alert">{error}</p>}
      <div className="run-actions">
        <button type="submit" disabled={locked || !providers.length}>
          {locked ? 'Starting…' : 'Approve brief and start agents'}
        </button>
        <button type="button" className="quiet" disabled={locked} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
