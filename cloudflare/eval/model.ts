// Model access for the eval Worker: fixed cheapest models per provider, routes taken from
// the provider registry, keys read from Secrets Store bindings only at request time and
// never returned, logged or echoed. Every request is admitted by the spend ledger first
// (projected cost), then settled with the provider-reported usage. Rate limits back off
// and are counted as failures; nothing falls back to another model.
import { type ProviderDefinition, providerDefinition } from '../../shared/providers';
import type { EvalEnv } from './types';

export type ProviderId = 'zai' | 'mimo';
export const PROVIDERS: ProviderId[] = ['zai', 'mimo'];
/** Cheapest validated coding models (AGENTS.md); there is no override and no fallback. */
export const MODELS: Record<ProviderId, string> = { zai: 'glm-5.3-flash', mimo: 'mimo-v2.6-flash' };
/** The owner's MiMo Token Plan key is bound to the Singapore token-plan endpoint. */
const TOKEN_PLAN_REGION = 'sgp';

export type Pricing = {
  input_microusd_per_million: number;
  output_microusd_per_million: number;
  source_url?: string;
  basis?: string;
};
export type Route = {
  provider: ProviderId;
  model: string;
  route: string;
  url: string;
  headers: Record<string, string>;
  pricing: Pricing;
  /** Lowest reasoning setting the provider documents for this model. */
  reasoning: Record<string, unknown>;
};

export class ArmError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function pricingOf(definition: ProviderDefinition, model: string): Pricing {
  const option = definition.models.find((m) => m.id === model);
  const rates = option?.conservative_pricing;
  if (!rates) throw new ArmError('PROVIDER_UNAVAILABLE', `No pricing recorded for ${model}`);
  return {
    input_microusd_per_million: rates.input_microusd_per_million,
    output_microusd_per_million: rates.output_microusd_per_million,
    source_url: option.pricing_source_url,
    basis: option.pricing_basis,
  };
}

export async function resolveRoute(env: EvalEnv, provider: ProviderId): Promise<Route> {
  const definition = providerDefinition(provider);
  const binding = provider === 'zai' ? env.ZAI_KEY : env.MIMO_KEY;
  const key = binding ? await binding.get().catch(() => '') : '';
  if (!key) throw new ArmError('PROVIDER_UNAVAILABLE', `${definition.name} key is not bound`);
  const model = MODELS[provider];
  let url = definition.api_base;
  let route = provider === 'zai' ? 'coding_plan' : 'api_credits';
  if (provider === 'mimo' && /^(tp-|ttp-)/.test(key)) {
    const regional = definition.token_plan_regions?.[TOKEN_PLAN_REGION];
    if (!regional) throw new ArmError('PROVIDER_UNAVAILABLE', 'Token Plan region missing');
    url = regional;
    route = `token_plan_${TOKEN_PLAN_REGION}`;
  }
  return {
    provider,
    model,
    route,
    url: `${url}/v1/messages`,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      [definition.auth_header]: `${definition.auth_prefix}${key}`,
    },
    pricing: pricingOf(definition, model),
    // GLM: effort low through output_config (docs.z.ai/devpack/latest-model). MiMo documents
    // no effort, only thinking on/off, so its lowest setting is thinking disabled.
    reasoning:
      provider === 'zai'
        ? { output_config: { effort: 'low' }, thinking: { type: 'enabled' } }
        : { thinking: { type: 'disabled' } },
  };
}

export type Usage = {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  microusd: number;
  failures: { rate_limited: number; provider_error: number; timeout: number };
  errors: string[];
};
export const newUsage = (): Usage => ({
  requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  microusd: 0,
  failures: { rate_limited: 0, provider_error: 0, timeout: 0 },
  errors: [],
});

export type Ledger = {
  reserve(id: string, run: string, projected: number): Promise<{ admitted: boolean }>;
  settle(id: string, actual: number): Promise<void>;
};
export type Limits = {
  maxRequests: number;
  deadline: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  maxRetries: number;
  backoffMs: number;
};

/** Thrown when a cap stops the arm; the arm reports it instead of continuing. */
export class StopError extends ArmError {}

const perMillion = (tokens: number, rate: number) => (tokens * rate) / 1_000_000;
const RATE_LIMITED = /\b1302\b|rate.?limit|too many requests|request limit|quota/i;

export class ModelClient {
  readonly usage = newUsage();
  #route: Route;
  #ledger: Ledger;
  #run: string;
  #limits: Limits;

  constructor(route: Route, ledger: Ledger, run: string, limits: Limits) {
    this.#route = route;
    this.#ledger = ledger;
    this.#run = run;
    this.#limits = limits;
  }

  #fail(kind: keyof Usage['failures'], detail: string) {
    this.usage.failures[kind]++;
    if (this.usage.errors.length < 8) this.usage.errors.push(`${kind}: ${detail.slice(0, 200)}`);
  }

  /** One Messages call with admission, retries on rate limits, and settlement. */
  async messages(request: Record<string, unknown>): Promise<any> {
    const { pricing } = this.#route;
    const body = {
      ...request,
      ...this.#route.reasoning,
      model: this.#route.model,
      max_tokens: this.#limits.maxOutputTokens,
    };
    const text = JSON.stringify(body);
    // One token per UTF-8 byte plus protocol overhead deliberately over-reserves input.
    const projected =
      perMillion(new TextEncoder().encode(text).length + 8192, pricing.input_microusd_per_million) +
      perMillion(this.#limits.maxOutputTokens, pricing.output_microusd_per_million);
    for (let attempt = 0; ; attempt++) {
      if (Date.now() >= this.#limits.deadline)
        throw new StopError('wall_clock', 'Arm wall-clock cap reached');
      if (this.usage.requests >= this.#limits.maxRequests)
        throw new StopError('request_cap', 'Arm request cap reached');
      const id = crypto.randomUUID();
      if (!(await this.#ledger.reserve(id, this.#run, projected)).admitted)
        throw new StopError('spend_cap', 'Projected spend would exceed the cap');
      this.usage.requests++;
      let response: Response;
      try {
        response = await fetch(this.#route.url, {
          method: 'POST',
          headers: this.#route.headers,
          body: text,
          signal: AbortSignal.timeout(this.#limits.requestTimeoutMs),
        });
      } catch (e: any) {
        // The provider may have billed a request we never saw answered: charge the reservation.
        await this.#ledger.settle(id, projected);
        this.usage.microusd += projected;
        this.#fail('timeout', `${String(e?.name ?? 'fetch failed')} (charged at projected cost)`);
        if (attempt < this.#limits.maxRetries) continue;
        throw new ArmError('timeout', 'Model request failed');
      }
      const raw = await response.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(raw);
      } catch {}
      const usage = parsed?.usage;
      if (response.ok && Array.isArray(parsed?.content) && usage) {
        const input = Number(usage.input_tokens ?? 0);
        const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
        const cacheWrite = Number(usage.cache_creation_input_tokens ?? 0);
        const output = Number(usage.output_tokens ?? 0);
        // Cache reads and writes are charged at the full input rate (conservative).
        const cost =
          perMillion(input + cacheRead + cacheWrite, pricing.input_microusd_per_million) +
          perMillion(output, pricing.output_microusd_per_million);
        await this.#ledger.settle(id, cost);
        this.usage.input_tokens += input + cacheWrite;
        this.usage.cache_read_tokens += cacheRead;
        this.usage.output_tokens += output;
        this.usage.microusd += cost;
        return parsed;
      }
      await this.#ledger.settle(id, 0);
      const detail = `HTTP ${response.status} ${String(parsed?.error?.code ?? '')} ${String(parsed?.error?.message ?? parsed?.message ?? raw)}`;
      const limited = response.status === 429 || RATE_LIMITED.test(detail);
      const retryable = limited || response.status >= 500;
      this.#fail(limited ? 'rate_limited' : 'provider_error', detail);
      if (!retryable || attempt >= this.#limits.maxRetries)
        throw new ArmError(limited ? 'rate_limited' : 'provider_error', detail.slice(0, 200));
      const after = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : 0;
      await new Promise((r) => setTimeout(r, wait || this.#limits.backoffMs * 2 ** attempt));
    }
  }
}
