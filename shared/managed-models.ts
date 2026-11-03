// Supported harness/provider combinations, model rates and usage charging.
import type { Harness, ModelProvider } from './managed-agent-types';

/** Which providers each harness can drive: Claude Code speaks Anthropic Messages (Claude, and
 * the Anthropic-compatible GLM and MiMo endpoints), Codex the OpenAI Responses API, and
 * opencode is the harness for GLM and MiMo. */
export const HARNESS_PROVIDERS: Record<Harness, readonly ModelProvider[]> = {
  'claude-code': ['claude', 'zai', 'mimo'],
  codex: ['codex'],
  opencode: ['zai', 'mimo'],
};
export const HARNESS_LABELS: Record<Harness, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'opencode',
};

/** Price = provider list rate × AGENT_MARGIN (the pricing page's MARGIN). */
export const AGENT_MARGIN = 1.3;
/** Promotional credit added on a workspace's first run; no card is asked for. */
export const STARTING_CREDIT_USD = 5;
/** Container time per run (standard-1), billed at the pricing page's check-minute rate. */
export const CONTAINER_USD_PER_MINUTE = 0.0017;

/** Provider list prices in USD per million tokens, by usage category. */
export interface ModelRate {
  provider: ModelProvider;
  model: string;
  label: string;
  input: number;
  /** Cache writes (the longest cache duration's rate, so a write is never under-billed). */
  cache_write: number;
  cache_read: number;
  output: number;
  /** A higher tier for long prompts: prices above `above_input_tokens` input tokens. */
  long?: {
    above_input_tokens: number;
    input: number;
    cache_write: number;
    cache_read: number;
    output: number;
  };
  source_url: string;
  verified_at: string;
}

/** The billing rate table, read from each provider's own pricing page on 2026-10-29. */
export const MODEL_RATES: readonly ModelRate[] = [
  {
    provider: 'zai',
    model: 'glm-5.3-flash',
    label: 'GLM-5.3 Flash',
    input: 0.15,
    cache_write: 0, // listed as limited-time free
    cache_read: 0.03,
    output: 0.5,
    source_url: 'https://docs.z.ai/guides/overview/pricing',
    verified_at: '2026-10-29',
  },
  {
    provider: 'zai',
    model: 'glm-5.3',
    label: 'GLM-5.3',
    input: 1.4,
    cache_write: 0,
    cache_read: 0.26,
    output: 4.4,
    source_url: 'https://docs.z.ai/guides/overview/pricing',
    verified_at: '2026-10-29',
  },
  {
    provider: 'mimo',
    model: 'mimo-v2.6-flash',
    label: 'MiMo V2.6 Flash',
    input: 0.14,
    cache_write: 0,
    cache_read: 0.14, // no cache-hit rate listed: billed as input
    output: 0.28,
    source_url: 'https://mimo.mi.com/docs/en-US/price/pay-as-you-go',
    verified_at: '2026-10-29',
  },
  {
    provider: 'mimo',
    model: 'mimo-v2.6-pro',
    label: 'MiMo V2.6 Pro',
    input: 0.435,
    cache_write: 0,
    cache_read: 0.435,
    output: 0.87,
    source_url: 'https://mimo.mi.com/docs/en-US/price/pay-as-you-go',
    verified_at: '2026-10-29',
  },
  {
    provider: 'codex',
    model: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    input: 0.2,
    cache_write: 0,
    cache_read: 0.02,
    output: 1.2,
    source_url: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
    verified_at: '2026-11-03',
  },
  {
    provider: 'claude',
    model: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    input: 0.1,
    cache_write: 0.2,
    cache_read: 0.01,
    output: 0.5,
    long: {
      above_input_tokens: 100_000,
      input: 0.5,
      cache_write: 1,
      cache_read: 0.05,
      output: 2.5,
    },
    source_url: 'https://platform.claude.com/docs/en/about-claude/pricing',
    verified_at: '2026-10-29',
  },
  {
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    input: 2,
    cache_write: 4,
    cache_read: 0.1,
    output: 10,
    source_url: 'https://platform.claude.com/docs/en/about-claude/pricing',
    verified_at: '2026-10-29',
  },
];

export const modelRate = (provider: string, model: string) =>
  MODEL_RATES.find((r) => r.provider === provider && r.model === model) ?? null;

/** The models a harness may run, from its providers' rated models. */
export const harnessModels = (harness: Harness) =>
  MODEL_RATES.filter((r) => HARNESS_PROVIDERS[harness].includes(r.provider));

/** Token usage of one model request, by category. */
export interface TokenUsage {
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
}

/** List cost of `usage` in micro-USD (rounded up), with the long-prompt tier when it applies. */
export function usageCostMicrousd(rate: ModelRate, usage: TokenUsage): number {
  const prompt = usage.input + usage.cache_write + usage.cache_read;
  const r = rate.long && prompt > rate.long.above_input_tokens ? rate.long : rate;
  return Math.ceil(
    usage.input * r.input +
      usage.cache_write * r.cache_write +
      usage.cache_read * r.cache_read +
      usage.output * r.output,
  );
}

/** What a workspace pays for `costMicrousd` of list cost: × AGENT_MARGIN, rounded up. */
export const chargeMicrousd = (costMicrousd: number) => Math.ceil(costMicrousd * AGENT_MARGIN);
