import { useEffect, useState } from 'react';
import { api, short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';

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
  const reviewable = eligible.filter(
    (c) =>
      c.base.commit === snapshot.repository.head_commit &&
      snapshot.evaluations.some(
        (e) => e.id === c.evaluation && e.policy === snapshot.repository.policy?.version,
      ),
  );
  const reviewReady = !decision && run.status === 'ready' && reviewable.length > 0;
  const stages = [
    ...(research
      ? [{ name: 'Research', value: research.status, detail: research.model }]
      : [
          {
            name: 'Shared brief',
            value: run.external ? 'agent requested' : 'approved',
            detail: `${run.context?.length ?? 0} context references`,
          },
        ]),
    {
      name: 'Code in parallel',
      value: `${done} / ${coding.length} finished`,
      detail: 'Same source and context',
    },
    {
      name: 'Capture source',
      value: `${candidates.length} / ${coding.length} captured`,
      detail: 'Exact fork commits',
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
      {reviewReady && (
        <div className="review-ready" role="status">
          <strong>Ready for review</strong>
          <p>
            {reviewable.length} checked approach{reviewable.length === 1 ? ' is' : 'es are'}{' '}
            eligible. Compare previews, changes and context below, then choose Select approach and
            record your decision. Publication waits for your selection; agents cannot publish
            directly.
          </p>
        </div>
      )}
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
      {decision && (
        <div className="recorded-decision">
          <strong>
            {decision.decision_kind === 'development_verification'
              ? 'Automated development selection'
              : 'Owner decision'}
          </strong>
          <p>{decision.rationale}</p>
        </div>
      )}
    </section>
  );
}
