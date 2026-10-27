// Model responses in each provider's documented wire format, one per API a sandbox CLI calls.
// Test fixtures: written to the providers' published stream shapes (event order, keep-alives,
// usage placement), not captured from a live provider, since local tests make no paid calls.
// The sandbox smoke (tools/staging/sandbox-smoke.mjs) is the live cross-check.

const sse = (events: [string | null, unknown][]) =>
  events
    .map(([event, data]) =>
      `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`,
    )
    .join('');

/** Anthropic Messages SSE (Claude Code, opencode with an Anthropic-format connection). */
export const anthropicStream = sse([
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        model: 'glm-5.3-flash',
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 1200,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 5000,
          output_tokens: 1,
        },
      },
    },
  ],
  ['ping', { type: 'ping' }],
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done: added add(a, b).' } },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 420 },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
]);
export const anthropicUsage = {
  input_tokens: 1200,
  cache_read_input_tokens: 5000,
  cache_creation_input_tokens: 300,
  output_tokens: 420,
};

/** Anthropic Messages, not streamed. */
export const anthropicJson = JSON.stringify({
  id: 'msg_02',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 12 },
});

/** OpenAI Responses SSE (Codex CLI). `input_tokens` includes the cached ones. */
export const responsesStream = sse([
  [
    'response.created',
    { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', object: 'response', status: 'in_progress', usage: null } },
  ],
  [
    'response.output_text.delta',
    { type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Done.' },
  ],
  [
    'response.completed',
    {
      type: 'response.completed',
      sequence_number: 2,
      response: {
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        usage: {
          input_tokens: 8000,
          input_tokens_details: { cached_tokens: 6000 },
          output_tokens: 700,
          output_tokens_details: { reasoning_tokens: 300 },
          total_tokens: 8700,
        },
      },
    },
  ],
]);
export const responsesUsage = {
  input_tokens: 2000,
  cache_read_input_tokens: 6000,
  cache_creation_input_tokens: 0,
  output_tokens: 700,
};

/** Chat Completions SSE (MiMo Code) with `include_usage`: usage in a last, choice-less chunk. */
export const chatStream = sse([
  [null, { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Do' } }], usage: null }],
  [null, { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ne.' }, finish_reason: 'stop' }], usage: null }],
  [
    null,
    {
      id: 'c1',
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 3000, completion_tokens: 250, total_tokens: 3250, prompt_tokens_details: { cached_tokens: 1000 } },
    },
  ],
  [null, '[DONE]'],
]);
export const chatUsage = {
  input_tokens: 2000,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 0,
  output_tokens: 250,
};

/** Gemini `streamGenerateContent?alt=sse` (opencode): cumulative `usageMetadata`. */
export const geminiStream = sse([
  [null, { candidates: [{ content: { parts: [{ text: 'Do' }], role: 'model' } }], usageMetadata: { promptTokenCount: 4000, candidatesTokenCount: 2, totalTokenCount: 4002 } }],
  [
    null,
    {
      candidates: [{ content: { parts: [{ text: 'ne.' }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4000, cachedContentTokenCount: 1000, candidatesTokenCount: 80, thoughtsTokenCount: 120, totalTokenCount: 4200 },
    },
  ],
]);
export const geminiUsage = {
  input_tokens: 3000,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 0,
  output_tokens: 200,
};
