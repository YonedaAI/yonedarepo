import { short } from '../../lib/api';
import type { PublishedRun } from './publishedRun';

export function PublishedRunNotice({
  publication,
  contextTotal,
}: {
  publication?: PublishedRun;
  contextTotal: number;
}) {
  if (!publication) {
    return (
      <p className="restart-notice">
        The previous approval details are unavailable. Your agent will preserve the current source
        and design. Choose a connection and review the approach before starting.
      </p>
    );
  }
  return (
    <aside className="published-run-notice" aria-label="Published base">
      <strong>Continuing your published work</strong>
      <p>{publication.run.intent}</p>
      <p className="subtle">
        Revision <code>{short(publication.decision.target.commit)}</code>
        {publication.execution?.model && <> · {publication.execution.model}</>}
        {' · '}
        {Math.min(contextTotal, 50)} context records carried forward
      </p>
      <details>
        <summary>Published approach and decision</summary>
        <p>{publication.execution?.strategy ?? 'No hosted agent approach was recorded.'}</p>
        <p>{publication.decision.rationale}</p>
      </details>
      <p>
        {publication.execution?.model
          ? 'The winning approach, criteria and model limits are prefilled for review.'
          : 'The published brief, criteria and context are prefilled. Choose a provider for this update; no hosted model was recorded.'}{' '}
        Edit the settings below or add agents to compare alternatives. Current repository checks
        apply.
      </p>
      {contextTotal > 50 && (
        <p>
          Selected the first 50 related records, prioritizing the decision and artifacts. Review the
          selection in Reuse existing context.
        </p>
      )}
    </aside>
  );
}
