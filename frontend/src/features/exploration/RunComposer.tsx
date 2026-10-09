import { useEffect, useState } from 'react';
import { api, short } from '../../lib/api';
import type { Repository, Snapshot } from '../../lib/types';
import type { Provider } from '../workspace/ProviderSettings';
import { AgentRoster } from './AgentRoster';
import { type AgentDraft, type DelegationDraft, runAgentLimits } from './agentLimits';
import { DelegationSettings } from './DelegationSettings';
import { ModelBudgetSettings } from './ModelBudgetSettings';
import { type ModelBudgetDraft, selectedModels, serializeModelBudgets } from './modelBudgets';
import { PublishedRunNotice } from './PublishedRunNotice';
import { RunAdvancedOptions } from './RunAdvancedOptions';
import { agentConnectionIssue, type InitialRun } from './restartRun';
import { hasPublishedWork } from './runDefaults';
import { defaultConnections, runDraft } from './runDraft';
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
  const [draft] = useState(() => runDraft(snapshot, initialRun));
  const [intent, setIntent] = useState(draft.intent);
  const [criteria, setCriteria] = useState(draft.criteria);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState('');
  const [providersRequest, setProvidersRequest] = useState(0);
  const limits = runAgentLimits(snapshot);
  const budgetSupport = snapshot.capabilities?.model_budgets === 1;
  const [budgets, setBudgets] = useState<Record<string, ModelBudgetDraft>>(draft.budgets);
  const [agents, setAgents] = useState<AgentDraft[]>(draft.agents);
  const [context, setContext] = useState<string[]>(draft.context);
  const [policy, setPolicy] = useState(draft.policy);
  const [error, setError] = useState('');
  const [approving, setApproving] = useState(false);
  const [delegation, setDelegation] = useState<DelegationDraft>(draft.delegation);
  const models = selectedModels(agents, providers);
  const updating = !draft.restartOf && hasPublishedWork(snapshot);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry starts a fresh cancellable request.
  useEffect(() => {
    let current = true;
    setProvidersLoading(true);
    setProvidersError('');
    void api<{ providers: Provider[] }>('settings')
      .then((r) => {
        if (!current) return;
        setProviders(r.providers);
        setAgents((agents) => defaultConnections(agents, r.providers));
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
        throw new Error('Review changed provider connections before approving this run.');
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
        ...(draft.restartOf ? { restart_of: draft.restartOf } : {}),
        ...(draft.publication ? { continuation_of: draft.publication.decision.id } : {}),
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
      <h3>{updating ? 'What’s next for your project?' : 'Describe the change'}</h3>
      {updating && (
        <PublishedRunNotice
          publication={draft.publication}
          contextTotal={draft.inheritedContextTotal}
        />
      )}
      {draft.restartOf && (
        <p className="restart-notice">
          Restarting creates a new run from the current canonical source. The previous run and its
          failure evidence remain in history. Current repository checks apply. Review connections
          and limits before approving.
        </p>
      )}
      <p>
        {agents.length === 1
          ? 'Your agent works in an isolated workspace with the approved brief and selected context.'
          : 'Your agents share one source revision, brief and selected context. Each works in an isolated workspace as capacity becomes available.'}{' '}
        Independent checks and your shipping decision still apply. Approval starts paid inference
        using your provider keys.
      </p>
      <p className="subtle">
        Starting source: <code>{short(snapshot.repository.head_commit)}</code> · current canonical
        revision
      </p>
      <label>
        {updating ? 'What should change?' : 'What should your agent build?'}
        <textarea
          placeholder={
            updating
              ? 'Update the event schedule and add a photo gallery. Keep the existing navigation and visual style…'
              : 'Build a website for a neighborhood garden, with events and a clear way to get involved…'
          }
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
          {locked ? 'Starting…' : `Approve brief and start agent${agents.length === 1 ? '' : 's'}`}
        </button>
        <button type="button" className="quiet" disabled={locked} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
