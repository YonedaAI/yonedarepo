import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Repository, Snapshot } from '../../lib/types';
import type { Provider } from '../workspace/ProviderSettings';
import { AgentRoster } from './AgentRoster';
import { type AgentDraft, type DelegationDraft, runAgentLimits } from './agentLimits';
import { approachPresets } from './approaches';
import { DelegationSettings } from './DelegationSettings';
import { ModelBudgetSettings } from './ModelBudgetSettings';
import { type ModelBudgetDraft, selectedModels, serializeModelBudgets } from './modelBudgets';
import { RunAdvancedOptions } from './RunAdvancedOptions';
import { agentConnectionIssue, type InitialRun } from './restartRun';
export function RunComposer({
  busy,
  snapshot,
  onStart,
  onClose,
  onProviders,
  initialRun,
}: {
  busy: boolean;
  snapshot: Snapshot;
  onStart: (body: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
  onProviders: () => void;
  initialRun?: InitialRun;
}) {
  const [source] = useState(initialRun);
  const [intent, setIntent] = useState(source?.intent ?? '');
  const [criteria, setCriteria] = useState(
    source?.criteria.join('\n') ??
      'Works on mobile and desktop\nKeyboard accessible navigation\nClear content and useful interactions',
  );
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState('');
  const [providersRequest, setProvidersRequest] = useState(0);
  const limits = runAgentLimits(snapshot);
  const budgetSupport = snapshot.capabilities?.model_budgets === 1;
  const [budgets, setBudgets] = useState<Record<string, ModelBudgetDraft>>(source?.budgets ?? {});
  const [agents, setAgents] = useState<AgentDraft[]>(
    source?.agents ?? [
      {
        id: crypto.randomUUID(),
        connection: '',
        strategy: approachPresets[0].instructions,
      },
      {
        id: crypto.randomUUID(),
        connection: '',
        strategy: approachPresets[1].instructions,
      },
    ],
  );
  const [context, setContext] = useState<string[]>(source?.context ?? []);
  const [policy, setPolicy] = useState(
    source?.policy ?? JSON.stringify(snapshot.repository.policy?.build, null, 2),
  );
  const [error, setError] = useState('');
  const [approving, setApproving] = useState(false);
  const [delegation, setDelegation] = useState<DelegationDraft>(
    source?.delegation ?? {
      enabled: false,
      max_depth: 1,
      max_executions: 2,
    },
  );
  const models = selectedModels(agents, providers);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry starts a fresh cancellable request.
  useEffect(() => {
    let current = true;
    setProvidersLoading(true);
    setProvidersError('');
    void api<{ providers: Provider[] }>('settings')
      .then((r) => {
        if (!current) return;
        setProviders(r.providers);
        setAgents((a) =>
          a.map((v, i) => ({
            ...v,
            connection:
              source || r.providers.some((p) => p.id === v.connection)
                ? v.connection
                : (r.providers[i % r.providers.length]?.id ?? ''),
          })),
        );
      })
      .catch((e) => {
        if (current) setProvidersError(e.message);
      })
      .finally(() => {
        if (current) setProvidersLoading(false);
      });
    return () => {
      current = false;
    };
  }, [providersRequest]);
  async function start() {
    setApproving(true);
    setError('');
    try {
      if (agents.length < limits.min_root_agents || agents.length > limits.max_root_agents) {
        throw new Error('The number of agents exceeds this deployment’s current limits.');
      }
      if (agents.some((agent) => !providers.some((p) => p.id === agent.connection))) {
        throw new Error('Choose a configured provider connection for every agent.');
      }
      if (agents.some((agent) => agentConnectionIssue(agent, providers))) {
        throw new Error('Review changed provider connections before approving this restart.');
      }
      const modelBudgets = budgetSupport ? serializeModelBudgets(models, budgets) : undefined;
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
        ...(source ? { restart_of: source.id } : {}),
        agents: agents.map((a) => ({
          id: a.id,
          connection: a.connection,
          strategy: a.strategy,
          provider: providers.find((p) => p.id === a.connection)?.provider,
          model: providers.find((p) => p.id === a.connection)?.model,
        })),
        ...(modelBudgets ? { model_budgets: modelBudgets } : {}),
        ...(limits.max_delegation_depth > 0
          ? {
              delegation: {
                enabled: delegation.enabled,
                max_depth: delegation.enabled ? delegation.max_depth : 0,
                max_executions: delegation.enabled
                  ? Math.max(agents.length, delegation.max_executions)
                  : agents.length,
              },
            }
          : {}),
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
      <h3>One brief. Independent approaches.</h3>
      {source && (
        <p className="restart-notice">
          Restarting creates a new run from the current published source. The previous run and its
          failure evidence remain in history. Current repository checks apply. Review connections
          and limits before approving.
        </p>
      )}
      <p>
        Your agents share the same source revision, brief, and selected context. Each works in an
        isolated workspace, with parallel execution as capacity becomes available. Approval starts
        paid inference using your provider keys.
      </p>
      <label>
        What should they build?
        <textarea
          placeholder="Build a website for a neighborhood garden, with events and a clear way to get involved…"
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
      <AgentRoster
        agents={agents}
        providers={providers}
        loading={providersLoading}
        error={providersError}
        limits={limits}
        locked={locked}
        onChange={setAgents}
        onProviders={onProviders}
        onRetry={() => setProvidersRequest((request) => request + 1)}
      />
      <DelegationSettings
        value={delegation}
        roots={agents.length}
        limits={limits}
        locked={locked}
        onChange={setDelegation}
      />
      <ModelBudgetSettings
        supported={budgetSupport}
        models={models}
        drafts={budgets}
        locked={locked}
        onChange={(key, value) => setBudgets((all) => ({ ...all, [key]: value }))}
      />
      <RunAdvancedOptions
        nodes={snapshot.nodes}
        context={context}
        policy={policy}
        locked={locked}
        onContextChange={setContext}
        onPolicyChange={setPolicy}
      />
      {error && <p role="alert">{error}</p>}
      <div className="run-actions">
        <button
          type="submit"
          disabled={locked || providersLoading || !!providersError || !providers.length}
        >
          {locked ? 'Starting…' : 'Approve brief and start agents'}
        </button>
        <button type="button" className="quiet" disabled={locked} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
