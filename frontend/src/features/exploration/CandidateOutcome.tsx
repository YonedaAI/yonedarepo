import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { frozenInputs } from '../context-usage/frozenContextView';
import { SiteLink } from './SiteLink';
import { runWorkingBranch } from './workingBranchView';

/** Presentation uses recorded statements and exact revision evidence; no generated outcome claims. */
export function CandidateOutcome({
  repo,
  candidate,
  evaluation,
  decision,
  snapshot,
  run,
  onContext,
  onGraph,
}: {
  repo: string;
  candidate: Record<string, any>;
  evaluation?: Record<string, any>;
  decision?: Record<string, any>;
  snapshot: Snapshot;
  run: Record<string, any>;
  onContext: () => void;
  onGraph: () => void;
}) {
  const exact =
    evaluation?.candidate === candidate.id &&
    evaluation?.revision?.commit === candidate.revision?.commit &&
    evaluation?.revision?.repository === candidate.revision?.repository;
  const context = frozenInputs(run);
  const stale = candidate.base?.commit !== snapshot.repository.head_commit;
  const branch = runWorkingBranch(snapshot, run);
  return (
    <>
      <section className="outcome-preview">
        <h3>Outcome preview</h3>
        <p>{candidate.summary || 'No outcome statement was recorded for this captured result.'}</p>
        <small>
          Recorded candidate summary · revision <code>{short(candidate.revision?.commit)}</code>
        </small>
        {exact && (evaluation?.deployment?.digest || evaluation?.app?.bundle_digest) ? (
          <SiteLink repo={repo} evaluation={evaluation.id} />
        ) : (
          <p className="subtle">
            No checked website preview is recorded for this revision. Captured source is available
            below.
          </p>
        )}
      </section>
      <section className="outcome-checks">
        <h3>Behavior checks</h3>
        {exact ? (
          <>
            <p className="subtle">
              Independent checks apply to this captured revision and its recorded policy.
            </p>
            <ul>
              {(evaluation?.checks ?? []).map((check: Record<string, string>) => (
                <li key={check.name}>
                  <strong>{check.name.replaceAll('_', ' ')}</strong>{' '}
                  <span className={`status ${check.status}`}>{check.status}</span>
                  <p>{check.detail || 'No check detail was recorded.'}</p>
                </li>
              ))}
            </ul>
            {!evaluation?.checks?.length && (
              <p>No individual behavior checks are included in this report.</p>
            )}
          </>
        ) : (
          <p>Independent checks for this exact revision are pending or unavailable.</p>
        )}
      </section>
      <section className="outcome-story">
        <h3>Decision and context</h3>
        <p>{decision?.rationale || 'A publishing rationale has not been recorded for this run.'}</p>
        <p>
          {context.ids.length
            ? `${context.ids.length} prior context record${context.ids.length === 1 ? ' was' : 's were'} frozen into the initial input.`
            : 'No prior context records were frozen into the initial input.'}{' '}
          Recorded access and citations can be inspected separately.
        </p>
        {candidate.conflict_id && (
          <p>
            Recorded conflict: <code>{candidate.conflict_id}</code>.
          </p>
        )}
        {candidate.refresh_of && (
          <p>
            Refreshed from candidate <code>{candidate.refresh_of}</code>; review this revision’s
            fresh checks.
          </p>
        )}
        <p>
          {run.working_branch_id
            ? branch?.latest_candidate_id === candidate.id
              ? `This checked result is the working head of ${run.working_branch_id}. Canonical publication remains a separate decision.`
              : `This result belongs to working branch ${run.working_branch_id}; its current head must be reviewed separately.`
            : stale
              ? `The canonical source moved from this result’s base ${short(candidate.base?.commit)} to ${short(snapshot.repository.head_commit)}.`
              : `This result’s base matches the current canonical source ${short(candidate.base?.commit)}.`}
        </p>
        <div className="outcome-drilldown">
          <button type="button" className="text-button" onClick={onContext}>
            Read prior context and citations
          </button>
          <button type="button" className="text-button" onClick={onGraph}>
            Inspect evidence graph
          </button>
        </div>
      </section>
    </>
  );
}
