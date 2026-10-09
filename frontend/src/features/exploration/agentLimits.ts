import type { AgentLimits, Snapshot } from '../../lib/types';

const legacyLimits: AgentLimits = {
  min_root_agents: 2,
  max_root_agents: 4,
  max_run_executions: 4,
  max_delegation_depth: 0,
  max_run_model_requests: 0,
};

export function runAgentLimits(snapshot: Snapshot): AgentLimits {
  const limits = snapshot.capabilities?.agent_limits;
  if (
    !limits ||
    ![
      limits.min_root_agents,
      limits.max_root_agents,
      limits.max_run_executions,
      limits.max_delegation_depth,
    ].every((value) => Number.isSafeInteger(value)) ||
    ![1, 2].includes(limits.min_root_agents) ||
    limits.max_root_agents < limits.min_root_agents ||
    limits.max_root_agents > 6 ||
    limits.max_run_executions < limits.max_root_agents ||
    limits.max_run_executions > 12 ||
    limits.max_delegation_depth < 1 ||
    limits.max_delegation_depth > 2 ||
    (limits.max_run_model_requests !== null &&
      (!Number.isSafeInteger(limits.max_run_model_requests) || limits.max_run_model_requests < 1))
  ) {
    return legacyLimits;
  }
  return limits;
}

export interface AgentDraft {
  id: string;
  connection: string;
  strategy: string;
  expectedProvider?: string;
  expectedModel?: string;
  fromPreviousRun?: boolean;
}

export interface DelegationDraft {
  enabled: boolean;
  max_depth: number;
  max_executions: number;
}
