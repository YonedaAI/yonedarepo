import type { Snapshot } from '../../lib/types';
import type { AgentDraft } from '../exploration/agentLimits';

/** Frozen roster preserves blocked roles which have not produced an execution yet. */
export function teamAgents(snapshot: Snapshot, run: Record<string, any>): AgentDraft[] {
  const roster: Record<string, any>[] = Array.isArray(run.agents)
    ? run.agents
    : snapshot.executions.filter(
        (execution) =>
          execution.run_id === run.id && execution.role === 'coding' && !execution.parent_execution,
      );
  return roster.map((agent) => ({
    id: crypto.randomUUID(),
    connection: agent.connection ?? '',
    strategy: agent.strategy ?? '',
    expectedProvider: agent.provider,
    expectedModel: agent.model,
    fromPreviousRun: true,
  }));
}
