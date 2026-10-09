import type { ContextCitation, ContextTarget } from '../../../../shared/context_usage';
import { captureCheckNote, captureLabel } from './contextCaptureView';

export function ContextChain({
  target,
  citations,
  labels,
  execution,
}: {
  target: ContextTarget;
  citations: ContextCitation[];
  labels: Map<string, string>;
  execution?: string | null;
}) {
  const linked = citations.filter(
    (citation) =>
      citation.targets.some((record) => record.id === target.id) &&
      (execution === undefined || citation.execution_id === execution),
  );
  return (
    <div className="context-chain">
      <div className="context-record">
        <strong>{target.label || target.id}</strong>
        <span>
          {target.kind} · {target.authority.replaceAll('_', ' ')}
        </span>
        <code>{target.id}</code>
        {target.digest && (
          <small>
            Content digest <code>{target.digest}</code>
          </small>
        )}
      </div>
      {!linked.length && (
        <p className="context-usage-note">
          No explicit assertion citation for this context and agent is included in this response.
        </p>
      )}
      {linked.map((citation) => (
        <ol
          className="context-lineage"
          key={citation.record_id}
          aria-label="Recorded context lineage"
        >
          <li>
            <strong>Explicit assertion citation</strong>
            <code>{citation.record_id}</code>
            <small>{new Date(citation.at).toLocaleString()} · citation is an assertion</small>
            {citation.targets.find((record) => record.id === target.id)?.relation && (
              <small>
                Explicit relation:{' '}
                {citation.targets.find((record) => record.id === target.id)?.relation}
              </small>
            )}
          </li>
          <li>
            <strong>Agent execution</strong>
            <span>
              {citation.execution_id
                ? (labels.get(citation.execution_id) ?? 'Recorded agent')
                : 'Unattributed session'}
            </span>
            {citation.execution_id && <code>{citation.execution_id}</code>}
            <small>
              {citation.epoch == null ? 'Attempt was not recorded' : `Attempt ${citation.epoch}`}
            </small>
          </li>
          {!citation.candidates.length && (
            <li>
              <strong>Capture pending or unavailable</strong>
              <small>No captured candidate is linked to this citation.</small>
            </li>
          )}
          {citation.candidates.map((candidate) => (
            <li key={candidate.id}>
              <strong>{captureLabel(candidate)}</strong>
              <code>{candidate.id}</code>
              {candidate.capture_job_id && (
                <small>
                  Capture job <code>{candidate.capture_job_id}</code>
                </small>
              )}
              <small>
                Repository <code>{candidate.revision.repository}</code>
              </small>
              <code>{candidate.revision.commit}</code>
              {candidate.source_handoff && (
                <small>
                  Included handoff <code>{candidate.source_handoff}</code>
                </small>
              )}
              {candidate.evaluation ? (
                <div className="context-revision-check">
                  <strong>Independent revision checks</strong>
                  <code>{candidate.evaluation.evaluation_id}</code>
                  <small>
                    Checked revision <code>{candidate.evaluation.revision.commit}</code>
                  </small>
                  <small>
                    Evidence <code>{candidate.evaluation.evidence}</code>
                  </small>
                  <ul>
                    {candidate.evaluation.checks.map((check) => (
                      <li key={check.name}>
                        <span className={`status ${check.status}`}>{check.status}</span>{' '}
                        <strong>{check.name}</strong>
                        <p>{check.detail}</p>
                      </li>
                    ))}
                  </ul>
                  <p className="context-usage-note">
                    These checks apply to this source revision. They do not verify the cited
                    assertion.
                  </p>
                </div>
              ) : (
                <small>{captureCheckNote(candidate, citation.candidates)}</small>
              )}
            </li>
          ))}
        </ol>
      ))}
    </div>
  );
}
