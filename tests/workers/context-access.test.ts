import { env } from 'cloudflare:workers';
import { reset, evictDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger, object, sha } from '../../cloudflare/worker/storage';
import { workspace } from '../../cloudflare/worker/workspace';
import { sitePolicy } from '../../cloudflare/worker/site-policy';
import type { Env } from '../../cloudflare/worker/types';
const bindings = env as unknown as Env;
afterEach(reset);
const repo = 'context-repo';
const grant = 'grant-context-12345678';
const agents = [{ provider: 'codex', model: 'gpt-5.6-luna', strategy: 'minimal' }];
async function setup() {
  await workspace(bindings, 'alice', { op: 'signup', username: 'alice', password: 'long test password', salt: '01'.repeat(16), recovery_hash: 'b'.repeat(64), session_hash: 'a'.repeat(64) });
  await workspace(bindings, 'alice', { op: 'project_reserve', id: repo, name: 'Context', policy: sitePolicy });
  await workspace(bindings, 'alice', { op: 'project_update', id: repo, status: 'ready' });
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Context', workspace: 'alice', remote: { namespace: 'yoneda-test', name: repo }, commit: 'a'.repeat(40), policy: sitePolicy });
  return issue(grant);
}
async function issue(id: string, scope = 'read') {
  const secret = 'b'.repeat(64);
  await workspace(bindings, 'alice', { op: 'grant_issue', id, repo, label: 'Context test', scope, expires: Date.now() + 60000, token_hash: await sha(secret) });
  return `yoneda.alice.${id}.${secret}`;
}
function request(token: string, method = 'POST', body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }, session?: string, extra = {}) {
  return bindings.SELF.fetch(`https://yoneda/mcp/${repo}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(session ? { 'Mcp-Session-Id': session } : {}), ...extra },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}
async function initialize(token: string) {
  const result = await request(token, 'POST', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  expect(result.status, await result.clone().text()).toBe(200);
  const id = result.headers.get('Mcp-Session-Id');
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  return id!;
}
it('persists server sessions, rejects cross-grant/revoked sessions, and honors HTTP lifecycle', async () => {
  const token = await setup();
  const session = await initialize(token);
  await evictDurableObject(bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo)));
  expect((await request(token, 'POST', undefined, session)).status).toBe(200);
  const other = await issue('grant-context-87654321');
  expect((await request(other, 'POST', undefined, session)).status).toBe(404);
  expect((await request(token, 'POST', undefined, session, { 'MCP-Protocol-Version': '2099-01-01' })).status).toBe(400);
  expect((await request(token, 'GET', undefined, session)).status).toBe(405);
  const notification = await request(token, 'POST', { jsonrpc: '2.0', method: 'notifications/initialized' }, session);
  expect(notification.status).toBe(202); expect(await notification.text()).toBe('');
  expect((await request(token, 'DELETE', undefined, session)).status).toBe(204);
  expect((await request(token, 'POST', undefined, session)).status).toBe(404);
  const fresh = await initialize(token);
  await workspace(bindings, 'alice', { op: 'grant_revoke', id: grant });
  expect((await request(token, 'POST', undefined, fresh)).status).toBe(401);
});
it('records successful reads under server identity, preserves stateless attribution, and usage does not record itself', async () => {
  const token = await setup();
  const session = await initialize(token);
  const read = (name: string, sessionId?: string) => request(token, 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { call_id: 'model-forgery', run_id: 'forged', job_id: 'forged', session_id: 'forged' } } }, sessionId);
  for (const sessionId of [undefined, session]) {
    const result = await (await read('repo_context', sessionId)).json<any>();
    expect(result.result.isError, JSON.stringify(result)).not.toBe(true);
  }
  const usage = await ledger(bindings, repo, { op: 'context_usage', _workspace: 'alice', _grant: grant });
  expect(usage.counts.read_calls).toBe(2);
  expect(usage.entries).toHaveLength(2);
  expect(usage.entries.every((r: any) => r.run_id === null && r.call_id !== 'model-forgery')).toBe(true);
  expect(usage.entries.map((r: any) => r.session_id).sort()).toEqual([null, session].sort());
  const result = await request(token, 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'context_usage', arguments: {} } }, session);
  expect((await result.json<any>()).result.isError).not.toBe(true);
  expect((await ledger(bindings, repo, { op: 'context_usage', _workspace: 'alice', _grant: grant })).counts.read_calls).toBe(2);
});

it('records artifact access only after verified R2 content and never on failed lookup', async () => {
  const token = await setup();
  await ledger(bindings, repo, { op: 'start_run', id: 'run-context', intent: 'Inspect context', agents });
  const job = await ledger(bindings, repo, { op: 'claim', job_id: 'job:run-context:agent-1' });
  const stored = await object(bindings, 'Verified research');
  await ledger(bindings, repo, { op: 'publish_artifact', job_id: job.id, epoch: job.epoch, id: 'artifact:research', digest: stored.digest, label: 'Research', kind: 'research', metadata: { assumptions: [{ statement: 'Response stays bounded', metric: 'latency_ms', limit: 100, path: 'index.html' }] } });
  const read = (id: string) => request(token, 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'artifact_get', arguments: { id } } });
  const good = await (await read('artifact:research')).json<any>();
  expect(good.result.isError, JSON.stringify(good)).not.toBe(true);
  expect(JSON.parse(good.result.content[0].text).content).toBe('Verified research');
  await bindings.OBJECTS.put(`sha256/${stored.digest}`, 'Tampered bytes');
  expect((await (await read('artifact:research')).json<any>()).result.isError).toBe(true);
  expect((await (await read('artifact:missing')).json<any>()).result.isError).toBe(true);
  const usage = await ledger(bindings, repo, { op: 'context_usage', _workspace: 'alice', _grant: grant });
  expect(usage.counts.read_calls).toBe(1);
  expect(usage.entries[0].targets[0]).toMatchObject({ id: 'artifact:research', digest: stored.digest });
});
it('derives hosted usage from the active job and fences stale attempts before delivery', async () => {
  await setup();
  await ledger(bindings, repo, { op: 'start_run', id: 'run-hosted', intent: 'Inspect context', agents });
  const job = await ledger(bindings, repo, { op: 'claim', job_id: 'job:run-hosted:agent-1' });
  const { hostedMcp } = await import('../../cloudflare/worker/hosted-mcp');
  const scope = { repo_id: repo, job, supervisor: 'unused-test-supervisor', model_calls: 0, created_at: Date.now() };
  const read = await hostedMcp(bindings, scope, { name: 'repo_context', arguments: { job_id: 'forged', epoch: 999 } });
  expect(read.status).toBe(200);
  const usage = await (await hostedMcp(bindings, scope, { name: 'context_usage', arguments: { run_id: 'forged', job_id: 'forged', epoch: job.epoch } })).json<any>();
  expect(usage.run_id).toBe('run-hosted');
  expect(usage.counts.read_calls).toBe(1);
  expect(usage.entries[0]).toMatchObject({ job_id: job.id, epoch: job.epoch, run_id: 'run-hosted' });
  await ledger(bindings, repo, { op: 'cancel_run', run_id: 'run-hosted' });
  await expect(hostedMcp(bindings, scope, { name: 'repo_context', arguments: {} })).rejects.toThrow();
});

it('binds subsequent session reads to a contribution without reassigning earlier receipts', async () => {
  await setup();
  const token = await issue('grant-contribute-12345678', 'contribute');
  const session = await initialize(token);
  const { remoteMcp } = await import('../../cloudflare/worker/remote-mcp');
  const remote = { [Symbol.dispose]() {}, fork: async () => ({ token: 'test-capability' }), info: async () => ({}), listTokens: async () => ({ tokens: [] }), revokeToken: async () => true };
  const scoped = { ...bindings, ARTIFACTS: { get: async () => remote } } as unknown as Env;
  const call = async (name: string, args = {}) => {
    const response = await remoteMcp(new Request(`https://yoneda/mcp/${repo}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'Mcp-Session-Id': session, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), scoped, repo);
    const value = await response.json<any>();
    expect(value.result.isError, JSON.stringify(value)).not.toBe(true);
    return JSON.parse(value.result.content[0].text);
  };
  await call('repo_context');
  const attempt = await call('attempt_begin', { request_id: crypto.randomUUID(), intent: 'Inspect navigation' });
  await call('repo_context');
  const bound = await call('context_usage');
  expect(bound.run_id).toBe(attempt.execution.run_id);
  expect(bound.counts.read_calls).toBe(1);
  expect(bound.entries[0]).toMatchObject({ session_id: session, execution_id: attempt.attempt_id });
  const before = await ledger(bindings, repo, { op: 'context_usage', _workspace: 'alice', _grant: 'grant-contribute-12345678' });
  expect(before.counts.read_calls).toBe(1);
  expect(before.entries[0]).toMatchObject({ run_id: null, session_id: session });
});
