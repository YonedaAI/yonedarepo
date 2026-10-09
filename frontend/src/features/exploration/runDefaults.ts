import type { Snapshot } from '../../lib/types';
import { type AgentDraft, runAgentLimits } from './agentLimits';
import { approachPresets } from './approaches';
import { preservePublishedApproach, publishedAgent, publishedRun } from './publishedRun';

export function hasPublishedWebsite(snapshot: Snapshot): boolean {
  return !!snapshot.repository.site;
}

export function hasPublishedWork(snapshot: Snapshot): boolean {
  return hasPublishedWebsite(snapshot) || !!publishedRun(snapshot);
}

export function defaultRunAgents(snapshot: Snapshot): AgentDraft[] {
  const limits = runAgentLimits(snapshot);
  const publication = publishedRun(snapshot);
  const winner = publication && publishedAgent(publication);
  const updating = hasPublishedWork(snapshot);
  const presets = approachPresets.filter((preset) => preset.instructions !== winner?.strategy);
  const count = updating
    ? limits.min_root_agents
    : Math.min(limits.max_root_agents, Math.max(2, limits.min_root_agents));
  return Array.from({ length: count }, (_, index) =>
    index === 0 && winner
      ? winner
      : {
          id: crypto.randomUUID(),
          connection: '',
          strategy:
            index === 0 && updating
              ? preservePublishedApproach
              : presets[index - (winner ? 1 : 0)].instructions,
        },
  );
}
