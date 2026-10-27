import type { AgentDraft } from '../exploration/agentLimits';
import type { TeamTaskDraft } from './teamDraft';
export function TeamTaskEditor({
  task,
  agents,
  locked,
  onChange,
  onRemove,
}: {
  task: TeamTaskDraft;
  agents: AgentDraft[];
  locked: boolean;
  onChange: (task: TeamTaskDraft) => void;
  onRemove: () => void;
}) {
  const patch = (value: Partial<TeamTaskDraft>) => onChange({ ...task, ...value });
  return (
    <fieldset className="team-task-editor">
      <legend>{task.title || 'Worker task'}</legend>
      <div className="team-fields">
        <label>
          Task title
          <input
            value={task.title}
            required
            maxLength={128}
            disabled={locked}
            onChange={(e) => patch({ title: e.target.value })}
          />
        </label>
        <label>
          Assigned agent
          <select
            value={task.agentId}
            required
            disabled={locked}
            onChange={(e) => patch({ agentId: e.target.value })}
          >
            <option value="">Choose an agent</option>
            {agents.map((agent, index) => (
              <option key={agent.id} value={agent.id}>
                Agent {index + 1}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Instructions
        <textarea
          value={task.instructions}
          required
          maxLength={8192}
          disabled={locked}
          onChange={(e) => patch({ instructions: e.target.value })}
        />
      </label>
      <label>
        Writable paths (one per line)
        <textarea
          value={task.writePaths}
          required
          disabled={locked}
          rows={2}
          placeholder={'public/component.mjs\npublic/components/'}
          onChange={(e) => patch({ writePaths: e.target.value })}
        />
      </label>
      <p className="subtle">
        Use exact files or a directory ending in /. Each worker owns separate paths.
      </p>
      <button
        type="button"
        className="text-button"
        disabled={locked}
        onClick={onRemove}
        aria-label={`Remove task ${task.title || task.id}`}
      >
        Remove task
      </button>
    </fieldset>
  );
}
