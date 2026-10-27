import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { ExecutionLogs } from '../exploration/ExecutionLogs';
import { landingText, sandboxMembers, teamHead } from './sandboxTeamView';

/** Each member's task, status and landing, and the team branch commit they share. */
export function SandboxTeam({
  snapshot,
  run,
  onProviders,
}: {
  snapshot: Snapshot;
  run: Record<string, any>;
  onProviders?: () => void;
}) {
  const members = sandboxMembers(snapshot, run);
  const landed = members.filter((execution) => execution.landing?.status === 'landed').length;
  const head = teamHead(snapshot, run, members);
  return (
    <>
      <p>
        {landed} / {members.length} tasks landed on the team branch
        {head ? (
          <>
            {' '}
            at <code>{short(head)}</code>
          </>
        ) : null}
        . Each agent works alone in its own sandbox; the platform merges every landing.
      </p>
      {!members.length ? (
        <p role="status">The task sandboxes are being scheduled.</p>
      ) : (
        <ol className="team-task-list" aria-label="Team tasks and landings">
          {members.map((execution) => (
            <li key={execution.id} className="team-task-card" id={`team-member-${execution.id}`}>
              <div className="team-task-summary">
                <div>
                  <strong>{execution.sandbox_task?.title}</strong>
                  <small>
                    {execution.model} · {String(execution.status ?? 'queued').replaceAll('_', ' ')}
                  </small>
                </div>
              </div>
              <p>
                {landingText(execution)}
                {execution.landing?.team_commit && (
                  <>
                    {' '}
                    · team branch <code>{short(execution.landing.team_commit)}</code>
                  </>
                )}
              </p>
              {execution.status === 'failed' && execution.error && (
                <p className="inline-error">{String(execution.error)}</p>
              )}
              <ExecutionLogs
                repo={snapshot.repository.id}
                execution={execution}
                onProviders={onProviders}
              />
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
