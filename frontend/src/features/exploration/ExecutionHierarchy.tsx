import { Bot } from 'lucide-react';
import type { Snapshot } from '../../lib/types';
import { modelDisplayName } from '../workspace/providerModels';
import { executionFailureCode, providerFailureNotice } from './providerFailure';

type Execution = Record<string, any>;

export function executionStatus(execution: Execution, candidate?: Record<string, any>): string {
  if (['cancelled', 'failed'].includes(execution.status)) return execution.status;
  return candidate?.status ?? execution.status ?? 'queued';
}

export function ExecutionHierarchy({
  snapshot,
  run,
  onInspect,
}: {
  snapshot: Snapshot;
  run: Execution;
  onInspect: (id: string) => void;
}) {
  const executions = snapshot.executions.filter(
    (execution) => execution.run_id === run.id && execution.role === 'coding',
  );
  const queued = executions.filter((execution) => execution.status === 'queued').length;
  const running = executions.filter((execution) => execution.status === 'running').length;
  return (
    <section className="execution-hierarchy" aria-labelledby="execution-hierarchy-heading">
      <div className="execution-heading">
        <div>
          <h2 id="execution-hierarchy-heading">Agent activity</h2>
          <p>
            {executions.length} agent{executions.length === 1 ? '' : 's'}
          </p>
        </div>
        <span className="execution-capacity">
          {running} running · {queued} queued
        </span>
      </div>
      <p className="subtle">
        Queued agents wait for capacity. Every agent has an isolated workspace and its own captured,
        independently checked approach.
      </p>
      {!executions.length ? (
        <p className="inline-empty" role="status">
          {run.status === 'cancelled'
            ? 'This run was cancelled before coding agents were scheduled.'
            : 'No coding agents have been scheduled yet. Their activity will appear here.'}
        </p>
      ) : (
        <ol className="execution-list" aria-label="Agents">
          {executions.map((execution) => {
            const candidate = snapshot.candidates.find((value) => value.execution === execution.id);
            const status = executionStatus(execution, candidate);
            return (
              <li key={execution.id} className="execution-row">
                <span className="execution-icon" aria-hidden="true">
                  <Bot size={17} />
                </span>
                <div className="execution-detail">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onInspect(execution.id)}
                  >
                    {execution.strategy || execution.task || 'Independent approach'}
                  </button>
                  {execution.model && (
                    <small>{modelDisplayName(execution.provider, execution.model)}</small>
                  )}
                  {execution.task && <p>{execution.task}</p>}
                  {execution.status === 'failed' && (
                    <p className="execution-error">
                      {providerFailureNotice(execution, executionFailureCode(execution)).title}.
                      Open the approach for failure details.
                    </p>
                  )}
                  {execution.status === 'cancelled' && <p>This agent was cancelled.</p>}
                </div>
                <span className={`status ${status}`}>{status.replaceAll('_', ' ')}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
