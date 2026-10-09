import type { Snapshot } from '../../lib/types';
import { TeamTaskCard } from './TeamTaskCard';
import { type TeamRecord, teamTasks } from './teamView';
export function TeamWorkflow({
  snapshot,
  run,
  busy,
  onRetry,
  onProviders,
}: {
  snapshot: Snapshot;
  run: TeamRecord;
  busy: boolean;
  onRetry: (task: TeamRecord) => void;
  onProviders: () => void;
}) {
  const tasks = teamTasks(snapshot, run);
  const specialists = tasks.filter((task) => task.role !== 'integrator');
  return (
    <section className="team-workflow" aria-labelledby="team-workflow-heading">
      <h2 id="team-workflow-heading">Build together</h2>
      <p>
        {specialists.filter((task) => task.status === 'complete').length} / {specialists.length}{' '}
        specialist outputs captured. The integrator assembles exact task revisions into one
        candidate.
      </p>
      {run.team_plan?.contract && (
        <details className="team-contract">
          <summary>Approved shared interface</summary>
          <p>{run.team_plan.contract}</p>
        </details>
      )}
      {!tasks.length ? (
        <p role="status">
          The approved task plan is being scheduled. Task ownership and dependency status will
          appear here.
        </p>
      ) : (
        <ol className="team-task-list" aria-label="Team tasks and dependencies">
          {tasks.map((task) => (
            <TeamTaskCard
              key={task.id}
              task={task}
              tasks={tasks}
              run={run}
              snapshot={snapshot}
              busy={busy}
              onRetry={onRetry}
              onProviders={onProviders}
            />
          ))}
        </ol>
      )}
      <p>
        Worker handoffs are assertions until trusted source capture. Independent checks apply to the
        final integrated result.
      </p>
    </section>
  );
}
