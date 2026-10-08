import type { Json } from './types';

type Usage = { input_tokens: number; output_tokens: number };
const valid = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

/** Observe trusted upstream usage without altering the harness stream. Unknown usage stays reserved. */
export function trackProviderUsage(
  response: Response,
  harness: 'codex' | 'claude' | 'gemini',
  settle: (usage: Usage) => Promise<unknown>,
) {
  if (!response.ok || !response.body) return response;
  const decoder = new TextDecoder();
  const streamed = response.headers.get('content-type')?.includes('text/event-stream');
  let pending = '';
  let invalid = false;
  let completed = false;
  let input: number | undefined;
  let output: number | undefined;
  function observe(value: Json) {
    if (harness === 'claude') {
      const usage = value.message?.usage ?? value.usage;
      if (usage) {
        if (usage.input_tokens !== undefined) {
          const cached = usage.cache_read_input_tokens ?? 0;
          const creation = usage.cache_creation_input_tokens ?? 0;
          if (![usage.input_tokens, cached, creation].every(valid)) invalid = true;
          else input = usage.input_tokens + cached + creation;
        }
        if (usage.output_tokens !== undefined) {
          if (!valid(usage.output_tokens)) invalid = true;
          else output = usage.output_tokens;
        }
      }
      if (value.type === 'message_stop' || (!streamed && value.type === 'message'))
        completed = true;
    } else if (harness === 'codex') {
      const result = value.response ?? value;
      if (value.type === 'response.completed' || (!streamed && result.status === 'completed')) {
        completed = true;
        if (valid(result.usage?.input_tokens) && valid(result.usage?.output_tokens)) {
          input = result.usage.input_tokens;
          output = result.usage.output_tokens;
        } else invalid = true;
      }
    } else {
      if (value.candidates?.some((candidate: Json) => candidate.finishReason)) completed = true;
      const usage = value.usageMetadata;
      if (usage) {
        const thoughts = usage.thoughtsTokenCount ?? 0;
        if ([usage.promptTokenCount, usage.candidatesTokenCount, thoughts].every(valid)) {
          input = usage.promptTokenCount;
          output = usage.candidatesTokenCount + thoughts;
        } else invalid = true;
      }
    }
  }
  function line(value: string) {
    if (!value.startsWith('data:')) return;
    const data = value.slice(5).trim();
    if (data === '[DONE]') return;
    try {
      observe(JSON.parse(data));
    } catch {
      invalid = true;
    }
  }
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (invalid) return;
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length > 1024 * 1024) {
        invalid = true;
        pending = '';
      } else if (streamed) {
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const value of lines) line(value);
      }
    },
    async flush() {
      if (invalid) return;
      pending += decoder.decode();
      if (streamed) line(pending);
      else {
        try {
          observe(JSON.parse(pending));
        } catch {
          return;
        }
      }
      if (invalid || !completed || !valid(input) || !valid(output)) return;
      try {
        await settle({ input_tokens: input, output_tokens: output });
      } catch {
        /* Keep the reservation on storage failure or acknowledgement loss. */
      }
    },
  });
  return new Response(response.body.pipeThrough(transform), response);
}
