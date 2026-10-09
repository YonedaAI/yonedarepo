import { useEffect, useRef, useState } from 'react';
import {
  executionFailureCode,
  inspectExecutionFailure,
  type ProviderFailureCode,
  providerFailureNotice,
} from './providerFailure';

export function ExecutionFailure({
  repo,
  execution,
  onProviders,
}: {
  repo: string;
  execution: Record<string, any>;
  onProviders?: () => void;
}) {
  const [diagnosis, setDiagnosis] = useState<ProviderFailureCode>();
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const code = executionFailureCode(execution) ?? diagnosis;
  const budgetReached = ['MODEL_REQUEST_LIMIT', 'MODEL_SPEND_LIMIT', 'HARNESS_BUDGET'].includes(
    code ?? '',
  );
  const notice = providerFailureNotice(execution, code);
  const transcript = typeof execution.transcript === 'string' ? execution.transcript : '';
  async function explain() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const result = await inspectExecutionFailure(repo, transcript, controller.signal);
      if (controller.signal.aborted) return;
      setDiagnosis(result);
      setChecked(true);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(
        failure instanceof Error && failure.message === 'too_large'
          ? 'The recorded log exceeds the browser diagnosis limit.'
          : 'Could not read this execution’s recorded outcome. Check your connection and try again.',
      );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  return (
    <section className="execution-failure" aria-label="Execution failure details">
      <strong>{notice.title}</strong>
      <p>{notice.action}</p>
      {!code && checked && (
        <p>The recorded outcome does not identify a supported provider error.</p>
      )}
      {!code && !transcript && (
        <p>No execution log is attached. Review the connection before starting another run.</p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="execution-failure-actions">
        {!code && transcript && (!checked || error) && (
          <button type="button" className="quiet" disabled={loading} onClick={() => void explain()}>
            {loading ? 'Reading outcome…' : error ? 'Retry explanation' : 'Explain failure'}
          </button>
        )}
        {onProviders && (
          <button type="button" className="quiet" onClick={onProviders}>
            Review provider connections
          </button>
        )}
      </div>
      <small>
        {budgetReached
          ? 'Use Restart run to review your limits and approve another attempt.'
          : 'After updating your connection, use Restart run to approve another attempt.'}
      </small>
    </section>
  );
}
