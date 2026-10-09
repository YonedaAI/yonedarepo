import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const relay = resolve('tools/context-study/mcp-relay.mjs');
const token = 'private-test-grant';
const session = 'server-bound-session';
async function exercise(messages, upstream) {
  const directory = mkdtempSync(join(tmpdir(), 'yoneda-relay-test-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests.push({ headers: req.headers, body });
    const reply = upstream(body);
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = join(directory, 'private.json');
  writeFileSync(config, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp/private-repo`, token, session }), { mode: 0o600 });
  const child = spawn(process.execPath, [relay, config], { stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, stderr);
    assert.ok(!stdout.includes(token) && !stderr.includes(token), 'private grant must not enter output');
    return { replies: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), requests };
  } finally {
    clearTimeout(timer); child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
}

test('local stdio relay retains the contribution session across initialize and agent reads', async () => {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'context_get', arguments: { id: 'context:history', session_id: 'model-forged' } } },
  ];
  const result = await exercise(messages, body => ({ body: { jsonrpc: '2.0', id: body.id, result: body.method === 'ping' ? {} : { marker: body.method } } }));
  assert.deepEqual(result.requests.map(request => request.body.method), ['ping', 'tools/list', 'tools/call']);
  for (const request of result.requests) {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers['mcp-session-id'], session);
    assert.equal(request.headers['mcp-protocol-version'], '2025-06-18');
  }
  assert.equal(result.replies[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(result.replies.map(reply => reply.id), [1, 2, 3]);
  assert.deepEqual(result.requests[2].body, messages[3]);
  assert.equal(result.replies[2].result.marker, 'tools/call');
});

test('revoked session fails closed without initializing another server session or exposing upstream errors', async () => {
  const result = await exercise([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'repo_context' } },
  ], () => ({ status: 404, body: { error: { message: token } } }));
  assert.deepEqual(result.requests.map(request => request.body.method), ['ping', 'tools/call']);
  assert.ok(result.replies.every(reply => reply.error?.code === -32000));
  assert.ok(result.requests.every(request => request.headers['mcp-session-id'] === session));
});

test('initialize validates the upstream JSON-RPC ping result, not only HTTP success', async () => {
  const result = await exercise([{ jsonrpc: '2.0', id: 1, method: 'initialize' }], body => ({ body: { jsonrpc: '2.0', id: body.id, error: { code: -32600, message: 'Invalid session protocol' } } }));
  assert.equal(result.replies[0].result, undefined);
  assert.equal(result.replies[0].error?.code, -32000);
});
