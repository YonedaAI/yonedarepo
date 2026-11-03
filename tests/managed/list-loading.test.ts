// The real managed DOs, with platform discovery deliberately held: no provider or container.
import { expect, it } from 'vitest';
import type { ManagedEnv } from '../../cloudflare/managed/config';
import { managedFetch } from '../../cloudflare/managed/index';
import type { Platform } from '../../cloudflare/managed/platform';
import { access } from '../../cloudflare/managed/workspace-read';
import { harness, newRepo, HEAD_A } from './fake';
import { workspaceStub } from '../../cloudflare/managed/workspace-agents';
import { repoStub } from '../../cloudflare/managed/repo-agents';

const gate = () => {
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  return { held, release };
};
const request = (workspace: string, cookie = 'session=owner') => new Request(
  `https://site.example.com/api/managed/workspaces/${encodeURIComponent(workspace)}`,
  { headers: { cookie } },
);
function observed(h: ReturnType<typeof harness>, change: (req: Request) => Promise<Response>) {
  const counts = { workspace: 0, credit: 0 };
  const count = (namespace: DurableObjectNamespace, name: keyof typeof counts) => ({
    idFromName: (value: string) => namespace.idFromName(value),
    get: (id: DurableObjectId) => { counts[name]++; return namespace.get(id); },
  });
  const env = {
    ...h.env, FAST_AGENTS_LIST: 'on', PLATFORM: { fetch: change },
    WORKSPACES: count(h.env.WORKSPACES, 'workspace'), LEDGER: count(h.env.LEDGER, 'credit'),
  } as unknown as ManagedEnv;
  return { env, counts };
}

it('starts owner-authorized managed reads while repository discovery is held, without returning early', async () => {
  const h = harness(newRepo()), waiting = gate();
  const seen = observed(h, async (req) => {
    if (new URL(req.url).pathname === '/api/v1/repos') await waiting.held;
    return h.platform.fetch(req);
  });
  let settled = false;
  const pending = managedFetch(request(h.platform.account), seen.env).then((r) => { settled = true; return r; });
  try {
    await expect.poll(() => seen.counts.workspace, { timeout: 500 }).toBeGreaterThan(0);
    expect(seen.counts.credit).toBeGreaterThan(0);
    expect(settled).toBe(false);
  } finally { waiting.release(); await pending; }
  const answer = await pending;
  expect(answer.status).toBe(200);
  expect((await answer.json<any>()).agents).toHaveLength(4);
  expect(h.platform.requests.find((r) => r.path.startsWith('/api/auth/session'))?.path).toBe('/api/auth/session?summary=true');
});

it('loads credit alongside held agent state instead of waiting for it', async () => {
  const h = harness(newRepo()), waiting = gate();
  const seen = observed(h, h.platform.fetch);
  const ns = h.env.WORKSPACES;
  const env = { ...seen.env, WORKSPACES: {
    idFromName: (name: string) => ns.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = ns.get(id);
      return new Proxy(stub, { get: (target, key) => {
        if (key === 'settings') return async (agent: any) => { await waiting.held; return target.settings(agent); };
        if (key === 'meta') return (agent: any) => target.meta(agent);
        return Reflect.get(target, key, target);
      } });
    },
  } } as unknown as ManagedEnv;
  let settled = false;
  const pending = managedFetch(request(h.platform.account), env).then((r) => { settled = true; return r; });
  try {
    await expect.poll(() => seen.counts.credit, { timeout: 500 }).toBeGreaterThan(0);
    expect(settled).toBe(false);
  } finally { waiting.release(); await pending; }
  expect((await pending).status).toBe(200);
});

it('denies a reader before any managed state or credit read, even after an owner visited', async () => {
  const h = harness(newRepo());
  const seen = observed(h, h.platform.fetch);
  expect((await managedFetch(request(h.platform.account), seen.env)).status).toBe(200);
  seen.counts.workspace = 0; seen.counts.credit = 0;
  const refused = await managedFetch(request(h.platform.account, 'session=reader'), seen.env);
  expect(refused.status).toBe(403);
  expect(seen.counts).toEqual({ workspace: 0, credit: 0 });
  expect(await refused.json<any>()).not.toHaveProperty('agents');
});

it('accepts a fresh organization-owner proof before held discovery without broadening its repository list', async () => {
  const h = harness(newRepo()), waiting = gate();
  const seen = observed(h, async (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/api/v1/repos') await waiting.held;
    if (path === '/api/v1/orgs') return Response.json({ orgs: [{ org: h.platform.account, role: 'owner' }] });
    return h.platform.fetch(req);
  });
  const pending = managedFetch(request(h.platform.account, 'session=reader'), seen.env);
  try {
    await expect.poll(() => seen.counts.workspace, { timeout: 500 }).toBeGreaterThan(0);
    expect(seen.counts.credit).toBeGreaterThan(0);
  } finally { waiting.release(); }
  const answer = await pending;
  expect(answer.status).toBe(200);
  const body = await answer.json<any>();
  expect(body.repos).toEqual([]); // The fixture's reader does not own these repositories.
  expect(body.agents.every((a: any) => a.enabled_repos.length === 0)).toBe(true);
});

it('keeps the existing owned-repository fallback when session and org discovery are unavailable', async () => {
  const h = harness(newRepo()), waiting = gate();
  const seen = observed(h, async (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/api/v1/repos') { await waiting.held; return h.platform.fetch(req); }
    return Response.json({ error: { code: 'FIXTURE_UNAVAILABLE', message: 'fixture' } }, { status: 503 });
  });
  const pending = managedFetch(request(h.platform.account), seen.env);
  expect(seen.counts).toEqual({ workspace: 0, credit: 0 });
  waiting.release();
  const response = await pending;
  expect(response.status).toBe(200);
  expect((await response.json<any>()).repos).toHaveLength(1);
});

it('does not return an early partial payload when the final repository listing fails', async () => {
  const h = harness(newRepo()), waiting = gate();
  const seen = observed(h, async (req) => {
    if (new URL(req.url).pathname === '/api/v1/repos') {
      await waiting.held;
      return Response.json({ error: { code: 'FIXTURE_LIST_FAILED', message: 'fixture' } }, { status: 503 });
    }
    return h.platform.fetch(req);
  });
  let settled = false;
  const pending = managedFetch(request(h.platform.account), seen.env).then((r) => { settled = true; return r; });
  try {
    await expect.poll(() => seen.counts.credit, { timeout: 500 }).toBeGreaterThan(0);
    expect(settled).toBe(false);
  } finally { waiting.release(); }
  const response = await pending;
  expect(response.status).toBe(503);
  expect(await response.json<any>()).not.toHaveProperty('agents');
});

it('keeps switch-off ordering and identical response fields', async () => {
  const h = harness(newRepo()), waiting = gate();
  const seen = observed(h, async (req) => {
    if (new URL(req.url).pathname === '/api/v1/repos') await waiting.held;
    return h.platform.fetch(req);
  });
  const off = { ...seen.env, FAST_AGENTS_LIST: 'off' };
  const pending = managedFetch(request(h.platform.account), off);
  expect(seen.counts).toEqual({ workspace: 0, credit: 0 });
  waiting.release();
  const before = await (await pending).json<any>();
  const after = await (await managedFetch(request(h.platform.account), seen.env)).json<any>();
  expect(after).toEqual(before);
  const sessions = h.platform.requests.filter((r) => r.path.startsWith('/api/auth/session')).map((r) => r.path);
  expect(sessions).toEqual(['/api/auth/session', '/api/auth/session?summary=true']);
  expect(h.created).toEqual([]);
  expect(h.platform.tokens).toEqual([]);
});

it('keeps an abandoned held request independent of the next visit', async () => {
  const h = harness(newRepo()), waiting = gate(); let n = 0;
  const seen = observed(h, async (req) => {
    if (new URL(req.url).pathname === '/api/v1/repos' && ++n === 1) await waiting.held;
    return h.platform.fetch(req);
  });
  const controller = new AbortController();
  const original = request(h.platform.account);
  const first = managedFetch(new Request(original, { signal: controller.signal }), seen.env);
  try {
    await expect.poll(() => seen.counts.workspace, { timeout: 500 }).toBeGreaterThan(0);
    controller.abort();
    const second = await managedFetch(request(h.platform.account), seen.env);
    expect(second.status).toBe(200);
    expect((await second.json<any>()).agents).toHaveLength(4);
  } finally { waiting.release(); await first; }
});

it('does not start late managed I/O when discovery failed before an owner proof finished', async () => {
  const waiting = gate(); let started = 0;
  const identity = waiting.held.then(() => ({ authenticated: true, username: 'owner' }));
  const membership = waiting.held.then(() => ({ orgs: [{ org: 'owner', role: 'owner' }] }));
  const caller = {
    repos: async () => { throw new Error('discovery unavailable'); },
    session: () => identity,
    orgs: () => membership,
  } as unknown as Platform;
  await expect(access(caller, 'owner', () => { started++; })).rejects.toThrow('discovery unavailable');
  waiting.release();
  await Promise.all([identity, membership]);
  await Promise.resolve(); await Promise.resolve();
  expect(started).toBe(0);
});

it('preserves configured status, current review and repository counts in the complete envelope', async () => {
  const h = harness(newRepo());
  const ws = workspaceStub(h.env, h.platform.account);
  await ws.setUp('code-review', 'owner');
  await ws.save('code-review', '', { trigger: { when: 'push', changes: 'ready_for_review', paths: ['src/'], branches: [] } }, 'owner');
  await ws.setEnabled('code-review', [h.platform.repo]);
  await ws.setActive('code-review', false);
  const repo = repoStub(h.env, h.platform.repo);
  await repo.setEnabled('code-review', true, 'fixture');
  await repo.claim(h.platform.repo, 'code-review', 1, HEAD_A, { harness: 'codex', provider: 'codex', model: 'fixture-model' });
  const before = await (await managedFetch(request(h.platform.account), h.env)).json<any>();
  const after = await (await managedFetch(request(h.platform.account), { ...h.env, FAST_AGENTS_LIST: 'on' })).json<any>();
  expect(after).toEqual(before);
  expect(after.agents[0]).toMatchObject({ active: false, settings: { trigger: { paths: ['src/'] } }, enabled_repos: [h.platform.repo], runs: 1, history: [{ status: 'queued', change: 1 }] });
  expect(h.created).toEqual([]);
});

it('returns safe server phase names and no account identifiers', async () => {
  const h = harness(newRepo());
  const response = await managedFetch(request(h.platform.account), { ...h.env, FAST_AGENTS_LIST: 'on' });
  expect(response.status).toBe(200);
  const timing = response.headers.get('server-timing') ?? '';
  for (const phase of ['managed.platform.session', 'managed.platform.orgs', 'managed.platform.repos', 'managed.access', 'managed.agents', 'managed.credit', 'total'])
    expect(timing).toContain(`${phase};dur=`);
  expect(timing).not.toContain(h.platform.account);
  expect(h.platform.requests).toHaveLength(3);
  expect(h.platform.requests.every((r) => r.method === 'GET')).toBe(true);
});
