import type { TeamPlan } from '../../../../shared/team';
import type { AgentDraft } from '../exploration/agentLimits';
import { TeamPlanEditor } from './TeamPlanEditor';
import type { TeamDraft } from './teamDraft';
export function TeamPlanOptions({
  value,
  agents,
  locked,
  previous,
  onChange,
}: {
  value: TeamDraft;
  agents: AgentDraft[];
  locked: boolean;
  previous?: TeamPlan;
  onChange: (value: TeamDraft) => void;
}) {
  return (
    <section className="team-plan-options" aria-label="Team task plan">
      <p className="subtle">
        You write the tasks. Each agent builds its tasks in its own sandbox, and the platform merges
        their work on one team branch. You’ll see each task’s landing in the run.
      </p>
      {previous && (
        <details className="team-contract">
          <summary>Previous team plan</summary>
          <p>{previous.contract}</p>
          <ul>
            {previous.tasks.map((task) => (
              <li key={task.id}>
                {task.title} · {task.write_paths.join(', ')}
              </li>
            ))}
          </ul>
          <p>Recorded on an earlier run, for reference.</p>
        </details>
      )}
      <TeamPlanEditor value={value} agents={agents} locked={locked} onChange={onChange} />
    </section>
  );
}
