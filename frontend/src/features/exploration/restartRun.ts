import type { RunMode, TeamPlan } from '../../../../shared/team';
import type { Snapshot } from '../../lib/types';
import { teamAgents } from '../team/teamAgents';
import { runMode } from '../team/teamDraft';
import { readTeamPlan } from '../team/teamPlanRecord';
import type { Provider } from '../workspace/ProviderSettings';
import { modelIsRunnable } from '../workspace/providerModels';
import type { AgentDraft } from './agentLimits';
import { defaultModelBudget, type ModelBudgetConfig, type ModelBudgetDraft } from './modelBudgets';
import { textList } from './recordFields';
import type { WorkingBranch } from './workingBranchView';

export interface InitialRun {
  id: string;
  intent: string;
  criteria: string[];
  context: string[];
  agents: AgentDraft[];
  policy: string;
  budgets: Record<string, ModelBudgetDraft>;
  mode?: RunMode;
  team?: TeamPlan;
  workingBranch?: WorkingBranch;
}

export function workingContinuation(
  snapshot: Snapshot,
  run: Record<string, any>,
  branch: WorkingBranch,
): InitialRun {
  return { ...initialRun(snapshot, run), intent: '', workingBranch: branch };
}

export function agentConnectionIssue(agent: AgentDraft, providers: Provider[]) {
  const connection = providers.find((provider) => provider.id === agent.connection);
  if (!connection && agent.fromPreviousRun)
    return 'The previous connection is unavailable. Choose a replacement connection.';
  if (agent.fromPreviousRun && (!agent.expectedProvider || !agent.expectedModel))
    return 'The previous provider or model was not recorded. Choose a current connection.';
  if (
    connection &&
    ((agent.expectedProvider && agent.expectedProvider !== connection.provider) ||
      (agent.expectedModel && agent.expectedModel !== connection.model))
  ) {
    return 'This connection now uses a different provider or model. Choose a connection to approve its current model.';
  }
  return connection && !modelIsRunnable(connection.provider, connection.model)
    ? 'This model is not currently available for new runs. Choose a supported model.'
    : '';
}

export function initialRun(snapshot: Snapshot, run: Record<string, any>): InitialRun {
  const agents =
    run.mode === 'collaborate'
      ? teamAgents(snapshot, run)
      : snapshot.executions
          .filter(
            (execution) =>
              execution.run_id === run.id &&
              execution.role === 'coding' &&
              !execution.parent_execution,
          )
          .map((execution) => ({
            id: crypto.randomUUID(),
            connection: execution.connection ?? '',
            strategy: execution.strategy ?? '',
            expectedProvider: execution.provider,
            expectedModel: execution.model,
            fromPreviousRun: true,
            ...(execution.reasoning_effort != null
              ? { reasoning_effort: execution.reasoning_effort }
              : {}),
          }));
  const budgets = restoreModelBudgets(run, agents);
  return {
    id: run.id,
    intent: run.intent ?? '',
    criteria: textList(run.criteria) ?? [],
    context: textList(run.context) ?? [],
    agents,
    // Historical policy is evidence; restarting must preserve the repository's current checks.
    policy: JSON.stringify(snapshot.repository.policy?.build, null, 2),
    budgets,
    mode: runMode(run.mode),
    team: readTeamPlan(run.team_plan),
  };
}

export function restoreModelBudgets(
  run: Record<string, any>,
  agents: AgentDraft[],
): Record<string, ModelBudgetDraft> {
  const budgets: Record<string, ModelBudgetDraft> = {};
  const recorded: unknown[] = Array.isArray(run.model_budgets) ? run.model_budgets : [];
  for (const budget of recorded as ModelBudgetConfig[]) {
    if (!budget || typeof budget.provider !== 'string' || typeof budget.model !== 'string')
      continue;
    const key = JSON.stringify([budget.provider, budget.model]);
    const rootCount = agents.filter(
      (agent) => agent.expectedProvider === budget.provider && agent.expectedModel === budget.model,
    ).length;
    if (!rootCount) continue;
    budgets[key] = {
      ...defaultModelBudget({
        key,
        provider: budget.provider,
        model: budget.model,
        roots: rootCount,
        connections: 0,
      }),
      requests: budget.max_requests == null ? '' : String(budget.max_requests),
      minutes: String(budget.max_execution_ms / 60_000),
      outputTokens: String(budget.max_output_tokens),
      usdEnabled: budget.spend_limit_microusd != null,
      usd:
        budget.spend_limit_microusd != null ? String(budget.spend_limit_microusd / 1_000_000) : '',
      inputRate: budget.pricing
        ? String(budget.pricing.input_microusd_per_million / 1_000_000)
        : '',
      outputRate: budget.pricing
        ? String(budget.pricing.output_microusd_per_million / 1_000_000)
        : '',
      ratesApproved: budget.pricing?.source === 'owner-approved conservative rates',
    };
  }
  return budgets;
}
