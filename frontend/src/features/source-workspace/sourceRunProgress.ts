import type { Snapshot } from '../../lib/types';
import { reviewableCandidates } from '../exploration/runReviewState';
import { platformFailureNotice } from '../exploration/workflowFailure';

/** Advisory UI from observed workflow records, never from SourceDO open/sealed state. */
export function runSourceProgress(snapshot: Snapshot, run: Record<string, unknown>) {
  if (run.workspace_transport !== 'api-source-v1') return null;
  const factual = Array.isArray(snapshot.source_preparation);
  const unscopedRun = snapshot.runs.length === 1 ? snapshot.runs[0]?.id : undefined;
  const preparations = (snapshot.source_preparation ?? []).filter(
    (marker) =>
      marker.stage === 'source_preparing' &&
      (marker.run_id === run.id || (marker.run_id == null && unscopedRun === run.id)),
  );
  const pending = preparations.filter((marker) => marker.status === 'pending');
  const failed = preparations.filter((marker) => marker.status === 'failed');
  const started = preparations.filter(
    (marker) =>
      marker.status === 'ready' &&
      typeof marker.runtime_started_at === 'number' &&
      Number.isSafeInteger(marker.runtime_started_at) &&
      marker.runtime_started_at >= 0,
  );
  const executions = snapshot.executions.filter((execution) => execution.run_id === run.id);
  const captureFailed =
    !snapshot.decisions.some(
      (decision) => decision.run_id === run.id && decision.status === 'published',
    ) &&
    executions.some((execution) => platformFailureNotice(execution)?.title === 'Capture failed') &&
    !executions.some(
      (execution) =>
        execution.role === 'coding' &&
        ['queued', 'running', 'capturing', 'evaluating'].includes(execution.status),
    ) &&
    !snapshot.candidates.some((candidate) => candidate.run_id === run.id);
  const view = (stage: string, title: string, detail: string, error = false) => ({
    stage,
    title,
    detail,
    error,
    preparing_jobs: pending.length,
    failed_preparations: failed.length,
  });
  if (run.status === 'cancelled')
    return view('cancelled', 'Run cancelled', 'Recorded source and checks remain available.');
  if (captureFailed && !pending.length)
    return view(
      'capture_failed',
      'Capture failed',
      'Agent work stopped during platform source capture. No checked result was produced. Inspect Agent activity.',
      true,
    );
  if (run.status === 'failed')
    return view(
      'failed',
      'Run stopped',
      'Inspect the recorded failure in Agent activity. Source preparation cannot establish a checked result.',
      true,
    );
  const published = snapshot.decisions.find(
    (decision) => decision.run_id === run.id && decision.status === 'published',
  );
  if (published)
    return view(
      'published',
      'Published source recorded',
      'The owner’s publication and canonical Git readback are recorded.',
    );
  if (pending.length)
    return view(
      'preparing',
      'Preparing source',
      `${pending.length} source preparation${pending.length === 1 ? ' is' : 's are'} pending.${failed.length ? ` ${failed.length} preparation${failed.length === 1 ? ' has' : 's have'} stopped; inspect Agent activity.` : ''} Other agents or checks may already be working. Refresh run status to see progress.`,
      failed.length > 0,
    );
  if (run.status === 'ready')
    return reviewableCandidates(snapshot, run).length
      ? view(
          'review',
          'Ready for human review',
          'Inspect the exact source, current checks and recorded reasons before deciding what to publish.',
        )
      : view(
          'attention',
          'Result needs attention',
          'The current source or required checks do not permit a publishing decision. Inspect the result and refresh its evidence.',
          true,
        );
  if (failed.length)
    return view(
      'attention',
      'Source preparation needs attention',
      `${failed.length} source preparation${failed.length === 1 ? ' has' : 's have'} stopped. Other work may continue. Inspect Agent activity and refresh status.`,
      true,
    );
  if (snapshot.candidates.some((candidate) => candidate.run_id === run.id))
    return view(
      'checking',
      'Checking the result',
      'Captured source is being checked; capture alone does not establish eligibility.',
    );
  if ((typeof run.model_requests === 'number' && run.model_requests > 0) || started.length)
    return view(
      'working',
      'Agent working',
      'Agent work has started. Further tasks may still prepare their own source views.',
    );
  if (factual)
    return view(
      'waiting',
      'Waiting for agents',
      'No pending source preparation or runtime start is recorded for this view. Refresh run status to see progress.',
    );
  return view(
    'preparing',
    'Preparing source',
    'Preparing approved source and agent workspaces. Refresh status to see progress.',
  );
}
