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
export function automaticAgent(): AdaptiveAgentDraft {
  return { id: crypto.randomUUID(), connection: '', role: 'auto', strategy: 'Team participant' };
}
/** Preferences only: the server resolves eligible models and enforces workspace limits. */
export function requestedAgents(agents: AdaptiveAgentDraft[]) {
  return agents.map((agent) => ({
    connection: agent.connection || null,
    role: agent.role ?? 'auto',
  }));
}
