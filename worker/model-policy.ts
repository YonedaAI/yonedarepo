import { prepareGeminiRequest } from './gemini-policy';
import type { Json } from './types';

const upstreams = {
  codex: 'https://api.openai.com',
  claude: 'https://api.anthropic.com',
  mimo: 'https://api.xiaomimimo.com/anthropic',
  zai: 'https://api.z.ai/api/anthropic',
};
export function prepareModelRequest(
  job: Json,
  harness: 'codex' | 'claude' | 'gemini',
  path: string,
  input: Json,
) {
  if (harness === 'gemini') return prepareGeminiRequest(job, path, input);
  const execution = job.payload?.execution;
  const provider = execution?.provider ?? execution?.harness;
  if (job.kind !== 'agent' || execution.harness !== harness || !(provider in upstreams))
    throw new Error('Provider outside attempt scope');
  if (
    !(
      harness === 'codex' ? ['/v1/responses'] : ['/v1/messages', '/v1/messages/count_tokens']
    ).includes(path)
  )
    throw new Error('Provider endpoint not allowed');
  if ((provider === 'codex') !== (harness === 'codex'))
    throw new Error('Provider protocol mismatch');
  const model = job.model;
  if (typeof model !== 'string' || !model || model.length > 128)
    throw new Error('Configured model required');
  if (provider === 'claude' && model !== 'claude-sonnet-4-6')
    throw new Error('Claude testing is limited to claude-sonnet-4-6');
  const body = structuredClone(input);
  body.model = model;
  for (const key of [
    'service_tier',
    'speed',
    'inference_geo',
    'mcp_servers',
    'container',
    'context_management',
    'previous_response_id',
  ])
    delete body[key];
  if (harness === 'codex') {
    body.max_output_tokens = Math.max(
      1,
      Math.min(Math.floor(Number(body.max_output_tokens)) || 4096, 4096),
    );
    body.store = false;
    if (body.tools?.some((tool: Json) => !['function', 'custom'].includes(tool.type)))
      throw new Error('Server-side paid tools are unavailable');
  } else {
    if (body.tools?.some((tool: Json) => tool.type && tool.type !== 'custom'))
      throw new Error('Server-side paid tools are unavailable');
    function validate(value: unknown) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) validate(item);
        return;
      }
      const object = value as Json;
      if (['image', 'document', 'container_upload'].includes(object.type))
        throw new Error('Testing accepts text and local tools only');
      for (const child of Object.values(object)) validate(child);
    }
    validate(body);
    body.max_tokens = Math.max(1, Math.min(Math.floor(Number(body.max_tokens)) || 4096, 4096));
    if (path.endsWith('/count_tokens')) delete body.max_tokens;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
  if (bytes > 256 * 1024) throw new Error('Model input exceeds 256 KiB testing limit');
  // Sonnet 4.6: up to $6/M input including one-hour cache creation; output ceiling
  // uses $30/M, twice the standard price. One token per UTF-8 byte plus overhead
  // deliberately over-reserves. No server tools, images, premium tier or residency.
  const reservation =
    provider === 'claude' && !path.endsWith('/count_tokens')
      ? (bytes + 8192) * 6 + body.max_tokens * 30
      : 0;
  return {
    provider: provider as keyof typeof upstreams,
    url: upstreams[provider as keyof typeof upstreams] + path,
    body,
    reservation,
  };
}
