// Per-container ceilings. Both providers count reasoning in the output limit:
// https://developers.openai.com/api/reference/resources/responses/methods/create
// https://platform.claude.com/docs/en/api/http/messages
export const LIMITS = { requests: 64, inputBytes: 8 * 1024 * 1024, bodyBytes: 1024 * 1024, outputTokens: 8192 };

export async function readBody(stream, most = LIMITS.bodyBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const data = Buffer.from(chunk);
    bytes += data.length;
    if (bytes > most) throw new Error('sandbox model body limit reached');
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class GatewayLimits {
  requests = 0;
  inputBytes = 0;
  constructor(options = {}) {
    this.limits = { ...LIMITS, ...options };
    for (const [key, value] of Object.entries(this.limits))
      if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS[key]) throw new Error('invalid sandbox model limit');
  }
  admit(path, body) {
    if (this.requests >= this.limits.requests) throw new Error('sandbox model request limit reached');
    const bytes = Buffer.byteLength(body);
    if (this.inputBytes + bytes > this.limits.inputBytes) throw new Error('sandbox model input limit reached');
    const json = JSON.parse(body);
    if (!path.endsWith('/count_tokens')) {
      if ((json.n !== undefined && json.n !== 1) || (json.best_of !== undefined && json.best_of !== 1)) throw new Error('sandbox requests allow one completion only');
      for (const field of ['max_tokens', 'max_output_tokens', 'max_completion_tokens']) {
        if (json[field] === undefined) continue;
        if (!Number.isSafeInteger(json[field]) || json[field] < 1) throw new Error('invalid model output limit');
        json[field] = Math.min(json[field], this.limits.outputTokens);
      }
      const key = path === '/openai/responses' ? 'max_output_tokens' : 'max_tokens';
      const asked = json[key] ?? this.limits.outputTokens;
      if (!Number.isSafeInteger(asked) || asked < 1) throw new Error('invalid model output limit');
      json[key] = Math.min(asked, this.limits.outputTokens);
      if (json.thinking?.type === 'enabled' && Number.isSafeInteger(json.thinking.budget_tokens)) {
        json.thinking.budget_tokens = Math.min(json.thinking.budget_tokens, json[key] - 1);
        if (json.thinking.budget_tokens < 1024) throw new Error('model output limit leaves no manual thinking budget');
      }
    }
    this.requests += 1;
    this.inputBytes += bytes;
    return JSON.stringify(json);
  }
}
