import { Bot, CornerDownRight } from 'lucide-react';
import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { executionFailureCode, providerFailureNotice } from './providerFailure';

type Execution = Record<string, any>;

export function executionStatus(execution: Execution, candidate?: Record<string, any>): string {
  if (['cancelled', 'failed'].includes(execution.status)) return execution.status;
  return candidate?.status ?? execution.status ?? 'queued';
}

function orderedExecutions(executions: Execution[]) {
  const byId = new Map(executions.map((execution) => [execution.id, execution]));
  const children = new Map<string, Execution[]>();
  for (const execution of executions) {
    if (!execution.parent_execution) continue;
    const siblings = children.get(execution.parent_execution) ?? [];
    siblings.push(execution);
    children.set(execution.parent_execution, siblings);
  }
  const seen = new Set<string>();
  const ordered: { execution: Execution; depth: number }[] = [];
  function visit(execution: Execution, depth: number) {
    if (seen.has(execution.id)) return;
    seen.add(execution.id);
    ordered.push({ execution, depth });
    for (const child of children.get(execution.id) ?? []) visit(child, depth + 1);
  }
  for (const execution of executions) {
    if (!execution.parent_execution || !byId.has(execution.parent_execution)) visit(execution, 0);
  }
  // Preserve visibility if a partial snapshot has disconnected or malformed lineage.
  for (const execution of executions) visit(execution, 0);
  return { ordered, byId };
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
  const roots = executions.filter((execution) => !execution.parent_execution).length;
  const subagents = executions.length - roots;
  const queued = executions.filter((execution) => execution.status === 'queued').length;
  const running = executions.filter((execution) => execution.status === 'running').length;
  const { ordered, byId } = orderedExecutions(executions);
  return (
    <section className="execution-hierarchy" aria-labelledby="execution-hierarchy-heading">
      <div className="execution-heading">
        <div>
          <h2 id="execution-hierarchy-heading">Agent activity</h2>
          <p>
            {roots} root agent{roots === 1 ? '' : 's'} · {subagents} subagent
            {subagents === 1 ? '' : 's'}
            {run.delegation?.enabled && ` · up to ${run.delegation.max_executions} total`}
          </p>
        </div>
        <span className="execution-capacity">
          {running} running · {queued} queued
        </span>
      </div>
      <p className="subtle">
        Queued agents wait for capacity. Every root and subagent has an isolated workspace and its
        own captured, independently checked approach.
      </p>
      {!executions.length ? (
        <p className="inline-empty" role="status">
          {run.status === 'cancelled'
            ? 'This run was cancelled before coding agents were scheduled.'
            : 'No coding agents have been scheduled yet. Their activity will appear here.'}
        </p>
      ) : (
        <ol className="execution-list" aria-label="Agents grouped by parent">
          {ordered.map(({ execution, depth }) => {
            const candidate = snapshot.candidates.find((value) => value.execution === execution.id);
            const parent = byId.get(execution.parent_execution);
            const status = executionStatus(execution, candidate);
            return (
              <li
                key={execution.id}
                className={`execution-row execution-depth-${Math.min(depth, 2)}`}
              >
                <span className="execution-icon" aria-hidden="true">
                  {execution.parent_execution ? <CornerDownRight size={17} /> : <Bot size={17} />}
                </span>
                <div className="execution-detail">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onInspect(execution.id)}
                  >
                    {execution.strategy || execution.task || 'Independent approach'}
                  </button>
                  <small>
                    {execution.parent_execution
                      ? `Subagent · delegated by ${parent?.strategy || short(execution.parent_execution)}`
                      : 'Root agent'}
                    {execution.model && ` · ${execution.model}`}
                  </small>
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
