import { Check, GitCommitHorizontal, LoaderCircle, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { ChangedPathList } from '../source-workspace/ChangedPathList';
import { capturedPathCount, capturedPathRef } from '../source-workspace/sourcePathCount';
import { modelDisplayName } from '../workspace/providerModels';
import { CandidateOutcome } from './CandidateOutcome';
import { ExecutionFailure } from './ExecutionFailure';
import { executionStatus } from './ExecutionHierarchy';
import { ExecutionLogs } from './ExecutionLogs';
import { LazyCandidateDiff } from './LazyCandidateDiff';

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
  snapshot,
  run,
  onContext,
  onGraph,
  team = false,
  showPublishAction = true,
  actionLabel = 'Record publishing decision',
  assessment,
  compact = false,
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
  snapshot: Snapshot;
  run: Record<string, any>;
  onContext: () => void;
  onGraph: () => void;
  team?: boolean;
  showPublishAction?: boolean;
  actionLabel?: string;
  assessment?: ReactNode;
  compact?: boolean;
}) {
  const chosen = !!candidate && decision?.target?.commit === candidate.revision.commit;
  const published = chosen && decision?.status === 'published';
  const pathCount = capturedPathCount(candidate);
  const pathRef = capturedPathRef(candidate);
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
        <span>
          {execution?.model
            ? modelDisplayName(execution.provider, execution.model)
            : execution?.harness}
        </span>
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
        {!candidate && (
          <p>
            {status === 'failed'
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
                    : 'Waiting for an agent.'}
          </p>
        )}
        {candidate && (
          <CandidateOutcome
            repo={repo}
            candidate={candidate}
            evaluation={evaluation}
            decision={decision}
            snapshot={snapshot}
            run={run}
            onContext={onContext}
            onGraph={onGraph}
            assessment={assessment}
            compact={compact}
          />
        )}
        {candidate && (
          <div className="candidate-action-row">
            {!decision && showPublishAction && (
              <button
                type="button"
                className="quiet candidate-review"
                disabled={disabled}
                onClick={onSelect}
              >
                {actionLabel}
              </button>
            )}
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
                {pathCount == null
                  ? 'Path count unavailable'
                  : `${pathCount} ${pathCount === 1 ? 'path' : 'paths'}`}
              </span>
            </div>
            {pathRef && snapshot.capabilities?.source_api === 1 && (
              <ChangedPathList
                key={`${candidate.id}:${pathRef.id}:${pathRef.digest}`}
                repo={repo}
                candidateId={candidate.id}
                pathRef={pathRef}
              />
            )}
            <LazyCandidateDiff
              key={candidate.id}
              repo={repo}
              candidate={candidate}
              sourceApi={snapshot.capabilities?.source_api}
              evaluation={evaluation}
            />
          </>
        )}
      </div>
    </article>
  );
}
