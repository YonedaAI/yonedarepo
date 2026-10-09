import { env } from 'cloudflare:workers';
import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { provisionMessage, enqueueProjects } from '../../cloudflare/worker/project-provisioning';
import { projectRoute, sitePolicy } from '../../cloudflare/worker/projects';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';

const bindings = env as unknown as Env;
afterEach(reset);
const password = 'a long email test password';
const owner = 'alex.runner+test@example.com';
async function request(path: string, body?: unknown, cookie?: string) {
  return bindings.SELF.fetch(`https://yoneda/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function signup(name = owner) {
  const response = await request('auth/signup', { username: name, password });
  expect(response.status).toBe(200);
  return { cookie: response.headers.get('set-cookie')!.split(';')[0], account: await response.json<any>() };
}
async function repository() {
  await workspace(bindings, owner, { op: 'project_reserve', id: 'email-project', name: 'Email project', policy: sitePolicy });
  await workspace(bindings, owner, { op: 'project_update', id: 'email-project', status: 'ready' });
  await ledger(bindings, 'email-project', { op: 'init', id: 'email-project', name: 'Email project', workspace: owner, remote: { namespace: 'yoneda-test', name: 'email-project', branch: 'main' }, commit: 'a'.repeat(40), policy: sitePolicy });
}
async function mcp(token: string, repo = 'email-project') {
  return bindings.SELF.fetch(`https://yoneda/mcp/${repo}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
}

it('authenticates a normalized email across signup, eviction, login and logout', async () => {
  const { cookie, account } = await signup(' Alex.Runner+Test@Example.COM ');
  expect(account.username).toBe(owner);
  expect(cookie).not.toContain(owner);
  await evictDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${owner}`)));
  expect(await (await request('auth/session', undefined, cookie)).json()).toMatchObject({ authenticated: true, username: owner });
  expect((await (await request('repositories', undefined, cookie)).json<any>()).identity).toEqual({ role: 'user', username: owner });
  expect((await request('auth/signup', { username: owner.toUpperCase(), password })).status).toBe(400);
  expect((await request('auth/login', { username: owner, password: 'wrong' })).status).toBe(401);
  expect((await request('auth/login', { username: owner.toUpperCase(), password })).status).toBe(200);
  await request('auth/logout', {}, cookie);
  expect(await (await request('auth/session', undefined, cookie)).json()).toEqual({ authenticated: false });
});

it('keeps email MCP grants scoped and revokes them on account recovery', async () => {
  const { cookie, account } = await signup();
  await repository();
  const response = await request('repos/email-project/grants', { label: 'Local agent', scope: 'read' }, cookie);
  expect(response.status).toBe(200);
  const grant = await response.json<any>();
  expect((await mcp(grant.token)).status).toBe(200);
  expect((await mcp(grant.token, 'another-project')).status).toBe(403);
  await evictDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${owner}`)));
  expect((await mcp(grant.token)).status).toBe(200);
  const recovered = await request('auth/recover', { username: owner.toUpperCase(), password: 'a new long email password', recovery_code: account.recovery_code });
  expect(recovered.status).toBe(200);
  expect((await mcp(grant.token)).status).toBe(401);
  expect((await request('repositories', undefined, cookie)).status).toBe(401);
  expect((await request('auth/login', { username: owner, password })).status).toBe(401);
  expect((await request('auth/login', { username: owner, password: 'a new long email password' })).status).toBe(200);
  expect((await request('auth/recover', { username: owner, password, recovery_code: account.recovery_code })).status).toBe(401);
});

it('provisions email-owned projects through queued and alarm dispatch without dropping their owner', async () => {
  await signup();
  const send = vi.fn(async () => {});
  const remote = { [Symbol.dispose]() {}, info: async () => ({ defaultBranch: 'main' }), log: async () => [{ hash: 'c'.repeat(40) }], listTokens: async () => ({ tokens: [] }), revokeToken: async () => true, readCommit: async () => ({ treeHash: 'd'.repeat(40) }), readTree: async () => [{ name: 'README.md', type: 'blob', hash: 'e'.repeat(40) }], readBlob: async () => new Blob(['Source']) };
  const fake = { ...bindings, AGENT_QUEUE: { send }, ARTIFACTS: { get: async () => remote } } as unknown as Env;
  const response = await projectRoute(new Request('https://yoneda/api/projects', { method: 'POST', body: JSON.stringify({ request_id: 'email-request-1234567890', name: 'New email project' }) }), fake, { role: 'user', workspace: owner });
  expect(response?.status).toBe(202);
  const project = await response!.json<any>();
  expect(await enqueueProjects(fake, owner, [{ id: project.id }])).toEqual([project.id]);
  const ack = vi.fn(); const retry = vi.fn();
  await provisionMessage(fake, { body: { v: 1, kind: 'provision', repo_id: project.id, job_id: project.id, workspace: owner }, ack, retry } as unknown as Message<any>);
  expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
  expect((await workspace(bindings, owner, { op: 'project_get', id: project.id })).status).toBe('ready');
  expect((await ledger(bindings, project.id, { op: 'snapshot', _workspace: owner })).repository.workspace).toBe(owner);
  await expect(ledger(bindings, project.id, { op: 'snapshot', _workspace: 'alice' })).rejects.toThrow('another workspace');
});

it('rejects malformed identifiers and encoded cookie/token delimiter attacks', async () => {
  for (const username of ['_admin', 'bad@@example.com', '.alex@example.com', 'alex..runner@example.com', 'alex@-example.com', 'alex@example..com', 'alex@example.com\nadmin', 'a'.repeat(65) + '@example.com', 'alex@exämple.com'])
    expect((await request('auth/signup', { username, password })).status).toBe(400);
  for (const segment of ['%ZZ', '%5Fadmin', 'alex%40example.com', 'alex%2540example%252Ecom']) {
    expect(await (await request('auth/session', undefined, `yoneda_account=${segment}.${'a'.repeat(64)}`)).json()).toEqual({ authenticated: false });
    expect((await mcp(`yoneda.${segment}.grant-1234567890123456.${'b'.repeat(64)}`)).status).toBe(401);
  }
});
