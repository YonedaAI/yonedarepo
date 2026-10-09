import type { Env, Json } from './types';
import { workspace } from './workspace';
/** Stream to the harness while observing provider usage. Truncated/unknown usage stays charged. */
export function trackClaudeUsage(
  response: Response,
  env: Env,
  owner: string,
  id: string,
  ceiling: number,
) {
  if (!response.body || !response.ok) return response;
  const decoder = new TextDecoder();
  let pending = '';
  let seenInput = false;
  let seenOutput = false;
  let completed = false;
  let input = 0;
  let output = 0;
  const streamed = response.headers.get('content-type')?.includes('text/event-stream');
  function observe(value: Json) {
    const usage = value.message?.usage ?? value.usage;
    if (usage) {
      if (Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0) {
        const cache =
          (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        if (Number.isSafeInteger(cache) && cache >= 0) {
          input = usage.input_tokens + cache;
          seenInput = true;
        }
      }
      if (Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0) {
        output = usage.output_tokens;
        seenOutput = true;
      }
    }
    if (value.type === 'message_stop' || (!streamed && value.type === 'message')) completed = true;
  }
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length > 1024 * 1024) {
        pending = '';
        seenInput = false;
        completed = false;
        return;
      }
      if (streamed) {
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines)
          if (line.startsWith('data: ')) {
            try {
              observe(JSON.parse(line.slice(6)));
            } catch {
              /* Non-JSON heartbeat. */
            }
          }
      }
    },
    async flush() {
      if (!streamed) {
        try {
          observe(JSON.parse(pending + decoder.decode()));
        } catch {
          return;
        }
      }
      if (!completed || !seenInput || !seenOutput) return;
      const charge = input * 6 + output * 30;
      if (!Number.isSafeInteger(charge) || charge > ceiling) return;
      try {
        await workspace(env, owner, { op: 'budget_settle', id, amount: charge });
      } catch {
        /* Retain reservation on acknowledgment loss. */
      }
    },
  });
  return new Response(response.body.pipeThrough(transform), response);
}
