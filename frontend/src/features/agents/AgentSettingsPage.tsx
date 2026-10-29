// Agents → <agent> (`/agents/<id>`): one agent's settings, pre-filled with YonedaRepo's
// maintained defaults: name, description, harness, model, reasoning, timeout, instructions,
// its value type and polarity, the trigger and the repositories it runs on. The first save
// ("Enable agent") turns it on for the chosen repositories; later saves send only what
// changed. `/agents/new` shows the same form for a custom agent, which needs billing.
import { useEffect, useState } from 'react';
import {
  type AgentState,
  type Harness,
  managedAgent,
  type Reasoning,
  type RunValue,
  type WorkspaceState,
} from '../../../../shared/managed-agents';
import { MAX_INSTRUCTIONS, TIMEOUT_RANGE } from '../../../../shared/managed-settings';
import { linkTo, type Navigate } from '../shell/useRoute';
import { Failure } from '../source-platform/SourceStatus';
import { managedApi } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
import { AgentIcon, BillingComing, HistoryStrip, loadState } from './agentParts';
import {
  type AgentForm,
  agentPath,
  customizedText,
  formProblem,
  harnessOptions,
  initialForm,
  modelOptions,
  newAgentForm,
  updateBody,
  valueTypeLabel,
  withHarness,
  workspacePath,
} from './agentsModel';
import { RepoChecklist, TriggerFields } from './settingsParts';

type Space = { workspace?: string };

function Fields({
  form,
  set,
  defaultInstructions,
}: {
  form: AgentForm;
  set: (next: Partial<AgentForm>) => void;
  defaultInstructions: string | null;
}) {
  const models = modelOptions(form.harness);
  return (
    <>
      <label className="agent-field">
        Name
        <input value={form.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="agent-field">
        Description
        <input
          value={form.description}
          maxLength={300}
          onChange={(e) => set({ description: e.target.value })}
        />
      </label>
      <div className="agent-field-row">
        <label className="agent-field">
          Harness
          <select
            value={form.harness}
            onChange={(e) => set(withHarness(form, e.target.value as Harness))}
          >
            {harnessOptions().map((h) => (
              <option key={h.value} value={h.value}>
                {h.label}
              </option>
            ))}
          </select>
        </label>
        <label className="agent-field">
          Model
          <select
            value={`${form.provider}/${form.model}`}
            onChange={(e) => {
              const picked = models.find((m) => m.value === e.target.value);
              if (picked) set({ provider: picked.provider, model: picked.model });
            }}
          >
            {models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.text}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="agent-field-row">
        <label className="agent-field">
          Reasoning
          <select
            value={form.reasoning}
            onChange={(e) => set({ reasoning: e.target.value as Reasoning })}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <label className="agent-field">
          Timeout (minutes)
          <input
            type="number"
            min={TIMEOUT_RANGE.min}
            max={TIMEOUT_RANGE.max}
            value={form.timeout_minutes}
            onChange={(e) => set({ timeout_minutes: Number(e.target.value) })}
          />
        </label>
      </div>
      <label className="agent-field">
        Instructions
        <textarea
          rows={14}
          maxLength={MAX_INSTRUCTIONS}
          value={form.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
        />
      </label>
      {defaultInstructions !== null && form.instructions !== defaultInstructions && (
        <button
          type="button"
          className="text-button"
          onClick={() => set({ instructions: defaultInstructions })}
        >
          Reset to the maintained instructions
        </button>
      )}
    </>
  );
}

function Form({
  workspace,
  state,
  agent,
  space,
  navigate,
}: {
  workspace: string;
  state: WorkspaceState;
  agent: AgentState;
  space: Space;
  navigate: Navigate;
}) {
  const [form, setForm] = useState(() => initialForm(agent, state.repos));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [current, setCurrent] = useState(agent);
  const first = current.enabled_repos.length === 0;
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
      setCurrent(next);
      setForm(initialForm(next, state.repos));
      setSaved(first ? 'Enabled.' : 'Saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="agent-settings" onSubmit={save}>
      <div className="agent-settings-head">
        <AgentIcon icon={current.icon} />
        <div>
          <h1>{current.settings.name}</h1>
          <p>{current.pitch}</p>
        </div>
      </div>
      <p className="agent-maintained" role="note">
        This agent is maintained by YonedaRepo, so its model and instructions stay up to date. You
        can customize it to make it your own.
        {current.customized.length > 0 &&
          ` You changed its ${customizedText(current.customized)}; those stay as you set them.`}
      </p>
      {!first && (
        <section aria-labelledby="history-heading">
          <h2 id="history-heading">Last results</h2>
          <HistoryStrip history={current.history} />
          <a {...linkTo({ view: 'agent-runs', agent: agent.id, ...space }, navigate)}>
            View its runs
          </a>
        </section>
      )}
      <Fields form={form} set={set} defaultInstructions={current.defaults.instructions} />
      <dl className="managed-facts agent-result-type">
        <dt>Value type</dt>
        <dd>{valueTypeLabel(current)}</dd>
        <dt>Polarity</dt>
        <dd>Lower is better</dd>
        <dt>Check</dt>
        <dd>
          <code>{current.check}</code>
        </dd>
      </dl>
      {current.value_type === 'level' && (
        <label className="agent-field">
          Block landing at
          <select
            value={form.block_at ?? ''}
            onChange={(e) => set({ block_at: (e.target.value || null) as RunValue | null })}
          >
            <option value="">Never (report only)</option>
            <option value="medium">Medium or higher</option>
            <option value="high">High</option>
          </select>
        </label>
      )}
      <TriggerFields trigger={form.trigger} onChange={(trigger) => set({ trigger })} />
      <RepoChecklist
        repos={state.repos}
        selected={form.repos}
        onChange={(repos) => set({ repos })}
      />
      {first && form.repos.length === 0 && (
        <p className="source-meta">Choose at least one repository to enable the agent on.</p>
      )}
      {(error || problem) && <Failure error={error || problem} />}
      {saved && (
        <p role="status" className="source-meta">
          {saved}
        </p>
      )}
      <div className="agent-settings-actions">
        <button
          type="submit"
          disabled={saving || Boolean(problem) || (first && form.repos.length === 0)}
        >
          {saving ? 'Saving…' : first ? 'Enable agent' : 'Save'}
        </button>
        <a {...linkTo({ view: 'agents-home', ...space }, navigate)}>Back to agents</a>
      </div>
    </form>
  );
}

function NewAgent({
  state,
  navigate,
  space,
}: {
  state: WorkspaceState;
  navigate: Navigate;
  space: Space;
}) {
  const [form, setForm] = useState(() => newAgentForm(state.repos));
  const set = (next: Partial<AgentForm>) => setForm((f) => ({ ...f, ...next }));
  return (
    <form className="agent-settings" onSubmit={(e) => e.preventDefault()}>
      <div className="agent-settings-head">
        <AgentIcon icon="custom" />
        <div>
          <h1>New agent</h1>
          <p>Write your own instructions and pick where it runs.</p>
        </div>
      </div>
      <BillingComing>
        Creating your own agents needs billing, which is coming. The agents YonedaRepo maintains run
        on your promotional credit in the meantime.
      </BillingComing>
      <Fields form={form} set={set} defaultInstructions={null} />
      <TriggerFields trigger={form.trigger} onChange={(trigger) => set({ trigger })} />
      <RepoChecklist
        repos={state.repos}
        selected={form.repos}
        onChange={(repos) => set({ repos })}
      />
      <div className="agent-settings-actions">
        <button type="submit" disabled title="Needs billing, which is coming">
          Create agent
        </button>
        <a {...linkTo({ view: 'agents-home', ...space }, navigate)}>Back to agents</a>
      </div>
    </form>
  );
}

export function AgentSettingsPage({
  workspace,
  agent,
  account,
  navigate,
}: {
  workspace: string;
  agent: string;
  account?: string;
  navigate: Navigate;
}) {
  const known = agent === 'new' || Boolean(managedAgent(agent));
  const loaded = useSource<WorkspaceState>(known ? workspacePath(workspace) : null, '/api/managed');
  const space: Space = workspace === account ? {} : { workspace };
  useEffect(() => window.scrollTo?.({ top: 0 }), []);
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
  return (
    loadState(loaded, 'the agent') ??
    (state &&
      (agent === 'new' ? (
        <NewAgent state={state} navigate={navigate} space={space} />
      ) : found ? (
        <Form
          key={`${workspace}:${agent}`}
          workspace={workspace}
          state={state}
          agent={found}
          space={space}
          navigate={navigate}
        />
      ) : (
        <Failure error="This deployment does not offer that agent." />
      )))
  );
}
