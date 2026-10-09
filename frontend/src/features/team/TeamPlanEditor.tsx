import type { AgentDraft } from '../exploration/agentLimits';
import { TeamTaskEditor } from './TeamTaskEditor';
import { removeTeamTask, type TeamDraft, type TeamTaskDraft } from './teamDraft';
export function TeamPlanEditor({
  value,
  agents,
  locked,
  onChange,
}: {
  value: TeamDraft;
  agents: AgentDraft[];
  locked: boolean;
  onChange: (value: TeamDraft) => void;
}) {
  function update(task: TeamTaskDraft) {
    onChange({ ...value, tasks: value.tasks.map((item) => (item.id === task.id ? task : item)) });
  }
  return (
    <section className="team-plan-editor" aria-labelledby="team-plan-heading">
      <div className="section-heading">
        <h3 id="team-plan-heading">Complementary tasks</h3>
        <button
          type="button"
          className="quiet"
          disabled={locked || value.tasks.length >= 16}
          onClick={() =>
            onChange({
              ...value,
              tasks: [
                ...value.tasks,
                {
                  id: `task-${crypto.randomUUID().slice(0, 8)}`,
                  title: '',
                  instructions: '',
                  agentId: '',
                  dependsOn: [],
                  writePaths: '',
                },
              ],
            })
          }
        >
          Add task
        </button>
      </div>
      <p className="subtle">
        Define tasks, interfaces and source ownership yourself. Ready tasks can run concurrently.
        One agent can handle multiple tasks and final integration in sequence.
      </p>
      <label>
        Shared interface contract
        <textarea
          value={value.contract}
          required
          maxLength={16000}
          disabled={locked}
          onChange={(e) => onChange({ ...value, contract: e.target.value })}
        />
      </label>
      <div className="team-task-editors">
        {value.tasks.map((task) => (
          <TeamTaskEditor
            key={task.id}
            task={task}
            tasks={value.tasks}
            agents={agents}
            locked={locked}
            onChange={update}
            onRemove={() => onChange(removeTeamTask(value, task.id))}
          />
        ))}
      </div>
      {!value.tasks.length && (
        <p className="inline-empty">
          No tasks in this draft. Add a task, or turn off Advanced task plan to let an agent plan
          the work.
        </p>
      )}
      <fieldset className="team-integration-editor">
        <legend>Final integration</legend>
        <label>
          Integrator agent
          <select
            value={value.integratorId}
            required
            disabled={locked}
            onChange={(e) => onChange({ ...value, integratorId: e.target.value })}
          >
            <option value="">Choose an agent</option>
            {agents.map((agent, index) => (
              <option key={agent.id} value={agent.id}>
                Agent {index + 1}
              </option>
            ))}
          </select>
        </label>
        <label>
          Integration write paths (one per line)
          <textarea
            value={value.integrationPaths}
            required
            disabled={locked}
            rows={2}
            onChange={(e) => onChange({ ...value, integrationPaths: e.target.value })}
          />
        </label>
        <p className="subtle">
          The integrator receives every captured worker output and may edit only these paths.
          Include worker files here if integration needs to repair them. One combined candidate
          receives independent checks and your shipping decision.
        </p>
      </fieldset>
    </section>
  );
}
