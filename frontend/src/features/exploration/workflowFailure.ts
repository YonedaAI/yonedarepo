/** Failure attribution comes from the failed native job, never text in an error or model output. */
export function platformFailureNotice(execution: Record<string, unknown>) {
  if (
    execution.status !== 'failed' ||
    typeof execution.failure_job_id !== 'string' ||
    !execution.failure_job_id ||
    !Number.isSafeInteger(execution.failure_job_epoch) ||
    Number(execution.failure_job_epoch) < 1
  )
    return undefined;
  if (execution.failure_stage === 'capture')
    return {
      title: 'Capture failed',
      action:
        'The platform could not finish capturing the agent’s source. No checked result was produced by this attempt. Inspect the recorded failure before approving further work.',
    };
  if (execution.failure_stage === 'evaluate')
    return {
      title: 'Check execution failed',
      action:
        'The platform could not complete independent checks. Captured source remains recorded, but this attempt has no completed check verdict.',
    };
  return undefined;
}
