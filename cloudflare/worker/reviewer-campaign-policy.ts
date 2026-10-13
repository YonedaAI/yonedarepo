import type { Json } from './types';

export const reviewerCampaignId = 'reviewer-event-booking-20261012-v1';
export const campaignModelBudgets = [
  budget('zai', 'glm-5.3-flash', 150000, 500000),
  budget('codex', 'gpt-5.6-luna', 250000, 1200000),
  budget('claude', 'claude-sonnet-5-5', 4000000, 10000000),
  budget('claude', 'claude-opus-5-5', 8000000, 20000000),
];
function budget(provider: string, model: string, input: number, output: number) {
  return {
    provider,
    model,
    max_requests: 48,
    max_output_tokens: 4096,
    max_execution_ms: 600000,
    spend_limit_microusd: 5000000,
    pricing: {
      input_microusd_per_million: input,
      output_microusd_per_million: output,
      source: 'owner-approved conservative rates',
    },
  };
}

/** All source/profile/model choices are fixed by the operator, outside reviewer input. */
export function campaignTrialRequest(id: string, version: number, branch: Json) {
  const model = campaignModelBudgets[1];
  return {
    id,
    workspace_transport: 'git-native-v1',
    mode: 'collaborate',
    working_branch_id: 'campaign-development',
    expected_working_commit: branch.working_commit,
    expected_working_version: branch.version,
    autonomy_policy: {
      version: 1,
      enabled: true,
      max_repair_rounds: 2,
      max_concurrent_agents: 3,
      max_executions: 20,
      source_scope: 'project',
      allow_intent_questions: true,
    },
    intent:
      'Maintain the fullstack event-booking example: preserve persisted registration, waitlist promotion, duplicate-registration safety and the accessible interface.',
    criteria: [
      'Independent fullstack event-booking checks pass',
      'Booking state survives reload',
      'Duplicate registration is idempotent',
      'Keyboard accessible event registration and waitlist',
    ],
    agents: ['Persisted booking API and repair', 'Accessible event-booking interface'].map(
      (strategy) => ({
        provider: model.provider,
        model: model.model,
        connection: 'reviewer-campaign-codex-20261012',
        strategy,
      }),
    ),
    model_budgets: [model],
    repair_escalation: {
      version: 1,
      provider: 'claude',
      model: 'claude-opus-5-5',
      connection: 'reviewer-campaign-opus-20261012',
      max_executions: 1,
      repair_round: 2,
      after_cheaper_repair_failure: true,
      budget: campaignModelBudgets[3],
    },
    campaign: {
      id: reviewerCampaignId,
      version,
      chain_id: id,
      bucket: 'routine',
      purpose: 'routine',
    },
  };
}
