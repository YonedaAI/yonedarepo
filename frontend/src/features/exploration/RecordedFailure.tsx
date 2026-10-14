import { executionFailureCode, providerFailureNotice } from './providerFailure';

/** A bounded technical fold preserves the record without making raw runtime JSON product copy. */
export function RecordedFailure({
  error,
  stage,
  jobId,
  epoch,
  provider,
}: {
  error: unknown;
  stage?: unknown;
  jobId?: unknown;
  epoch?: unknown;
  provider?: string;
}) {
  const failure = {
    status: 'failed',
    failure_stage: stage,
    failure_job_id: jobId,
    failure_job_epoch: epoch,
    provider,
    error,
  };
  const notice = providerFailureNotice(failure, executionFailureCode(failure));
  let technical = '';
  try {
    technical = (typeof error === 'string' ? error : JSON.stringify(error))?.slice(0, 8192) ?? '';
  } catch {
    technical = 'Technical details are unavailable.';
  }
  return (
    <div className="recorded-failure">
      <strong>{notice.title}</strong>
      <p>{notice.action}</p>
      {technical && (
        <details>
          <summary>Technical error details</summary>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{technical}</pre>
        </details>
      )}
    </div>
  );
}
