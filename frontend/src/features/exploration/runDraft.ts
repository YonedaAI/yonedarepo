import type { Snapshot } from '../../lib/types';
import { teamAgents } from '../team/teamAgents';
import { restoreTeam, runMode } from '../team/teamDraft';
import type { Provider } from '../workspace/ProviderSettings';
import type { AgentDraft } from './agentLimits';
import { preservePublishedCriteria, publishedContext, publishedRun } from './publishedRun';
import { type InitialRun, restoreModelBudgets } from './restartRun';
import { defaultRunAgents } from './runDefaults';

/** Seed an editable approval once; incoming snapshots must not overwrite the owner's draft. */
export function runDraft(snapshot: Snapshot, source?: InitialRun) {
  const publication = source ? undefined : publishedRun(snapshot);
  const inheritedContext = publication
    ? publishedContext(snapshot, publication)
    : { ids: [], total: 0 };
  const mode = runMode(source?.mode ?? publication?.run.mode);
  const agents =
    source?.agents ??
    (publication?.run.mode === 'collaborate'
      ? teamAgents(snapshot, publication.run)
      : defaultRunAgents(snapshot));
  const criteria: string[] = source?.criteria ??
    publication?.run.criteria ?? [
      'Works on mobile and desktop',
      'Keyboard accessible navigation',
      'Clear content and useful interactions',
    ];
  const approvedCriteria =
    publication && criteria.length < 32
      ? [...new Set([...criteria, preservePublishedCriteria])]
      : criteria;
  const previousTeamPlan = source?.team ?? publication?.run.team_plan;
  const previousAutomatic =
    (source?.teamPlanning ?? publication?.run.team_planning) === 'automatic';
  return {
    restartOf: source?.id,
    publication,
    inheritedContextTotal: inheritedContext.total,
    intent: source?.intent ?? '',
    criteria: approvedCriteria.join('\n'),
    agents,
    mode,
    previousTeamPlan,
    previousAutomatic,
    team:
      mode === 'collaborate' && !previousAutomatic && previousTeamPlan
        ? restoreTeam(previousTeamPlan, agents)
        : undefined,
    context: source?.context ?? inheritedContext.ids,
    budgets: source?.budgets ?? (publication ? restoreModelBudgets(publication.run, agents) : {}),
    policy: source?.policy ?? JSON.stringify(snapshot.repository.policy?.build, null, 2),
    delegation: source?.delegation ?? {
      enabled: false,
      max_depth: 1,
      max_executions: agents.length,
    },
  };
}

/** Never silently replace a historical connection that disappeared or changed model. */
export function defaultConnections(agents: AgentDraft[], providers: Provider[]): AgentDraft[] {
  return agents.map((agent, index) => ({
    ...agent,
    connection:
      agent.fromPreviousRun || providers.some((provider) => provider.id === agent.connection)
        ? agent.connection
        : (providers[index % providers.length]?.id ?? ''),
  }));
}
