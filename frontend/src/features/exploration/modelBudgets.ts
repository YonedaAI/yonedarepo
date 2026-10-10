import type { Provider } from '../workspace/ProviderSettings';
import type { AgentDraft } from './agentLimits';

export interface SelectedModel {
  key: string;
  provider: string;
  model: string;
  roots: number;
  connections: number;
}

export interface ModelBudgetDraft {
  requests: string;
  minutes: string;
  outputTokens: string;
  usdEnabled: boolean;
  usd: string;
  inputRate: string;
  outputRate: string;
  ratesApproved: boolean;
}

export interface ModelPricing {
  input_microusd_per_million: number;
  output_microusd_per_million: number;
  source: 'owner-approved conservative rates';
}

export interface ModelBudgetConfig {
  provider: string;
  model: string;
  max_requests: number | null;
  max_output_tokens: number;
  max_execution_ms: number;
  spend_limit_microusd: number | null;
  pricing: ModelPricing | null;
}

export interface ModelBudget extends ModelBudgetConfig {
  requests: number;
  charged_microusd: number;
}

export function selectedModels(agents: AgentDraft[], providers: Provider[]): SelectedModel[] {
  const groups = new Map<string, SelectedModel & { connectionIds: Set<string> }>();
  for (const agent of agents) {
    const provider = providers.find((value) => value.id === agent.connection);
    if (!provider) continue;
    const key = JSON.stringify([provider.provider, provider.model]);
    const group = groups.get(key) ?? {
      key,
      provider: provider.provider,
      model: provider.model,
      roots: 0,
      connections: 0,
      connectionIds: new Set<string>(),
    };
    group.roots++;
    group.connectionIds.add(provider.id);
    group.connections = group.connectionIds.size;
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

export function modelPricingSuggestion(provider: string, model: string) {
  const known: Record<string, { input: string; output: string; note: string; url: string }> = {
    'claude:claude-sonnet-5-5': {
      input: '4',
      output: '10',
      note: 'Standard API pricing is $2/M input and $10/M output. Input reserves up to $4/M for one-hour cache writes; output uses the standard rate. These are budget limits, not an invoice.',
      url: 'https://platform.claude.com/docs/en/about-claude/pricing',
    },
    'claude:claude-sonnet-4-6': {
      input: '6',
      output: '30',
      note: 'Sonnet input includes one-hour cache writes; output uses a 2× reservation margin above list price.',
      url: 'https://platform.claude.com/docs/en/about-claude/pricing',
    },
    'codex:gpt-5.6-luna': {
      input: '0.25',
      output: '1.20',
      note: 'Conservative Luna rates include cache-write overhead for this platform’s bounded request size.',
      url: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
    },
    'mimo:mimo-v2.6-flash': {
      input: '0.14',
      output: '0.28',
      note: 'MiMo overseas real-time rates apply; cache writes are currently free. Review your endpoint and account pricing before approving.',
      url: 'https://mimo.mi.com/docs/pricing',
    },
    'mimo:mimo-v2.6-pro': {
      input: '0.435',
      output: '0.87',
      note: 'MiMo overseas real-time rates apply. Review your endpoint and account pricing before approving.',
      url: 'https://mimo.mi.com/docs/pricing',
    },
    'zai:glm-4.7-flash': {
      input: '0',
      output: '0',
      note: 'This model is currently listed as free. Pricing can change; request, time and output caps still apply.',
      url: 'https://docs.z.ai/guides/overview/pricing',
    },
    'zai:glm-4.5-flash': {
      input: '0',
      output: '0',
      note: 'The catalog currently lists this model as free. Confirm your account and endpoint support it; pricing can change.',
      url: 'https://docs.z.ai/guides/overview/pricing',
    },
    'zai:glm-4.7-flashx': {
      input: '0.07',
      output: '0.4',
      note: 'ZAI catalog rates apply. Confirm your Anthropic-compatible account supports this model.',
      url: 'https://docs.z.ai/guides/overview/pricing',
    },
    'zai:glm-4.7': {
      input: '0.6',
      output: '2.2',
      note: 'ZAI catalog rates apply. Confirm your Anthropic-compatible account supports this model.',
      url: 'https://docs.z.ai/guides/overview/pricing',
    },
    'zai:glm-5.3-flash': {
      input: '0.15',
      output: '0.5',
      note: 'ZAI catalog rates apply. Confirm your account and endpoint billing before approving.',
      url: 'https://docs.z.ai/guides/overview/pricing',
    },
    'zai:glm-5.3': {
      input: '1.4',
      output: '4.4',
      note: 'ZAI catalog rates apply. Confirm your account and endpoint billing before approving.',
      url: 'https://docs.z.ai/guides/overview/pricing',
    },
    'gemini:gemini-3.8-flash': {
      input: '1.50',
      output: '7.50',
      note: 'Conservative Gemini rates use the higher standard rates announced for January 2027.',
      url: 'https://ai.google.dev/gemini-api/docs/pricing',
    },
  };
  return known[`${provider}:${model}`];
}

export function defaultModelBudget(_group: SelectedModel): ModelBudgetDraft {
  return {
    requests: '',
    minutes: '10',
    outputTokens: '4096',
    usdEnabled: false,
    usd: '',
    inputRate: '',
    outputRate: '',
    ratesApproved: false,
  };
}

export function editDollarBudget(
  model: SelectedModel,
  draft: ModelBudgetDraft,
  usd: string,
): ModelBudgetDraft {
  const suggested = modelPricingSuggestion(model.provider, model.model);
  const inputRate = draft.inputRate || suggested?.input || '';
  const outputRate = draft.outputRate || suggested?.output || '';
  return {
    ...draft,
    usd,
    usdEnabled: !!usd.trim(),
    inputRate,
    outputRate,
    ratesApproved: usd.trim() ? !!inputRate && !!outputRate : draft.ratesApproved,
  };
}

export function editModelPricing(
  draft: ModelBudgetDraft,
  field: 'inputRate' | 'outputRate',
  value: string,
): ModelBudgetDraft {
  const next = { ...draft, [field]: value };
  return { ...next, ratesApproved: !!next.inputRate.trim() && !!next.outputRate.trim() };
}

function integer(value: string, min: number, max: number, label: string) {
  const parsed = Number(value);
  if (!value.trim() || !Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return parsed;
}

function microusd(value: string, positive: boolean, label: string) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value.trim()))
    throw new Error(`${label} requires a USD amount with at most six decimal places.`);
  const [whole, fraction = ''] = value.trim().split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || (positive && amount === 0n))
    throw new Error(`${label} is outside the supported range.`);
  return Number(amount);
}

function executionMilliseconds(value: string) {
  const minutes = Number(value);
  if (!value.trim() || !Number.isFinite(minutes) || minutes < 1 || minutes > 30)
    throw new Error('Execution time must be from 1 to 30 minutes.');
  return Math.round(minutes * 60_000);
}

export function serializeModelBudgets(
  models: SelectedModel[],
  drafts: Record<string, ModelBudgetDraft>,
): ModelBudgetConfig[] {
  return models.map((model) => {
    const draft = drafts[model.key] ?? defaultModelBudget(model);
    if (draft.usdEnabled && !draft.ratesApproved)
      throw new Error(`Enter conservative pricing for ${model.model} in Advanced limits.`);
    return {
      provider: model.provider,
      model: model.model,
      max_requests: draft.requests.trim()
        ? integer(draft.requests, 1, Number.MAX_SAFE_INTEGER, `${model.model} request limit`)
        : null,
      max_output_tokens: integer(draft.outputTokens, 256, 4096, `${model.model} output tokens`),
      max_execution_ms: executionMilliseconds(draft.minutes),
      spend_limit_microusd: draft.usdEnabled
        ? microusd(draft.usd, true, `${model.model} estimated allowance`)
        : null,
      pricing:
        draft.usdEnabled || draft.ratesApproved
          ? {
              input_microusd_per_million: microusd(draft.inputRate, false, 'Input pricing'),
              output_microusd_per_million: microusd(draft.outputRate, false, 'Output pricing'),
              source: 'owner-approved conservative rates',
            }
          : null,
    };
  });
}

export function formatBudgetUsd(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }).format(value / 1_000_000)
    : '—';
}
