import type { TeamPlan } from '../../../../shared/team';
import type { AgentDraft } from '../exploration/agentLimits';
import { TeamPlanEditor } from './TeamPlanEditor';
import type { TeamDraft } from './teamDraft';
export function TeamPlanOptions({
  manual,
  onManualChange,
  value,
  agents,
  locked,
  automaticSupported,
  previous,
  previousAutomatic,
  onChange,
}: {
  manual: boolean;
  onManualChange: (value: boolean) => void;
  value: TeamDraft;
  agents: AgentDraft[];
  locked: boolean;
  automaticSupported: boolean;
  previous?: TeamPlan;
  previousAutomatic: boolean;
  onChange: (value: TeamDraft) => void;
}) {
  return (
    <section className="team-plan-options" aria-label="Team planning settings">
      <p className="subtle">
        An agent breaks down your brief and coordinates this roster. You’ll see the plan and
        progress in the run. One agent works in sequence; several can work in parallel.
      </p>
      <label className="team-plan-toggle">
        <input
          type="checkbox"
          checked={manual}
          disabled={locked}
          onChange={(event) => onManualChange(event.target.checked)}
        />
        Advanced task plan
      </label>
      {manual && <p className="subtle">Set task assignments, dependencies and writable paths.</p>}
      {!automaticSupported && !manual && (
        <p role="alert">
          Automatic planning is unavailable on this deployment. Enable Advanced task plan to provide
          a plan.
        </p>
      )}
      {previous && (
        <details className="team-contract">
          <summary>Previous {previousAutomatic ? 'generated' : 'manual'} team plan</summary>
          <p>{previous.contract}</p>
          <ul>
            {previous.tasks.map((task) => (
              <li key={task.id}>
                {task.title} · {task.write_paths.join(', ')}
              </li>
            ))}
          </ul>
          <p>
            {previousAutomatic
              ? 'Historical provenance. This run is planned again from its new brief.'
              : 'This earlier manual plan is available in the advanced editor if you choose to reuse and adjust it.'}
          </p>
        </details>
      )}
      {manual && (
        <TeamPlanEditor value={value} agents={agents} locked={locked} onChange={onChange} />
      )}
    </section>
  );
}
