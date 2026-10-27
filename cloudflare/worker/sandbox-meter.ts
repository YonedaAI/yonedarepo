// Real spend metering for sandbox model traffic. SandboxOutbound passes each model response to
// the CLI unchanged, chunk by chunk, and reads a copy of it for the provider's own usage report:
// - Anthropic Messages: `message_start` (input and cache tokens) then `message_delta`
//   (cumulative output tokens), or the JSON body's `usage`;
// - OpenAI Responses: `response.completed` (or `.incomplete`/`.failed`) `response.usage`;
// - Chat Completions: the final chunk's `usage` (`stream_options.include_usage` is turned on
//   in the request so the provider sends it);
// - Gemini: the last `usageMetadata`.
// When the response ends, the usage is recorded once (`sandbox_usage`, priced by the ledger at
// the run's approved rates). Before a new request, the ledger says whether that allowance is
// already used up; only then is the request refused, with a 402 the CLI reports.
import { ledger } from './storage';
import type { Env, Json } from './types';

export type MeterFormat = 'anthropic' | 'responses' | 'chat' | 'gemini';
export type MeteredUsage = {
  /** Uncached input tokens. */
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** Output tokens, reasoning included. */
  output_tokens: number;
};
/** The attempt the usage belongs to (its ledger and fenced job). */
export type MeteredAttempt = { project: string; job_id: string; epoch: number };

/** Largest non-streamed body or pending SSE line read for usage; the CLI still gets all of it. */
const READ_LIMIT = 4 * 1024 * 1024;

/** The usage format of a model path; token counting (free) is not metered. */
export function meterFormat(path: string): MeterFormat | null {
  if (path.endsWith('/messages')) return 'anthropic';
  if (path.endsWith('/responses')) return 'responses';
  if (path.endsWith('/chat/completions')) return 'chat';
  if (path.endsWith(':generateContent') || path.endsWith(':streamGenerateContent')) return 'gemini';
  return null;
}

const count = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;

/** Reads one format's usage from parsed events; later reports replace earlier ones. */
export class UsageReader {
  private seen = false;
  private usage: MeteredUsage = {
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
  };
  constructor(private readonly format: MeterFormat) {}

  private set(key: keyof MeteredUsage, value: unknown) {
    const n = count(value);
    if (n === undefined) return;
    this.usage[key] = n;
    this.seen = true;
  }

  /** `input` includes `cached` (OpenAI and Gemini); split them so nothing counts twice. */
  private setIncluded(input: unknown, cached: unknown, output: unknown) {
    const total = count(input);
    const read = count(cached) ?? 0;
    if (total !== undefined) {
      this.set('input_tokens', Math.max(0, total - read));
      this.set('cache_read_input_tokens', Math.min(read, total));
    }
    this.set('output_tokens', output);
  }

  observe(event: Json) {
    if (Array.isArray(event)) {
      for (const item of event) this.observe(item);
      return;
    }
    if (!event || typeof event !== 'object') return;
    switch (this.format) {
      case 'anthropic': {
        const usage = event.message?.usage ?? event.usage;
        if (!usage) return;
        this.set('input_tokens', usage.input_tokens);
        this.set('cache_read_input_tokens', usage.cache_read_input_tokens);
        this.set('cache_creation_input_tokens', usage.cache_creation_input_tokens);
        this.set('output_tokens', usage.output_tokens);
        return;
      }
      case 'responses': {
        const usage = event.response?.usage ?? (event.object === 'response' ? event.usage : null);
        if (usage)
          this.setIncluded(
            usage.input_tokens,
            usage.input_tokens_details?.cached_tokens,
            usage.output_tokens,
          );
        return;
      }
      case 'chat': {
        const usage = event.usage;
        if (usage)
          this.setIncluded(
            usage.prompt_tokens,
            usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens,
            usage.completion_tokens,
          );
        return;
      }
      case 'gemini': {
        const usage = event.usageMetadata;
        if (!usage) return;
        const output =
          (count(usage.candidatesTokenCount) ?? 0) + (count(usage.thoughtsTokenCount) ?? 0);
        this.setIncluded(usage.promptTokenCount, usage.cachedContentTokenCount, output);
        return;
      }
    }
  }

  /** The reported usage, or null when the response carried none. */
  result(): MeteredUsage | null {
    return this.seen ? { ...this.usage } : null;
  }
}

/**
 * The response the CLI gets: the same status, headers and bytes, each chunk passed on before it
 * is read. `report` runs once the body ends (or is cancelled) with whatever usage it carried.
 */
export function meterResponse(
  response: Response,
  format: MeterFormat,
  report: (usage: MeteredUsage) => void,
): Response {
  if (!response.ok || !response.body) return response;
  const reader = new UsageReader(format);
  const streamed = response.headers.get('content-type')?.includes('text/event-stream') ?? false;
  const decoder = new TextDecoder();
  let pending = '';
  let overflow = false;
  let reported = false;
  const line = (value: string) => {
    const text = value.trim();
    if (!text.startsWith('data:')) return;
    const data = text.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      reader.observe(JSON.parse(data));
    } catch {
      /* A non-JSON line carries no usage. */
    }
  };
  const finish = () => {
    if (reported) return;
    reported = true;
    pending += decoder.decode();
    if (streamed) line(pending);
    else if (!overflow) {
      try {
        reader.observe(JSON.parse(pending));
      } catch {
        /* An unreadable body carries no usage. */
      }
    }
    const usage = reader.result();
    if (usage) report(usage);
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (overflow) return;
      pending += decoder.decode(chunk, { stream: true });
      if (streamed) {
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const value of lines) line(value);
      }
      if (pending.length > READ_LIMIT) {
        overflow = true;
        pending = '';
      }
    },
    flush: finish,
    // The CLI hung up mid-stream: what the provider already reported was still billed.
    cancel: finish,
  } as Transformer<Uint8Array, Uint8Array>);
  return new Response(response.body.pipeThrough(transform), response);
}

/**
 * The body to forward: unchanged (still streaming) except a Chat Completions stream, which
 * reports usage only when asked, so `stream_options.include_usage` is turned on.
 */
export async function meteredRequestBody(
  format: MeterFormat,
  request: Request,
): Promise<ReadableStream | string | null> {
  if (format !== 'chat') return request.body;
  return requestUsageReport(await request.text());
}

export function requestUsageReport(body: string): string {
  try {
    const value = JSON.parse(body);
    if (value?.stream !== true || value.stream_options?.include_usage === true) return body;
    value.stream_options = { ...(value.stream_options ?? {}), include_usage: true };
    return JSON.stringify(value);
  } catch {
    return body;
  }
}

const usd = (microusd: unknown) =>
  Number.isSafeInteger(microusd) ? `$${(Number(microusd) / 1_000_000).toFixed(4)}` : 'unknown';

/** The provider-shaped 402 a CLI reports when the run's approved allowance is spent. */
export function budgetSpentResponse(format: MeterFormat, budget: Json): Response {
  const message = `The run's approved model allowance for ${budget.model ?? 'this model'} is spent (${usd(budget.charged_microusd)} metered of ${usd(budget.spend_limit_microusd)}). No further model requests run for this attempt.`;
  const body =
    format === 'anthropic'
      ? { type: 'error', error: { type: 'billing_error', message } }
      : format === 'gemini'
        ? { error: { code: 402, message, status: 'RESOURCE_EXHAUSTED' } }
        : { error: { message, type: 'insufficient_quota', code: 'run_budget_spent' } };
  return Response.json(body, { status: 402 });
}

/** Asks the ledger whether the attempt may start another model request. */
export async function budgetState(env: Env, attempt: MeteredAttempt): Promise<Json> {
  return ledger(env, attempt.project, {
    op: 'sandbox_budget',
    job_id: attempt.job_id,
    epoch: attempt.epoch,
  });
}

/** Records one response's usage; a lost acknowledgment is retried under the same id. */
export async function recordUsage(
  env: Env,
  attempt: MeteredAttempt,
  responseId: string,
  usage: MeteredUsage,
): Promise<Json> {
  const command = {
    op: 'sandbox_usage',
    job_id: attempt.job_id,
    epoch: attempt.epoch,
    response_id: responseId,
    usage,
  };
  try {
    return await ledger(env, attempt.project, command);
  } catch (failure) {
    const code = (failure as { code?: string }).code;
    if (code === 'FENCED' || code === 'FORBIDDEN' || code === 'INVALID_INPUT') throw failure;
    return ledger(env, attempt.project, command);
  }
}

const refused = (status: number, message: string) =>
  Response.json({ error: { message } }, { status });

/**
 * Forwards one model request with its credential already set: refused only when the attempt
 * has stopped or its approved allowance is spent, otherwise sent and its response metered.
 * Requests of attempts begun before metering, and token counting, pass unmetered.
 */
export async function forwardModel(
  env: Env,
  waitUntil: (work: Promise<unknown>) => void,
  request: Request,
  headers: Headers,
  attempt: MeteredAttempt | null,
  send: (request: Request) => Promise<Response> = fetch,
): Promise<Response> {
  const format = meterFormat(new URL(request.url).pathname);
  if (!format || !attempt) return send(new Request(request, { headers }));
  let budget: Json;
  try {
    budget = await budgetState(env, attempt);
  } catch (failure) {
    const code = (failure as { code?: string }).code;
    // A stopped attempt makes no more requests; anything else the CLI retries.
    if (code === 'FENCED' || code === 'FORBIDDEN')
      return refused(409, 'This attempt has stopped; no further model requests run.');
    return refused(503, 'The run budget is unavailable; retry shortly.');
  }
  if (budget.exhausted === true) return budgetSpentResponse(format, budget);
  const body = await meteredRequestBody(format, request);
  const response = await send(new Request(request, { headers, body }));
  const id = crypto.randomUUID();
  return meterResponse(response, format, (usage) =>
    waitUntil(
      recordUsage(env, attempt, id, usage).catch((failure) =>
        console.warn('sandbox usage not recorded', attempt.job_id, failure?.code ?? 'ERROR'),
      ),
    ),
  );
}
