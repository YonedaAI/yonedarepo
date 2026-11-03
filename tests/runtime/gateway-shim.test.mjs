// The sandbox's gateway shim (tools/staging/agent-sandbox/gateway-shim.mjs): no credential a CLI
// sends gets through, and only POST to a model route with this run's model passes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refusal, upstreamHeaders } from '../../tools/staging/agent-sandbox/gateway-shim.mjs';

const body = JSON.stringify({ model: 'claude-sonnet-5-5' });

test('only POST to a model route with the run model passes', () => {
  assert.equal(refusal('POST', '/anthropic/v1/messages', body, 'claude-sonnet-5-5'), null);
  assert.equal(refusal('POST', '/openai/responses', JSON.stringify({ model: 'gpt-5.6-luna' }), 'gpt-5.6-luna'), null);
  assert.match(refusal('GET', '/anthropic/v1/messages', body, 'claude-sonnet-5-5'), /only POST/);
  assert.match(refusal('POST', '/anthropic/v1/files', body, 'claude-sonnet-5-5'), /no route/);
  assert.match(refusal('POST', '/anthropic/v1/messages', body, 'claude-haiku-5-5'), /may use claude-haiku-5-5 only/);
  assert.match(refusal('POST', '/anthropic/v1/messages', 'not json', 'claude-sonnet-5-5'), /not JSON/);
});

test('every credential is dropped and the gateway token added', () => {
  const sent = upstreamHeaders({ Authorization: 'Bearer a', 'x-api-key': 'b', 'api-key': 'c', cookie: 'd', host: 'e', 'cf-aig-authorization': 'f', 'anthropic-version': '2023-06-01' }, 'token');
  assert.deepEqual(sent, { 'anthropic-version': '2023-06-01', 'cf-aig-authorization': 'Bearer token' });
});
