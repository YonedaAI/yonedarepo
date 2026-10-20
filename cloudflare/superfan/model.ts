// The cheap model that turns fired signals into a short finding. Only two flash models are
// allowed and there is no fallback between them: a missing key or failed call leaves the
// finding with its deterministic summary. Keys come from the Secrets Store binding and are
// sent only to the provider's own endpoint.
import { providerDefinition } from '../../shared/providers';
import type { SuperfanEnv } from './config';

/** Hard cap on output tokens per call; thinking is disabled so all of it is the answer. */
export const MAX_OUTPUT_TOKENS = 400;
const ALLOWED: Record<string, 'mimo' | 'zai'> = {
  'mimo-v2.6-flash': 'mimo',
  'glm-5.3-flash': 'zai',
};

const SYSTEM = `You watch one component of a Git hosting platform on Cloudflare for subtle
problems that normal alerts miss. You receive deterministic signals that crossed a rule.
Reply with one JSON object only: {"title": string, "what": string, "evidence": string,
"likely_cause": string, "next_check": string}. Use only the numbers given; say "unknown"
rather than guess. At most 90 words in total.`;

export interface Finding {
  title: string;
  what: string;
  evidence: string;
  likely_cause: string;
  next_check: string;
}
export interface ModelReply {
  finding: Finding;
  inputTokens: number;
  outputTokens: number;
}
export interface ModelClient {
  readonly model: string;
  /** Worst-case cost of a call with this prompt, in micro-USD, reserved before calling. */
  worstCase(prompt: string): number;
  /** Actual cost from the provider's reported usage. */
  cost(reply: ModelReply): number;
  write(prompt: string): Promise<ModelReply>;
}

/** `sent` means the request may have reached the provider, so its reservation is kept. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly sent = false,
  ) {
    super(message);
  }
}

function pricing(provider: string, model: string) {
  const price = providerDefinition(provider).models.find(
    (m) => m.id === model,
  )?.conservative_pricing;
  if (!price) throw new ModelError(`No verified pricing for ${model}`);
  return price;
}

function parseFinding(text: string): Finding {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(json);
  } catch {
    // An unparseable reply is kept as plain text below, never interpreted.
  }
  const field = (key: string) =>
    typeof value[key] === 'string' ? (value[key] as string).slice(0, 400) : 'unknown';
  return value.title
    ? {
        title: field('title'),
        what: field('what'),
        evidence: field('evidence'),
        likely_cause: field('likely_cause'),
        next_check: field('next_check'),
      }
    : {
        title: 'Unstructured model reply',
        what: text.slice(0, 400),
        evidence: 'unknown',
        likely_cause: 'unknown',
        next_check: 'unknown',
      };
}

export class FlashModel implements ModelClient {
  readonly model: string;
  readonly #provider: 'mimo' | 'zai';
  readonly #price: { input_microusd_per_million: number; output_microusd_per_million: number };

  constructor(
    private readonly env: SuperfanEnv,
    model: string,
  ) {
    const provider = ALLOWED[model];
    if (!provider) throw new ModelError(`${model} is not an allowed superfan model`);
    this.model = model;
    this.#provider = provider;
    this.#price = pricing(provider, model);
  }

  worstCase(prompt: string) {
    // A token is never shorter than one UTF-8 byte; 64 covers the message framing.
    const input = new TextEncoder().encode(SYSTEM + prompt).length + 64;
    return Math.ceil(
      (input * this.#price.input_microusd_per_million +
        MAX_OUTPUT_TOKENS * this.#price.output_microusd_per_million) /
        1_000_000,
    );
  }

  cost(reply: ModelReply) {
    return Math.ceil(
      (reply.inputTokens * this.#price.input_microusd_per_million +
        reply.outputTokens * this.#price.output_microusd_per_million) /
        1_000_000,
    );
  }

  async #endpoint(key: string) {
    const definition = providerDefinition(this.#provider);
    if (this.#provider === 'mimo' && /^(tp-|ttp-)/.test(key)) {
      // Token Plan keys work only on their region's endpoint.
      const region = this.env.MIMO_TOKEN_PLAN_REGION ?? 'sgp';
      const base = definition.token_plan_regions?.[region];
      if (!base) throw new ModelError('MiMo Token Plan region is not configured');
      return { base, definition };
    }
    return { base: definition.api_base, definition };
  }

  async write(prompt: string): Promise<ModelReply> {
    const secret = this.#provider === 'mimo' ? this.env.MIMO_KEY : this.env.ZAI_KEY;
    const key = secret ? await secret.get().catch(() => '') : '';
    if (!key) throw new ModelError(`${this.#provider} key is not bound`);
    const { base, definition } = await this.#endpoint(key);
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [definition.auth_header]: definition.auth_prefix + key,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        thinking: { type: 'disabled' },
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!res) throw new ModelError('Model request did not complete', true);
    if (res.status !== 200) throw new ModelError(`Model returned HTTP ${res.status}`, true);
    const body = (await res.json().catch(() => null)) as Record<string, any> | null;
    const text = Array.isArray(body?.content)
      ? body.content
          .filter((c: Record<string, unknown>) => c?.type === 'text')
          .map((c: Record<string, unknown>) => String(c.text ?? ''))
          .join('')
      : '';
    const usage = body?.usage ?? {};
    if (
      !text ||
      !Number.isSafeInteger(usage.input_tokens) ||
      !Number.isSafeInteger(usage.output_tokens)
    )
      throw new ModelError('Model reply had no text or no usage', true);
    return {
      finding: parseFinding(text),
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    };
  }
}
