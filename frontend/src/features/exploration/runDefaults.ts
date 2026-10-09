import type { Snapshot } from '../../lib/types';
import { type AgentDraft, runAgentLimits } from './agentLimits';
import { approachPresets } from './approaches';

export function hasPublishedWebsite(snapshot: Snapshot): boolean {
  return !!snapshot.repository.site;
}

export function defaultRunAgents(snapshot: Snapshot): AgentDraft[] {
  const limits = runAgentLimits(snapshot);
  const count = hasPublishedWebsite(snapshot)
    ? limits.min_root_agents
    : Math.min(limits.max_root_agents, Math.max(2, limits.min_root_agents));
  return Array.from({ length: count }, (_, index) => ({
    id: crypto.randomUUID(),
    connection: '',
    strategy: approachPresets[index].instructions,
  }));
}
