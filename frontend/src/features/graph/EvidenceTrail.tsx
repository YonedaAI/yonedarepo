import { short } from '../../lib/api';
import type { Graph, GraphNode, Snapshot } from '../../lib/types';
import { TeamHandoff } from '../team/TeamHandoff';
import { EvidenceFields } from './EvidenceFields';
import { authorityLabel } from './evidenceView';

export function EvidenceTrail({
  snapshot,
  runId,
  graph,
  onSelect,
}: {
  snapshot: Snapshot;
  runId: string;
  graph: Graph;
  onSelect: (node: GraphNode) => void;
}) {
  const run = snapshot.runs.find((item) => item.id === runId);
  const candidates = snapshot.candidates.filter((item) => item.run_id === runId);
  const executions = snapshot.executions.filter((item) => item.run_id === runId);
  const handoffs = (snapshot.team_handoffs ?? []).filter((item) => item.run_id === runId);
  const decision = snapshot.decisions.find((item) => item.run_id === runId);
  const assertions = graph.nodes.filter((node) => authorityLabel(node) === 'Agent assertion');
  const evaluations = snapshot.evaluations.filter((item) =>
    candidates.some((candidate) => candidate.id === item.candidate),
  );
  function inspect(id: string) {
    const node = graph.nodes.find((item) => item.id === id);
    return node ? (
      <button type="button" className="text-button" onClick={() => onSelect(node)}>
        Read recorded evidence
      </button>
    ) : null;
  }
  if (!run)
    return (
      <p className="inline-empty">
        No run evidence yet. Start a run to record intent, source capture and checks.
      </p>
    );
  return (
    <ol className="evidence-trail" aria-label="Evidence from intent to publication">
      <li>
        <article>
          <h2>1. Intent</h2>
          <p className="evidence-text">{run.intent}</p>
          <h3>Acceptance criteria</h3>
          <EvidenceFields value={run.criteria ?? []} />
          <p>
            Starting revision <code>{short(run.base?.commit)}</code>
          </p>
          {inspect(`intent:${run.id}`)}
        </article>
      </li>
      <li>
        <article>
          <h2>2. Agent contributions and handoffs</h2>
          {!executions.length && <p>No agent contributions recorded yet.</p>}
          {executions.map((execution) => (
            <section key={execution.id}>
              <h3>{execution.strategy || execution.team_role || execution.role || 'Agent'}</h3>
              <p>
                {execution.model || execution.harness} ·{' '}
                {String(execution.status).replaceAll('_', ' ')}
              </p>
              {execution.task && <p>{execution.task}</p>}
              {inspect(execution.id)}
            </section>
          ))}
          {handoffs.map((handoff) => (
            <section key={handoff.id}>
              <TeamHandoff handoff={handoff} />
            </section>
          ))}
          {assertions.length > 0 && (
            <details>
              <summary>Agent assertions and cited context ({assertions.length})</summary>
              <ul>
                {assertions.map((node) => (
                  <li key={node.id}>
                    <button type="button" className="text-button" onClick={() => onSelect(node)}>
                      {node.label}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </article>
      </li>
      <li>
        <article>
          <h2>3. Captured revision</h2>
          {!candidates.length && (
            <p>
              No final source revision captured yet. Agent handoffs alone do not establish a final
              result.
            </p>
          )}
          {candidates.map((candidate) => (
            <section key={candidate.id}>
              <h3>{candidate.summary || 'Captured result'}</h3>
              <p>
                Exact revision <code>{candidate.revision?.commit}</code>
              </p>
              <details>
                <summary>Changed paths ({candidate.paths?.length ?? 0})</summary>
                <EvidenceFields value={candidate.paths ?? []} />
              </details>
              {inspect(candidate.id)}
            </section>
          ))}
        </article>
      </li>
      <li>
        <article>
          <h2>4. Independent checks</h2>
          {!evaluations.length && <p>No independent check results recorded yet.</p>}
          {evaluations.map((evaluation) => (
            <section key={evaluation.id}>
              <h3>
                Checked revision <code>{short(evaluation.revision?.commit)}</code>
              </h3>
              <p>
                {evaluation.suite} · policy {evaluation.policy} · {evaluation.environment}
              </p>
              <EvidenceFields value={evaluation.checks} />
              {inspect(evaluation.id)}
            </section>
          ))}
          <p className="subtle">
            Checks apply to their exact revision and recorded policy. Eligibility is revalidated
            before selection.
          </p>
        </article>
      </li>
      <li>
        <article>
          <h2>5. Decision and alternatives</h2>
          {decision ? (
            <>
              <h3>
                {decision.decision_kind === 'development_verification'
                  ? 'Automated fixture decision'
                  : 'Owner decision'}
              </h3>
              <p className="evidence-text">{decision.rationale || 'No rationale recorded.'}</p>
              <p>
                Selected revision <code>{short(decision.target?.commit)}</code>
              </p>
              <h3>Reasons for rejecting alternatives</h3>
              {decision.alternatives?.length ? (
                <ul>
                  {decision.alternatives.map((alternative: Record<string, any>) => (
                    <li key={alternative.candidate}>
                      <strong>
                        {candidates.find((candidate) => candidate.id === alternative.candidate)
                          ?.summary || alternative.candidate}
                      </strong>
                      <p>{alternative.reason || 'No rejection reason recorded.'}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No alternative rejection reasons recorded.</p>
              )}
              {inspect(decision.id)}
            </>
          ) : (
            <p>
              No shipping decision recorded. Review the captured result and its checks before
              choosing what to publish.
            </p>
          )}
        </article>
      </li>
      <li>
        <article>
          <h2>6. Publication status</h2>
          <p>
            {decision?.status === 'published'
              ? 'Published: canonical Git revision was independently read back.'
              : decision
                ? `Selection recorded · ${String(decision.status).replaceAll('_', ' ')}. Publication is not confirmed.`
                : 'Nothing from this run has been selected or published.'}
          </p>
          {decision?.error && <p role="alert">{decision.error}</p>}
          <dl className="evidence-fields">
            <div>
              <dt>Selected in this run</dt>
              <dd>
                <code>{short(decision?.target?.commit)}</code>
              </dd>
            </div>
            <div>
              <dt>Current repository publication</dt>
              <dd>
                <code>{short(snapshot.repository.published_commit)}</code>
              </dd>
            </div>
          </dl>
        </article>
      </li>
    </ol>
  );
}
