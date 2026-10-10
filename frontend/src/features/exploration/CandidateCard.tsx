import { Check, GitCommitHorizontal, LoaderCircle, X } from 'lucide-react';
import { short } from '../../lib/api';
import { ExecutionFailure } from './ExecutionFailure';
import { executionStatus } from './ExecutionHierarchy';
import { ExecutionLogs } from './ExecutionLogs';
import { LazyCandidateDiff } from './LazyCandidateDiff';
import { SiteLink } from './SiteLink';

const descriptions: Record<string, string> = {
  minimal: 'Aim for the smallest coherent change.',
  defensive: 'Focus on failure paths and boundary handling.',
  maintainable: 'Favor clear structure and future changes.',
};
export function CandidateCard({
  strategy,
  repo,
  execution,
  candidate,
  evaluation,
  decision,
  selected,
  disabled,
  disabledReason,
  onSelect,
  onProviders,
  team = false,
}: {
  strategy: string;
  repo: string;
  execution?: Record<string, any>;
  candidate?: Record<string, any>;
  evaluation?: Record<string, any>;
  decision?: Record<string, any>;
  selected: boolean;
  disabled: boolean;
  disabledReason?: string;
  onSelect: () => void;
  onProviders?: () => void;
  team?: boolean;
}) {
  const chosen = !!candidate && decision?.target?.commit === candidate.revision.commit;
  const published = chosen && decision?.status === 'published';
  const status = execution
    ? executionStatus(execution, candidate)
    : (candidate?.status ?? 'waiting');
  return (
    <article
      className={`candidate ${selected ? 'focused' : ''}`}
      id={execution ? `approach-${execution.id}` : undefined}
      tabIndex={-1}
    >
      <div className="candidate-title">
        <span className="strategy-mark" />
        <h2>{strategy}</h2>
        <span>{execution?.model ?? execution?.harness}</span>
      </div>
      <div className="candidate-content">
        {execution?.parent_execution && (
          <p className="strategy-description">Delegated subagent · level {execution.depth ?? 1}</p>
        )}
        {descriptions[strategy] && <p className="strategy-description">{descriptions[strategy]}</p>}
        <span className={`status ${status}`}>
          {status === 'eligible' ? (
            <Check size={13} />
          ) : status === 'rejected' || status === 'failed' ? (
            <X size={13} />
          ) : ['running', 'capturing', 'evaluating'].includes(status) ? (
            <LoaderCircle className="spin" size={13} />
          ) : null}
          {published ? 'published' : chosen ? 'selected' : status.replaceAll('_', ' ')}
        </span>
        {(!team || candidate?.summary !== 'Integrate the team result approach') && (
          <p>
            {candidate?.summary ??
              (status === 'failed'
                ? team
                  ? 'Integration stopped before producing a complete result.'
                  : 'This agent stopped before completing its approach.'
                : status === 'cancelled'
                  ? 'This agent was cancelled and will not continue.'
                  : status === 'queued'
                    ? 'Queued for an available execution slot.'
                    : execution
                      ? team
                        ? 'Combining exact captured worker outputs under the approved shared contract.'
                        : 'Working from the approved brief and frozen context.'
                      : 'Waiting for an agent.')}
          </p>
        )}
        {candidate && (
          <div className="candidate-action-row">
            {!decision && (
              <button
                type="button"
                className="quiet candidate-review"
                disabled={disabled}
                onClick={onSelect}
              >
                {team ? 'Review result' : 'Review approach'}
              </button>
            )}
            {evaluation?.deployment?.digest && <SiteLink repo={repo} evaluation={evaluation.id} />}
            {execution && (
              <ExecutionLogs repo={repo} execution={execution} onProviders={onProviders} />
            )}
          </div>
        )}
        {candidate && !decision && disabledReason && (
          <p className="selection-blocker">{disabledReason}</p>
        )}
        {execution?.status === 'failed' && (
          <ExecutionFailure
            key={`${repo}:${execution.id}:${execution.transcript ?? ''}`}
            repo={repo}
            execution={execution}
            onProviders={onProviders}
          />
        )}
        {execution && !candidate && (
          <ExecutionLogs repo={repo} execution={execution} onProviders={onProviders} />
        )}
        {candidate && (
          <>
            <div className="revision">
              <GitCommitHorizontal size={15} />
              <code>{short(candidate.revision.commit)}</code>
              <span>
                {candidate.paths.length} {candidate.paths.length === 1 ? 'path' : 'paths'}
              </span>
            </div>
            <div className="checks">
              {evaluation?.checks.map((check: Record<string, string>) => (
                <span key={check.name} className={check.status} title={check.detail}>
                  {check.status === 'pass' ? <Check size={12} /> : <X size={12} />}{' '}
                  {check.name.replaceAll('_', ' ')}
                </span>
              ))}
              {!evaluation && <span>Independent checks pending</span>}
            </div>
            <details>
              <summary>Check details</summary>
              {evaluation ? (
                evaluation.checks.map((check: Record<string, string>) => (
                  <p key={check.name}>
                    <strong>
                      {check.name}: {check.status}
                    </strong>
                    <br />
                    {check.detail}
                  </p>
                ))
              ) : (
                <p>Waiting for independent verification of this captured revision.</p>
              )}
            </details>
            <LazyCandidateDiff key={candidate.id} repo={repo} candidate={candidate} />
          </>
        )}
      </div>
    </article>
  );
}
