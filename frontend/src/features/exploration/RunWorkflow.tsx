import { useEffect, useState } from 'react';
import { api, short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { reviewableCandidates } from './runReviewState';

function SharedResearch({ repo, artifact }: { repo: string; artifact: Record<string, any> }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let current = true;
    setContent('');
    setError('');
    void api<{ content: string }>(`repos/${repo}/evidence?digest=${artifact.digest}`)
      .then((r) => {
        if (current) setContent(r.content);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [open, repo, artifact.digest]);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Read shared research: {artifact.label}</summary>
      <p>
        <code>{artifact.id}</code> · recorded by the research agent
      </p>
      {error ? <p role="alert">{error}</p> : <pre>{content || 'Loading recorded research…'}</pre>}
    </details>
  );
}

export function RunWorkflow({ snapshot, run }: { snapshot: Snapshot; run: Record<string, any> }) {
  const executions = snapshot.executions.filter((e) => e.run_id === run.id);
  const research = executions.find((e) => e.role === 'research');
  const coding = executions.filter((e) => e.role === 'coding');
  const candidates = snapshot.candidates.filter((c) => c.run_id === run.id);
  const checked = candidates.filter((c) => c.evaluation);
  const eligible = candidates.filter((c) => c.status === 'eligible');
  const decision = snapshot.decisions.find((d) => d.run_id === run.id);
  const shared = snapshot.artifacts.filter((a) => a.producer === research?.id);
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
  const stages = [
    ...(research
      ? [{ name: 'Research', value: research.status, detail: research.model }]
      : [
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
        ]),
    {
      name: team ? 'Specialist tasks' : coding.length === 1 ? 'Build approach' : 'Build approaches',
      value: team
        ? specialists.length
          ? `${specialists.filter((task) => task.status === 'complete').length} / ${specialists.length} captured`
          : 'waiting for plan'
        : `${done} / ${coding.length} finished`,
      detail: team
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
      value: team
        ? (integrator?.status ?? 'waiting for task inputs')
        : `${candidates.length} / ${coding.length} captured`,
      detail: team ? 'One combined source revision' : 'Exact fork commits',
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
      {shared.length > 0 && (
        <div className="shared-context">
          <h2>Agent-authored context</h2>
          <p>
            {shared.length
              ? `${shared.length} research artifact${shared.length === 1 ? '' : 's'} frozen for the coding agents.`
              : 'Agents publish typed findings, assumptions, alternatives and questions into the graph below.'}{' '}
            Agent assertions and external verification remain separate.
          </p>
          {shared.map((artifact) => (
            <SharedResearch key={artifact.id} repo={snapshot.repository.id} artifact={artifact} />
          ))}
        </div>
      )}
      {decision && (
        <details className="recorded-decision" id="recorded-shipping-decision" open tabIndex={-1}>
          <summary>Recorded shipping decision</summary>
          <strong>
            {decision.decision_kind === 'development_verification'
              ? 'Automated development selection'
              : 'Owner decision'}
          </strong>
          <p>{decision.rationale}</p>
          {decision.error && <p role="alert">{decision.error}</p>}
        </details>
      )}
    </section>
  );
}
