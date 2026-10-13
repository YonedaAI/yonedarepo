import { useEffect, useRef, useState } from 'react';
import { runSamples } from '../../../../shared/run-samples';
import type { RunMode } from '../../../../shared/team';
import { api } from '../../lib/api';
import type { Repository, Snapshot } from '../../lib/types';
import { RunModePicker } from '../team/RunModePicker';
import { TeamPlanOptions } from '../team/TeamPlanOptions';
import { reconcileTeam, seedTeam, teamSubmission } from '../team/teamDraft';
import type { Provider } from '../workspace/ProviderSettings';
import { AgentRoster } from './AgentRoster';
import { type AdaptiveAgentDraft, compareBuilders, requestedAgents } from './adaptiveDraft';
import { runAgentLimits } from './agentLimits';
import { CompareApprovalNotice } from './CompareApprovalNotice';
import { RunAdvancedOptions } from './RunAdvancedOptions';
import { RunSourceNotice } from './RunSourceNotice';
import { agentConnectionIssue, type InitialRun } from './restartRun';
import { hasPublishedWork } from './runDefaults';
import { defaultConnections, runDraft } from './runDraft';
import { SampleBriefSummary, briefStarters as starters } from './sampleBrief';
import { WorkspaceAllowance } from './WorkspaceAllowance';
import { workingBranchRequest } from './workingBranchView';

export function RunComposer({
  busy,
  snapshot,
  onStart,
  onClose,
  onProviders,
  initialRun,
  sampleProfileId,
  startUncertain = false,
}: {
  busy: boolean;
  snapshot: Snapshot;
  onStart: (body: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
  onProviders: (refresh?: () => void) => void;
  initialRun?: InitialRun;
  sampleProfileId?: string;
  startUncertain?: boolean;
}) {
  const submitted = useRef<Record<string, unknown> | undefined>(undefined);
  const [draft] = useState(() => runDraft(snapshot, initialRun));
  const [intent, setIntent] = useState(draft.intent);
  const [criteria, setCriteria] = useState(draft.criteria);
  const sample = runSamples.find((item) => item.id === sampleProfileId);
  const [starter, setStarter] = useState(sample ? (sample.starter === 'bug' ? 2 : 1) : 0);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState('');
  const [providersRequest, setProvidersRequest] = useState(0);
  const limits = runAgentLimits(snapshot);
  const [agents, setAgents] = useState<AdaptiveAgentDraft[]>(
    draft.mode === 'compare' ? compareBuilders(draft.agents) : draft.agents,
  );
  const [mode, setMode] = useState<RunMode>(draft.mode);
  const [team, setTeam] = useState(draft.team ?? seedTeam(draft.agents));
  const [manualTeam, setManualTeam] = useState(!!draft.team);
  const teamSupport = snapshot.capabilities?.collaborative_runs === 1;
  const automaticSupport = snapshot.capabilities?.team_planning === 1;
  const [context, setContext] = useState<string[]>(draft.context);
  const [policy, setPolicy] = useState(draft.policy);
  const [error, setError] = useState('');
  const [approving, setApproving] = useState(false);
  const updating = !draft.restartOf && !draft.workingBranch && hasPublishedWork(snapshot);
  function changeAgents(next: AdaptiveAgentDraft[]) {
    setAgents(mode === 'compare' ? compareBuilders(next) : next);
    setTeam((current) => reconcileTeam(current, next));
  }
  function changeMode(next: RunMode) {
    if (next === 'compare') changeAgents(compareBuilders(agents));
    setMode(next);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry starts a fresh cancellable request.
  useEffect(() => {
    let current = true;
    setProvidersLoading(true);
    setProvidersError('');
    void api<{ providers: Provider[] }>('settings')
      .then((result) => {
        if (!current) return;
        setProviders(result.providers);
        setAgents((current) => defaultConnections(current, result.providers));
      })
      .catch((error) => {
        if (current) setProvidersError(error.message);
      })
      .finally(() => {
        if (current) setProvidersLoading(false);
      });
    return () => {
      current = false;
    };
  }, [providersRequest]);
  async function start() {
    if (approving || busy) return;
    setApproving(true);
    setError('');
    try {
      if (startUncertain && submitted.current) {
        await onStart(submitted.current);
        return;
      }
      if (!intent.trim()) throw new Error('Describe the change you want to make.');
      if (mode === 'collaborate' && !teamSupport)
        throw new Error('This deployment does not support team runs yet.');
      const teamBody = teamSubmission(mode, manualTeam, team, agents, automaticSupport);
      if (
        agents.length < (mode === 'collaborate' ? 1 : limits.min_root_agents) ||
        agents.length > limits.max_root_agents
      )
        throw new Error('The number of agents exceeds this deployment’s current limits.');
      if (
        agents.some(
          (agent) =>
            agent.connection &&
            (providersLoading ||
              providersError ||
              !providers.some((p) => p.id === agent.connection)),
        )
      )
        throw new Error('Load and review the selected model connections before starting.');
      if (agents.some((agent) => agentConnectionIssue(agent, providers)))
        throw new Error('Review changed model connections before starting this run.');
      const preferences = requestedAgents(agents, providers);
      let current: Repository = snapshot.repository;
      const build = JSON.parse(policy);
      if (JSON.stringify(build) !== JSON.stringify(current.policy?.build)) {
        current = await api<Repository>(`repos/${current.id}/update_policy`, {
          policy: {
            ...current.policy,
            version: `policy-${crypto.randomUUID()}`,
            suite: 'commands-v1',
            environment: 'linux-node24-rust1.94-v1',
            build,
            required_checks: build.checks.map((c: { name: string }) => c.name),
          },
          expected_commit: current.head_commit,
          expected_version: current.version,
          expected_policy: current.policy?.version,
        });
      }
      submitted.current = {
        mode,
        ...teamBody,
        intent: intent.trim(),
        criteria: criteria
          .split('\n')
          .map((c) => c.trim())
          .filter(Boolean),
        context,
        ...workingBranchRequest(draft.workingBranch),
        ...(draft.restartOf ? { restart_of: draft.restartOf } : {}),
        ...(draft.publication ? { continuation_of: draft.publication.decision.id } : {}),
        ...(sampleProfileId ? { sample_profile_id: sampleProfileId } : {}),
        adaptive_team: { version: 1, requested_agents: preferences },
        ...(mode === 'compare' ? { comparison: { version: 1 } } : {}),
      };
      await onStart(submitted.current);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setApproving(false);
    }
  }
  const locked = busy || approving;
  const draftLocked = locked || startUncertain;
  return (
    <form
      className="run-composer simple-run-composer"
      aria-label="Start a run"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <SampleBriefSummary sample={sample} />
      <label className="run-brief">
        What would you like to do?
        <textarea
          placeholder={starters[starter].placeholder}
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
          required
          maxLength={16000}
          disabled={draftLocked}
        />
      </label>
      <div className="brief-starters">
        {starters.map((item, index) => (
          <button
            type="button"
            key={item.label}
            className="quiet"
            aria-pressed={starter === index}
            disabled={draftLocked}
            onClick={() => setStarter(index)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <AgentRoster
        team={mode === 'collaborate'}
        compare={mode === 'compare'}
        agents={agents}
        providers={providers}
        loading={providersLoading}
        error={providersError}
        limits={limits}
        locked={draftLocked}
        onChange={changeAgents}
        onProviders={() => onProviders(() => setProvidersRequest((request) => request + 1))}
        onRetry={() => setProvidersRequest((request) => request + 1)}
      />
      {mode === 'compare' && <CompareApprovalNotice />}
      <details className="run-advanced">
        <summary>Advanced</summary>
        <label>
          Acceptance criteria (one per line)
          <textarea
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
            required
            disabled={draftLocked}
          />
        </label>
        <RunModePicker
          value={mode}
          supported={teamSupport}
          locked={draftLocked}
          onChange={changeMode}
        />
        {mode === 'collaborate' ? (
          <TeamPlanOptions
            manual={manualTeam}
            onManualChange={setManualTeam}
            value={team}
            agents={agents}
            locked={draftLocked}
            automaticSupported={automaticSupport}
            previous={draft.previousTeamPlan}
            previousAutomatic={draft.previousAutomatic}
            onChange={setTeam}
          />
        ) : null}
        <RunAdvancedOptions
          nodes={snapshot.nodes}
          context={context}
          policy={policy}
          locked={draftLocked}
          onContextChange={setContext}
          onPolicyChange={setPolicy}
        />
        <RunSourceNotice
          snapshot={snapshot}
          draft={draft}
          updating={updating}
          mode={mode}
          agents={agents.length}
        />
      </details>
      <WorkspaceAllowance />
      {startUncertain && (
        <p role="status">
          Start is unconfirmed. Retry checks the same run and keeps this brief unchanged.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="run-actions">
        <button type="submit" disabled={locked || !intent.trim()}>
          {locked ? 'Starting…' : startUncertain ? 'Check and retry start' : 'Start a Run'}
        </button>
        <button type="button" className="quiet" disabled={locked} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
