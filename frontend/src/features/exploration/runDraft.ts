import type { Snapshot } from '../../lib/types';
import { restoreTeam, runMode } from '../team/teamDraft';
import type { Provider } from '../workspace/ProviderSettings';
import type { AdaptiveAgentDraft } from './adaptiveDraft';
import { preservePublishedCriteria, publishedContext, publishedRun } from './publishedRun';
import { type InitialRun, restoreModelBudgets } from './restartRun';
import { defaultRunAgents } from './runDefaults';

/** Seed an editable approval once; incoming snapshots must not overwrite the owner's draft. */
export function runDraft(snapshot: Snapshot, source?: InitialRun) {
  const publication = source ? undefined : publishedRun(snapshot);
  const inheritedContext = publication
    ? publishedContext(snapshot, publication)
    : { ids: [], total: 0 };
  const mode = source ? runMode(source.mode) : 'collaborate';
  const agents: AdaptiveAgentDraft[] = source
    ? structuredClone(source.agents)
    : defaultRunAgents(snapshot);
  const criteria: string[] = source?.criteria ??
    publication?.run.criteria ?? [
      'Preserve existing behavior and checks',
      'Verify the requested change with meaningful tests',
    ];
  const approvedCriteria =
    publication && criteria.length < 32
      ? [...new Set([...criteria, preservePublishedCriteria])]
      : criteria;
  const previousTeamPlan = source?.team ?? publication?.run.team_plan;
  const previousAutomatic =
    (source?.teamPlanning ?? publication?.run.team_planning) === 'automatic';
  return {
    restartOf: source?.workingBranch ? undefined : source?.id,
    workingBranch: source?.workingBranch,
    publication,
    inheritedContextTotal: inheritedContext.total,
    intent: source?.intent ?? '',
    criteria: approvedCriteria.join('\n'),
    agents,
    mode,
    previousTeamPlan,
    previousAutomatic,
    team:
      source?.id && mode === 'collaborate' && !previousAutomatic && previousTeamPlan
        ? restoreTeam(previousTeamPlan, agents)
        : undefined,
    context: [...(source?.context ?? inheritedContext.ids)],
    budgets: structuredClone(
      source?.budgets ?? (publication ? restoreModelBudgets(publication.run, agents) : {}),
    ),
    policy: source?.policy ?? JSON.stringify(snapshot.repository.policy?.build, null, 2),
    delegation: structuredClone(
      source?.delegation ?? {
        enabled: false,
        max_depth: 1,
        max_executions: agents.length,
      },
    ),
  };
}

/** Never silently replace a historical connection that disappeared or changed model. */
export function defaultConnections(
  agents: AdaptiveAgentDraft[],
  _providers: Provider[],
): AdaptiveAgentDraft[] {
  return agents.map((agent) => ({ ...agent }));
}
