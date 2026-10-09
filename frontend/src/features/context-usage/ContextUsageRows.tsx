import type { ContextUsage } from '../../../../shared/context_usage';
import { ContextChain } from './ContextChain';

export function ContextUsageRows({
  data,
  labels,
}: {
  data: ContextUsage;
  labels: Map<string, string>;
}) {
  return (
    <>
      <h3>Recorded retrieval calls</h3>
      <p className="context-usage-note">
        Chronological events on this page. A returned or opened record is delivery evidence, not
        proof of reasoning.
      </p>
      {!data.entries.length ? (
        <p className="context-usage-empty">
          {data.coverage.status === 'recorded'
            ? 'No retrieval calls are recorded for these filters yet.'
            : 'No retrieval calls were recorded for these filters. Earlier access may be untracked.'}
        </p>
      ) : (
        <ol className="context-usage-rows">
          {data.entries.map((entry) => (
            <li key={entry.seq}>
              <details>
                <summary>
                  <time dateTime={new Date(entry.at).toISOString()}>
                    {new Date(entry.at).toLocaleTimeString()}
                  </time>
                  <strong>
                    {entry.stage === 'returned' ? 'Returned' : 'Opened'} {entry.targets.length}{' '}
                    record{entry.targets.length === 1 ? '' : 's'}
                  </strong>
                  <span>
                    {entry.execution_id
                      ? (labels.get(entry.execution_id) ?? 'Recorded agent')
                      : 'Remote session'}{' '}
                    · {entry.epoch == null ? 'attempt unrecorded' : `attempt ${entry.epoch}`}
                  </span>
                </summary>
                <div className="context-call-meta">
                  <span>
                    Tool <code>{entry.tool}</code> · Event {entry.seq}
                  </span>
                  <span>
                    Call <code>{entry.call_id}</code>
                  </span>
                  {entry.job_id && (
                    <span>
                      Job <code>{entry.job_id}</code>
                    </span>
                  )}
                  {entry.session_id && (
                    <span>
                      Scoped session <code>{entry.session_id}</code>
                    </span>
                  )}
                </div>
                {entry.targets.map((target) => (
                  <ContextChain
                    key={target.id}
                    target={target}
                    citations={data.citations}
                    execution={entry.execution_id}
                    labels={labels}
                  />
                ))}
              </details>
            </li>
          ))}
        </ol>
      )}
      <details className="context-lineage-group">
        <summary>Frozen assigned context</summary>
        <p className="context-usage-note">
          Run-wide assignments. Assigned input does not mean an agent opened or cited it.
        </p>
        {!data.assigned.length && <p>No frozen context assignments are recorded.</p>}
        {data.assigned.map((assignment) => (
          <section key={assignment.execution_id}>
            <h4>{labels.get(assignment.execution_id) ?? assignment.execution_id}</h4>
            {!assignment.targets.length && (
              <p>No context records were assigned to this execution.</p>
            )}
            {assignment.targets.map((target) => (
              <ContextChain
                key={target.id}
                target={target}
                citations={data.citations}
                execution={assignment.execution_id}
                labels={labels}
              />
            ))}
          </section>
        ))}
      </details>
      <details className="context-lineage-group">
        <summary>Explicit assertion citations · {data.citations.length} recorded</summary>
        <p className="context-usage-note">
          Run-wide citations and their capture lineage, including citations without a retrieval
          event on this page.
        </p>
        {data.citations_truncated && (
          <p className="context-usage-note" role="status">
            This response includes the first 1,000 citation records. The counts above still cover
            the whole run; a missing lineage here may be outside this response.
          </p>
        )}
        {!data.citations.length && (
          <p>No explicit assertion citations are included in this response.</p>
        )}
        {[...data.citations]
          .sort((a, b) => a.at - b.at)
          .map((citation) => (
            <section key={citation.record_id}>
              {citation.targets.map((target) => (
                <ContextChain
                  key={target.id}
                  target={target}
                  citations={[citation]}
                  labels={labels}
                />
              ))}
            </section>
          ))}
      </details>
      <details className="context-lineage-group">
        <summary>Exact revision checks · {data.checked.length} recorded</summary>
        <p className="context-usage-note">
          Run-wide checks. Checking source does not turn agent context into verified knowledge.
        </p>
        {!data.checked.length && (
          <p>No independently checked revision is recorded for this run yet.</p>
        )}
        {data.checked.map((check) => (
          <div className="context-call-meta" key={check.candidate_id}>
            <strong>{labels.get(check.execution_id) ?? check.execution_id}</strong>
            <span>
              Candidate <code>{check.candidate_id}</code>
            </span>
            <span>
              Repository <code>{check.revision.repository}</code>
            </span>
            <span>
              Revision <code>{check.revision.commit}</code>
            </span>
            <span>
              Evaluation <code>{check.evaluation_id}</code>
            </span>
            <span>
              Evidence <code>{check.evidence}</code>
            </span>
            <ul>
              {check.checks.map((result) => (
                <li key={result.name}>
                  <span className={`status ${result.status}`}>{result.status}</span>{' '}
                  <strong>{result.name}</strong>
                  <p>{result.detail}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </details>
    </>
  );
}
