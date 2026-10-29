// Token usage out of model responses as they pass through the outbound handler: Anthropic
// Messages and OpenAI Responses, JSON or server-sent events. Streams are metered on the fly by a
// pass-through transform that reports once the stream ends.
import type { TokenUsage } from '../../shared/managed-agents';

const n = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);

/** Usage from one complete JSON body (either protocol); null when it carries none. */
export function usageOfBody(body: any): TokenUsage | null {
  const u = body?.usage ?? body?.response?.usage;
  if (!u || typeof u !== 'object') return null;
  if ('input_tokens_details' in u || 'output_tokens_details' in u) {
    // OpenAI Responses: input_tokens includes the cached ones.
    const cached = n(u.input_tokens_details?.cached_tokens);
    return {
      input: Math.max(0, n(u.input_tokens) - cached),
      cache_write: 0,
      cache_read: cached,
      output: n(u.output_tokens),
    };
  }
  return {
    input: n(u.input_tokens),
    cache_write: n(u.cache_creation_input_tokens),
    cache_read: n(u.cache_read_input_tokens),
    output: n(u.output_tokens),
  };
}

/** Folds one SSE event's data into the running usage (Anthropic and OpenAI events). */
export function foldEvent(usage: TokenUsage, data: any): TokenUsage {
  if (data?.type === 'message_start') return usageOfBody(data.message) ?? usage;
  if (data?.type === 'message_delta' && data.usage) {
    // Output is cumulative; a provider may also report input here.
    return {
      input: n(data.usage.input_tokens) || usage.input,
      cache_write: n(data.usage.cache_creation_input_tokens) || usage.cache_write,
      cache_read: n(data.usage.cache_read_input_tokens) || usage.cache_read,
      output: n(data.usage.output_tokens) || usage.output,
    };
  }
  if (data?.type === 'response.completed' || data?.type === 'response.incomplete')
    return usageOfBody(data.response) ?? usage;
  return usage;
}

const EMPTY: TokenUsage = { input: 0, cache_write: 0, cache_read: 0, output: 0 };

/** A pass-through stream that parses SSE `data:` lines and calls `done` with the usage (null
 * when the stream carried none) once it ends. */
export function meterStream(done: (usage: TokenUsage | null) => Promise<void>) {
  const decoder = new TextDecoder();
  let pending = '';
  let usage = EMPTY;
  let seen = false;
  const take = (line: string) => {
    if (!line.startsWith('data:')) return;
    try {
      const next = foldEvent(usage, JSON.parse(line.slice(5).trim()));
      if (next !== usage) seen = true;
      usage = next;
    } catch {
      // A keep-alive or [DONE] line.
    }
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      lines.forEach(take);
    },
    async flush() {
      take(pending);
      await done(seen ? usage : null);
    },
  });
}
