import { modelReasoningEfforts } from '../workspace/providerModels';
import type { AgentDraft } from './agentLimits';

export const agentRoles = [
  'auto',
  'builder',
  'frontend',
  'backend',
  'design',
  'testing',
  'review',
] as const;
export type AgentRole = (typeof agentRoles)[number];
export interface AdaptiveAgentDraft extends AgentDraft {
  role?: AgentRole;
}
type ModelConnection = { id: string; provider: string; model: string };
export function reasoningIssue(agent: AdaptiveAgentDraft, connections: ModelConnection[]) {
  if (agent.reasoning_effort == null) return '';
  const connection = connections.find((value) => value.id === agent.connection);
  return connection &&
    modelReasoningEfforts(connection.provider, connection.model).includes(agent.reasoning_effort)
    ? ''
    : 'This reasoning setting is unavailable for the selected model. Choose Auto or a supported setting.';
}
export function automaticAgent(): AdaptiveAgentDraft {
  return { id: crypto.randomUUID(), connection: '', role: 'auto', strategy: 'Team participant' };
}
/** Preferences only: the server resolves eligible models and enforces workspace limits. */
export function requestedAgents(agents: AdaptiveAgentDraft[], connections: ModelConnection[] = []) {
  return agents.map((agent) => {
    const issue = reasoningIssue(agent, connections);
    if (issue) throw new Error(issue);
    return {
      connection: agent.connection || null,
      role: agent.role ?? 'auto',
      ...(agent.reasoning_effort != null ? { reasoning_effort: agent.reasoning_effort } : {}),
    };
  });
}
