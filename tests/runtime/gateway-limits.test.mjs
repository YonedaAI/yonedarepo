import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { GatewayLimits, readBody } from '../../tools/staging/agent-sandbox/gateway-limits.mjs';
import { serve } from '../../tools/staging/agent-sandbox/gateway-shim.mjs';

test('one sandbox caps request count, aggregate input and per-response output', () => {
  const limit = new GatewayLimits({ requests: 2, inputBytes: 1000, outputTokens: 2048 });
  const body = JSON.stringify({ model: 'fixture', max_output_tokens: 90000 });
  assert.equal(JSON.parse(limit.admit('/openai/responses', body)).max_output_tokens, 2048);
  limit.admit('/openai/responses', JSON.stringify({ model: 'fixture' }));
  assert.throws(() => limit.admit('/openai/responses', body), /request limit/);
  const input = new GatewayLimits({ inputBytes: Buffer.byteLength(body) });
  input.admit('/openai/responses', body);
  assert.throws(() => input.admit('/openai/responses', body), /input limit/);
});

test('Claude limits preserve a smaller requested output and valid manual thinking', () => {
  const limit = new GatewayLimits({ outputTokens: 2048 });
  assert.equal(JSON.parse(limit.admit('/anthropic/v1/messages', JSON.stringify({ max_tokens: 1024 }))).max_tokens, 1024);
  const bounded = JSON.parse(limit.admit('/anthropic/v1/messages', JSON.stringify({ max_tokens: 50000, thinking: { type: 'enabled', budget_tokens: 16000 } })));
  assert.equal(bounded.max_tokens, 2048);
  assert.equal(bounded.thinking.budget_tokens, 2047);
  assert.throws(() => limit.admit('/openai/responses', JSON.stringify({ max_output_tokens: 'unlimited' })), /output limit/);
});

test('output aliases and extra completions cannot bypass the per-response ceiling', () => {
  const limit = new GatewayLimits({ outputTokens: 2048 });
  const bounded = JSON.parse(limit.admit('/glm/chat/completions', JSON.stringify({ max_completion_tokens: 99999 })));
  assert.equal(bounded.max_tokens, 2048);
  assert.equal(bounded.max_completion_tokens, 2048);
  for (const extra of [{ n: 2 }, { best_of: 5 }])
    assert.throws(() => limit.admit('/glm/chat/completions', JSON.stringify(extra)), /one completion/);
});

test('oversized chunked input is rejected before it can be buffered without bound', async () => {
  await assert.rejects(readBody(Readable.from(['1234', '5678']), 6), /body limit/);
  assert.equal(await readBody(Readable.from(['123', '456']), 6), '123456');
});

test('the actual local shim enforces limits before forwarding a paid request', async t => {
  const forwarded = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    forwarded.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.end('{"ok":true}');
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const shim = serve({ gateway: `http://127.0.0.1:${upstream.address().port}`, token: 'fixture', model: 'fixture', port: 0, limits: new GatewayLimits({ requests: 1, outputTokens: 2048 }) });
  await once(shim, 'listening');
  t.after(() => { shim.closeAllConnections(); shim.close(); upstream.closeAllConnections(); upstream.close(); });
  const send = () => fetch(`http://127.0.0.1:${shim.address().port}/openai/responses`, { method: 'POST', body: JSON.stringify({ model: 'fixture', max_output_tokens: 50000 }) });
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 429);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].max_output_tokens, 2048);
});
