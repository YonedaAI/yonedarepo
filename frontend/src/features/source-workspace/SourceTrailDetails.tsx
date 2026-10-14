import type {
  SourceContextLink,
  SourceFileTrail,
  SourceSelection,
} from '../../lib/sourceWorkspace';

export function SourceTrailDetails({
  trail,
  onInspectContext,
  onInspectRevision,
}: {
  trail: SourceFileTrail;
  onInspectContext?: (link: SourceContextLink) => void;
  onInspectRevision?: (source: SourceSelection) => void;
}) {
  return (
    <>
      {trail.coverage === 'unknown' && (
        <p>
          File attribution is unavailable for this version. Available context references appear
          below.
        </p>
      )}
      <h4>Recorded reasons</h4>
      {trail.reasons?.length ? (
        <ul>
          {trail.reasons.map((reason) => (
            <li key={`${reason.authority}:${reason.id}`}>
              <p>{reason.text}</p>
              <small>
                {reason.authority === 'agent_assertion'
                  ? 'Agent assertion'
                  : 'Recorded owner decision'}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p>{trail.explanation ?? 'No explanation was recorded for this file.'}</p>
      )}
      <h4>Checks for this version</h4>
      {trail.checks.length ? (
        <>
          <ul>
            {trail.checks.map((check) => (
              <li key={check.name}>
                {check.name} · {check.status}
              </li>
            ))}
          </ul>
          {trail.evaluation && (
            <details>
              <summary>Exact historical check receipt</summary>
              <p>
                Recorded evaluation <code>{trail.evaluation.id}</code> · policy{' '}
                <code>{trail.evaluation.policy_version}</code>
              </p>
              <p>
                Suite {trail.evaluation.suite} · environment {trail.evaluation.environment}
              </p>
              <p>
                Report <code>{trail.evaluation.evidence_digest}</code>
              </p>
              <p>Historical checks for the recorded revision and policy.</p>
            </details>
          )}
        </>
      ) : (
        <p>No check receipts were supplied for this version.</p>
      )}
      <h4>Recorded risks</h4>
      {trail.risks.length ? (
        <ul>
          {trail.risks.map((risk, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Immutable recorded risks can repeat and have no item state.
            <li key={`${index}:${risk}`}>{risk}</li>
          ))}
        </ul>
      ) : (
        <p>No risks were recorded.</p>
      )}
      <h4>Source history</h4>
      {!!trail.capture_receipts?.length && (
        <ul>
          {trail.capture_receipts.map((receipt) => (
            <li key={receipt.id}>
              {receipt.change} <code>{receipt.path}</code> · <code>{receipt.commit}</code>
              {receipt.capture_epoch != null && (
                <small>Capture attempt {receipt.capture_epoch}</small>
              )}
            </li>
          ))}
        </ul>
      )}
      {trail.revisions.map((item) => (
        <button
          key={JSON.stringify(item.selection)}
          type="button"
          className="text-button"
          disabled={!onInspectRevision}
          onClick={() => onInspectRevision?.(item.selection)}
        >
          {item.label} ·{' '}
          {item.selection.kind === 'proposed'
            ? `version ${item.selection.workspace_version}`
            : item.selection.revision.commit}
        </button>
      ))}
      <h4>Prior context</h4>
      {trail.context.length ? (
        <ul>
          {trail.context.map((link) => (
            <li key={`${link.id}:${link.record_version}`}>
              <button
                type="button"
                className="text-button"
                disabled={!onInspectContext}
                onClick={() => onInspectContext?.(link)}
              >
                {link.label}
              </button>
              <small>
                {link.record_version == null
                  ? 'Record version unavailable; inspect current context separately.'
                  : `Recorded version ${link.record_version}`}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p>No prior context references were supplied for this file.</p>
      )}
      <p className="subtle">
        Context history records which references were delivered, opened or cited.
      </p>
    </>
  );
}
