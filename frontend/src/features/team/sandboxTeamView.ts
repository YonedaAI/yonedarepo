// A sandbox team run (owner tasks on `sandbox-cli-v1`): each member's task, status and landing
// on the team branch, and the branch head the landings left. The platform's merge integrates
// the members; nothing here decides anything.
import type { Snapshot } from '../../lib/types';

export { isSandboxTeam } from '../exploration/sandboxActivityView';

type Record_ = Record<string, any>;

/** The run's members (one per task), in plan order. */
export function sandboxMembers(snapshot: Snapshot, run: Record_): Record_[] {
  return snapshot.executions
    .filter((execution) => execution.run_id === run.id && execution.sandbox_task)
    .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}

/** What became of a member's commit on the team branch, in one line. */
export function landingText(execution: Record_): string {
  const landing = execution.landing;
  if (landing?.status === 'landed')
    return `Landed on the team branch${landing.resumed ? ' after one resume' : ''}`;
  if (landing?.status === 'conflict') {
    const paths = (landing.paths ?? []).join(', ');
    return landing.round > 0 || execution.status === 'failed'
      ? `Conflict on ${paths} after one resume: not landed`
      : `Conflict on ${paths}: resumed once to merge the team branch`;
  }
  if (execution.status === 'failed') return 'Failed before landing';
  return 'Not landed yet';
}

/** The team branch head: the captured candidate's, else the latest landing's. */
export function teamHead(snapshot: Snapshot, run: Record_, members: Record_[]): string | null {
  const captured = snapshot.candidates.find(
    (candidate) => candidate.run_id === run.id && candidate.execution === `${run.id}:team`,
  );
  if (captured?.revision?.commit) return captured.revision.commit;
  const landed = members
    .map((execution) => execution.landing)
    .filter((landing) => landing?.status === 'landed' && landing.team_commit)
    .sort((a, b) => (a.version ?? 0) - (b.version ?? 0));
  return landed.at(-1)?.team_commit ?? null;
}
