import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { isSandboxTeam, sandboxMembers } from '../team/sandboxTeamView';
import { activeDecision } from './agentsPick';
import { ComparisonWorkflow } from './ComparisonWorkflow';
import { RecordedDecisionStory } from './RecordedDecisionStory';
import { reviewableCandidates } from './runReviewState';

export function RunWorkflow({ snapshot, run }: { snapshot: Snapshot; run: Record<string, any> }) {
  if (run.comparison?.version === 1 && run.comparison.approval)
    return <ComparisonWorkflow snapshot={snapshot} run={run} />;
  const executions = snapshot.executions.filter((e) => e.run_id === run.id);
  const coding = executions.filter((e) => e.role === 'coding');
  const candidates = snapshot.candidates.filter((c) => c.run_id === run.id);
  const checked = candidates.filter((c) => c.evaluation);
  const eligible = candidates.filter((c) => c.status === 'eligible');
  // A selection outranks owner rejections, which otherwise show as the latest recorded decision.
  const decision =
    activeDecision(snapshot, run) ?? snapshot.decisions.findLast((d) => d.run_id === run.id);
  const done = coding.filter((e) => e.finished_at).length;
  const queued = coding.filter((e) => e.status === 'queued').length;
  const historical = ['accepted', 'cancelled', 'failed'].includes(run.status);
  const reviewable = reviewableCandidates(snapshot, run);
  const reviewReady = !decision && run.status === 'ready' && reviewable.length > 0;
  const team = run.mode === 'collaborate';
  const tasks = (snapshot.team_tasks ?? []).filter((task) => task.run_id === run.id);
  const specialists = tasks.filter((task) => task.role !== 'integrator');
  const integrator = tasks.find((task) => task.role === 'integrator');
  const planner = executions.find((execution) => execution.team_role === 'planner');
  // A sandbox team: members land on the team branch, which the platform's merge integrates.
  const members = isSandboxTeam(run) ? sandboxMembers(snapshot, run) : null;
  const landed = members?.filter((execution) => execution.landing?.status === 'landed').length;
  const stages = [
    {
      name: team && run.team_planning === 'automatic' ? 'Brief and planning' : 'Shared brief',
      value:
        team && run.team_planning === 'automatic'
          ? run.team_plan
            ? 'plan validated'
            : (planner?.status ?? run.status)
          : run.external
            ? 'agent requested'
            : 'approved',
      detail: `${run.context?.length ?? 0} context references`,
    },
    {
      name: team ? 'Specialist tasks' : coding.length === 1 ? 'Build approach' : 'Build approaches',
      value: members
        ? `${landed} / ${members.length} landed`
        : team
          ? specialists.length
            ? `${specialists.filter((task) => task.status === 'complete').length} / ${specialists.length} captured`
            : 'waiting for plan'
          : `${done} / ${coding.length} finished`,
      detail: members
        ? 'One sandbox per task on the same base'
        : team
          ? 'Complementary source scopes'
          : queued > 0
            ? `${queued} queued · capacity limited`
            : historical
              ? 'Recorded execution history'
              : coding.length > 0 && done === coding.length
                ? 'All agents finished'
                : coding.length > 0
                  ? 'Execution in progress'
                  : 'Waiting for agents',
    },
    {
      name: team ? 'Integration' : 'Capture source',
      value: members
        ? (executions.find((execution) => execution.team_role === 'team_branch')?.status ??
          'waiting for landings')
        : team
          ? (integrator?.status ?? 'waiting for task inputs')
          : `${candidates.length} / ${coding.length} captured`,
      detail: members
        ? 'Platform merge on the team branch'
        : team
          ? 'One combined source revision'
          : 'Exact fork commits',
    },
    {
      name: 'Independent checks',
      value: `${checked.length} checked`,
      detail: `${eligible.length} eligible`,
    },
    {
      name: 'Decision',
      value: decision
        ? 'recorded'
        : run.status === 'cancelled'
          ? 'cancelled'
          : reviewReady
            ? 'ready for review'
            : 'waiting for eligible source',
      detail:
        decision?.decision_kind === 'development_verification'
          ? 'Automated fixture verification'
          : 'Owner reviews tradeoffs',
    },
    {
      name: 'Publication',
      value: decision?.status ?? 'not selected',
      detail:
        decision?.status === 'published'
          ? `Verified ${short(decision.target.commit)}`
          : 'Canonical Git readback',
    },
  ];
  return (
    <section className="run-workflow" aria-label="Recorded development workflow">
      <ol className="workflow-stages">
        {stages.map((stage) => (
          <li key={stage.name}>
            <strong>{stage.name}</strong>
            <span>{stage.value.replaceAll('_', ' ')}</span>
            <small>{stage.detail}</small>
          </li>
        ))}
      </ol>
      {decision && (
        <details className="recorded-decision" id="recorded-shipping-decision" open tabIndex={-1}>
          <summary>Recorded shipping decision</summary>
          <RecordedDecisionStory decision={decision} />
        </details>
      )}
    </section>
  );
}
