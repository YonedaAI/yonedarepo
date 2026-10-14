import type { SourcePreparation, SourceWorkflowStage } from '../../lib/sourceWorkspace';

/** Transport/schema mapping stays in the owner adapter. Missing metadata never implies ready. */
export function preparationView(
  transport: string | undefined,
  state: SourcePreparation | undefined,
  stage: SourceWorkflowStage,
) {
  if (transport !== 'api-source-v1') return null;
  if (stage === 'cancelled')
    return {
      stage: 'cancelled',
      title: 'Run cancelled',
      detail: 'Recorded source and checks remain available.',
      error: false,
    };
  if (state?.status === 'failed')
    return {
      stage: 'failed',
      title: 'Source preparation stopped',
      error: true,
      detail:
        state.reason === 'source_changed'
          ? 'The approved source changed. Refresh its status before continuing.'
          : state.reason === 'access_denied'
            ? 'This source is unavailable to this run. Refresh the workspace to review its access.'
            : 'Source preparation is temporarily unavailable. Refresh its status to see what happened.',
    };
  if (state?.version !== 1 || state.status !== 'ready')
    return {
      stage: 'preparing',
      title: 'Preparing source',
      detail: 'Getting the approved source ready for your agents.',
      error: false,
    };
  const labels = {
    waiting: 'Waiting for agents',
    working: 'Agent working',
    checking: 'Checking the result',
    review: 'Ready for human review',
  };
  return {
    stage,
    title: labels[stage],
    error: false,
    detail:
      stage === 'review'
        ? 'Inspect the exact source, checks and recorded reasons before choosing what to publish.'
        : stage === 'checking'
          ? 'Independent checks are running on the captured result.'
          : 'Your approved source is ready. Source changes and publication remain separate.',
  };
}
