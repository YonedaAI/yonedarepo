import { expect, it } from 'vitest';
import { readJson } from '../../cloudflare/worker/http';
import { MODEL_REQUEST_LIMIT } from '../../cloudflare/worker/models';

// Long agent conversations (a coordinator after many tool calls) send multi-megabyte requests;
// spend is capped by tokens and budgets, not by the proxy's body size.
it('accepts a long agent conversation through the model proxy body limit', async () => {
  const history = Array.from({ length: 400 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: 'x'.repeat(4000),
  }));
  const body = JSON.stringify({ model: 'glm-5.3-flash', messages: history });
  expect(body.length).toBeGreaterThan(1_500_000);
  const parsed = await readJson(new Request('https://proxy.test/v1/messages', { method: 'POST', body }), MODEL_REQUEST_LIMIT);
  expect(parsed.messages).toHaveLength(400);
});
