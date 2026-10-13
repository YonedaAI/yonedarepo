import { short } from '../../lib/api';
import type { PublishedRun } from './publishedRun';
import { RecordedDecisionStory } from './RecordedDecisionStory';

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
        Previous approval details are unavailable. The current source is your starting point.
        Describe the next change before starting.
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
        <summary>
          Published {publication.run.mode === 'collaborate' ? 'team result' : 'approach'} and
          decision
        </summary>
        <p>{publication.execution?.strategy ?? 'No hosted agent approach was recorded.'}</p>
        <RecordedDecisionStory decision={publication.decision} />
      </details>
      <p>
        Published source, criteria and relevant context carry forward. Describe the next change;
        YonedaRepo plans a new team within your workspace allowance. Current repository checks
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
