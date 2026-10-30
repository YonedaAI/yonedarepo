// One agent's pages. `/agents/<id>`: a set-up agent's page (AgentDetail), or, before it is set
// up, its set-up page. `/agents/<id>/configure`: the same page for a set-up agent. YonedaRepo
// maintains what the agent is (name, harness, model, reasoning, time limit, instructions and
// result), shown read-only; a workspace sets when it runs, on which repositories, and whether it
// is active. `/agents/new` is a custom agent, which needs billing (coming).
import { useEffect, useState } from 'react';
import {
  type AgentState,
  HARNESS_LABELS,
  managedAgent,
  modelRate,
  type WorkspaceState,
} from '../../../../shared/managed-agents';
import { linkTo, type Navigate } from '../shell/useRoute';
import { Failure } from '../source-platform/SourceStatus';
import { managedApi } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
import { AgentDetail } from './AgentDetail';
import { AgentIcon, loadState } from './agentParts';
import {
  agentPath,
  CREATE_OWN_GATE,
  checkPreview,
  valueTypeLabel,
  workspacePath,
} from './agentsModel';
import { RepoPicker, TriggerFields } from './settingsParts';
import { type AgentForm, formProblem, initialForm, updateBody } from './setupForm';

type Space = { workspace?: string };

const REASONING: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High' };
const BLOCK_AT: Record<string, string> = { medium: 'medium or higher', high: 'high' };

/** A field YonedaRepo maintains: readable, selectable, not editable. */
function Fixed({ label, value }: { label: string; value: string }) {
  return (
    <label className="agent-field">
      {label}
      <input className="agent-fixed" readOnly aria-readonly="true" value={value} />
    </label>
  );
}

/** What the agent is, all maintained by YonedaRepo: shown, never sent. */
function AgentFacts({ agent }: { agent: AgentState }) {
  const s = agent.settings;
  return (
    <div className="agent-panel">
      <div className="agent-panel-row agent-cols">
        <Fixed label="Name" value={s.name} />
        <Fixed label="Description" value={s.description} />
      </div>
      <div className="agent-panel-row agent-cols agent-cols-4">
        <Fixed label="Harness" value={HARNESS_LABELS[s.harness]} />
        <Fixed label="Model" value={modelRate(s.provider, s.model)?.label ?? s.model} />
        <Fixed label="Reasoning effort" value={REASONING[s.reasoning] ?? s.reasoning} />
        <Fixed label="Time limit" value={`${s.timeout_minutes} minutes`} />
      </div>
      <div className="agent-panel-row agent-field">
        <span id="instructions-label">Instructions</span>
        <section className="agent-fixed agent-instructions" aria-labelledby="instructions-label">
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must take focus to scroll by keyboard. */}
          <pre tabIndex={0}>{s.instructions}</pre>
        </section>
      </div>
      <div className="agent-panel-row agent-cols agent-result">
        <div className="agent-field">
          <Fixed label="Result format" value={valueTypeLabel(agent)} />
          <p className="source-meta">
            {agent.value_type === 'pass_fail'
              ? 'Pass when it finds nothing worth fixing; fail when it finds a high or medium problem. Lower is better.'
              : `The level of the most serious finding. Lower is better. ${
                  s.block_at
                    ? `It blocks landing at ${BLOCK_AT[s.block_at] ?? s.block_at}.`
                    : 'It reports and never blocks landing.'
                }`}
          </p>
        </div>
        <div className="agent-field">
          <span id="preview-label">How the check shows on a change</span>
          <ul className="agent-check-preview" aria-labelledby="preview-label">
            {checkPreview(agent).map((line) => (
              <li key={line.text}>
                <span className={`result-tile tone-${line.tone}`} aria-hidden="true" />
                <code>{line.text}</code>
                <span className="source-meta">{line.note}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function SetupForm({
  workspace,
  state,
  agent,
  space,
  navigate,
  onNewRepository,
}: {
  workspace: string;
  state: WorkspaceState;
  agent: AgentState;
  space: Space;
  navigate: Navigate;
  onNewRepository?: () => void;
}) {
  const [form, setForm] = useState(() => initialForm(agent, state.repos));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [current, setCurrent] = useState(agent);
  const first = current.created_at === null;
  const set = (next: Partial<AgentForm>) => {
    setSaved('');
    setForm((f) => ({ ...f, ...next }));
  };
  const problem = formProblem(current, form);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (problem) return setError(problem);
    setSaving(true);
    setError('');
    try {
      const next = await managedApi<AgentState>(agentPath(workspace, agent.id), {
        method: 'PUT',
        body: updateBody(current, form),
      });
      if (first) return navigate({ view: 'agent-settings', agent: agent.id, ...space });
      setCurrent(next);
      setForm(initialForm(next, state.repos));
      setSaved('Saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const name = current.settings.name;
  return (
    <form className="agent-setup" onSubmit={save}>
      <header className="agent-setup-head">
        <AgentIcon icon={current.icon} />
        <div>
          <h1>{first ? `Set up ${name}` : `Configure ${name}`}</h1>
          <p>{current.pitch}</p>
        </div>
      </header>
      <section className="agent-setup-section" aria-labelledby="agent-heading">
        <h2 id="agent-heading">Agent</h2>
        <AgentFacts agent={current} />
        <p className="agent-panel agent-maintained" role="note">
          YonedaRepo maintains this agent&apos;s model and instructions.
        </p>
      </section>
      <section className="agent-setup-section" aria-labelledby="when-heading">
        <h2 id="when-heading">When to run</h2>
        <div className="agent-panel">
          <TriggerFields trigger={form.trigger} onChange={(trigger) => set({ trigger })} />
        </div>
      </section>
      <section className="agent-setup-section" aria-labelledby="repos-heading">
        <h2 id="repos-heading">Repositories</h2>
        <div className="agent-panel">
          <RepoPicker
            repos={state.repos}
            all={form.all_repos}
            selected={form.repos}
            onChange={(next) => set(next)}
            onNewRepository={onNewRepository}
            navigate={navigate}
          />
        </div>
      </section>
      {(error || problem) && <Failure error={error || problem} />}
      {saved && (
        <p role="status" className="source-meta agent-setup-saved">
          {saved}
        </p>
      )}
      <footer className="agent-setup-foot">
        <label className="agent-switch">
          <input
            type="checkbox"
            role="switch"
            aria-checked={form.active}
            checked={form.active}
            onChange={(e) => set({ active: e.target.checked })}
          />
          <span>Active</span>
        </label>
        {!first && (
          <a
            className="button-link quiet"
            {...linkTo({ view: 'agent-settings', agent: agent.id, ...space }, navigate)}
          >
            Cancel
          </a>
        )}
        <button type="submit" disabled={saving || Boolean(problem)}>
          {saving ? 'Saving…' : first ? 'Add agent' : 'Save changes'}
        </button>
      </footer>
    </form>
  );
}

function NewAgent({ navigate, space }: { navigate: Navigate; space: Space }) {
  return (
    <div className="agent-setup">
      <header className="agent-setup-head">
        <AgentIcon icon="custom" />
        <div>
          <h1>New agent</h1>
          <p>Your own reviewer: your instructions, run on the changes you choose.</p>
        </div>
      </header>
      <div className="agents-billing-note" role="note">
        <p>
          {CREATE_OWN_GATE}. Billing is coming; meanwhile the agents YonedaRepo maintains run on
          your starting credit.
        </p>
      </div>
      <footer className="agent-setup-foot">
        <a className="button-link quiet" {...linkTo({ view: 'agents-home', ...space }, navigate)}>
          Back to agents
        </a>
        <button type="button" disabled title={CREATE_OWN_GATE}>
          Create agent
        </button>
      </footer>
    </div>
  );
}

export function AgentSettingsPage({
  workspace,
  agent,
  account,
  configure = false,
  navigate,
  onNewRepository,
}: {
  workspace: string;
  agent: string;
  account?: string;
  /** `/agents/<id>/configure`: the form even for a set-up agent. */
  configure?: boolean;
  navigate: Navigate;
  onNewRepository?: () => void;
}) {
  const known = agent === 'new' || Boolean(managedAgent(agent));
  const loaded = useSource<WorkspaceState>(known ? workspacePath(workspace) : null, '/api/managed');
  const space: Space = workspace === account ? {} : { workspace };
  useEffect(() => {
    window.scrollTo?.({ top: 0 });
  }, []);
  if (!known)
    return (
      <div className="source-empty-state">
        <p>
          <strong>There is no agent called “{agent}”.</strong>{' '}
          <a {...linkTo({ view: 'agents-home', ...space }, navigate)}>See all agents</a>
        </p>
      </div>
    );
  const state = loaded.data;
  const found = state?.agents.find((a) => a.id === agent);
  if (loadState(loaded, 'the agent')) return loadState(loaded, 'the agent');
  if (!state) return null;
  if (agent === 'new') return <NewAgent navigate={navigate} space={space} />;
  if (!found) return <Failure error="This deployment does not offer that agent." />;
  if (!configure && found.created_at !== null)
    return (
      <AgentDetail
        workspace={workspace}
        state={state}
        agent={found}
        space={space}
        navigate={navigate}
        onChanged={loaded.reload}
      />
    );
  return (
    <SetupForm
      key={`${workspace}:${agent}`}
      workspace={workspace}
      state={state}
      agent={found}
      space={space}
      navigate={navigate}
      onNewRepository={onNewRepository}
    />
  );
}
