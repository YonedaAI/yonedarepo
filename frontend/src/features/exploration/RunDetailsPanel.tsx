import type { Snapshot } from '../../lib/types';
import { PublishedSourceViewer } from '../source-workspace/PublishedSourceViewer';
import { ModelBudgetUsage } from './ModelBudgetUsage';
import { RunBrief } from './RunBrief';
import { RunControls } from './RunControls';
import { RunWorkflow } from './RunWorkflow';
import { runDeleteBlocker } from './runControlState';

/** Run controls, brief, recorded workflow and decision for the Details tab. */
export function RunDetailsPanel({
  reviewer,
  snapshot,
  run,
  busy,
  canStart,
  activeAttempts,
  hasRoots,
  onRestart,
  onCancel,
  onDelete,
}: {
  reviewer: boolean;
  snapshot: Snapshot;
  run: Record<string, any>;
  busy: boolean;
  canStart: boolean;
  activeAttempts: boolean;
  hasRoots: boolean;
  onRestart: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  return (
    <>
      <div className="run-detail-controls">
        <div>
          <h3>Run controls</h3>
          <p>
            Recorded status: {run.status.replaceAll('_', ' ')}
            {reviewer
              ? '.'
              : activeAttempts
                ? '. Finish or cancel active work before restarting.'
                : '. Restart opens a new attempt with these settings.'}
          </p>
        </div>
        <RunControls
          reviewer={reviewer}
          run={run}
          busy={busy}
          canStart={canStart}
          activeAttempts={activeAttempts}
          hasRoots={hasRoots}
          supportsRestart={snapshot.capabilities?.model_budgets === 1}
          onRestart={onRestart}
          onCancel={onCancel}
          deleteBlocker={runDeleteBlocker(snapshot, run)}
          onDelete={onDelete}
        />
      </div>
      <RunBrief intent={run.intent} criteria={run.criteria} />
      <RunWorkflow snapshot={snapshot} run={run} />
      <PublishedSourceViewer snapshot={snapshot} runId={run.id} />
      <p className="subtle">
        Independent evaluator: {snapshot.repository.policy?.suite ?? 'configured policy'}
      </p>
      <ModelBudgetUsage run={run} />
    </>
  );
}
