import { expect, it, vi } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { fetchHead } from '../../cloudflare/worker/repo-head-holder';
import { isolateTrees } from '../../cloudflare/worker/repo-tree-memo';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, drainObjects, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const switched = { ...scoped, LAND_COMBINERS: bindings.LAND_COMBINERS, AUTOMATIC_LOCALITY: 'on', SHARED_READ_TREES: 'on' } as Env;

async function setup(name: string) {
  const cookie = await signup(name);
  const made = await api('/repos', { cookie }, { body: { name, files: [file('folder/a.txt', 'before\n')], author, policy: { approvals: 0, required_checks: [] } } }, switched);
  expect(made.status).toBe(200);
  await drainObjects(switched);
  const head = await fetchHead(switched, made.body.id);
  return { cookie, id: made.body.id as string, head };
}

async function read(repo: string, cookie: string, target = switched, query = '/blob?path=folder/a.txt', continent = 'NA', signal?: AbortSignal) {
  const res = await platformFetch(new Request(`https://yoneda/api/v1/repos/${repo}${query}`, { headers: { cookie }, cf: { continent }, signal }), target);
  return { status: res.status, body: await res.json<any>() };
}

function treesVia(target: Env, trees: (stub: any, args: any[]) => Promise<unknown>) {
  const ns = target.LAND_COMBINERS!;
  return { ...target, LAND_COMBINERS: {
    idFromName: (name: string) => ns.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = ns.get(id);
      return new Proxy(stub, { get: (s, key) => key === 'trees' ? (...args: any[]) => trees(s, args) : typeof Reflect.get(s, key) === 'function' ? (...args: any[]) => (s as any)[key](...args) : Reflect.get(s, key) });
    },
  } } as unknown as Env;
}

it('cold independent readers reuse holder trees, then warm walks make no holder call', async () => {
  const r = await setup('shared-read-cold');
  const root = r.head.head.tree as string;
  const rootListing = await api(`/repos/${r.id}/tree`, { cookie: r.cookie }, {}, switched);
  const folder = rootListing.body.entries.find((entry: any) => entry.name === 'folder').id;
  isolateTrees.clear();
  let asks = 0;
  let copies = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ns = switched.READ_COPIES!;
  const target = treesVia({ ...switched, READ_COPIES: {
    idFromName: (name: string) => ns.idFromName(name),
    get: (id: DurableObjectId, options: DurableObjectNamespaceGetDurableObjectOptions) => ({ fetch: (url: string, init: RequestInit) => {
      const command = JSON.parse(String(init.body));
      if (command.op === 'copy_get' && [root, folder].includes(command.id)) copies++;
      return ns.get(id, options).fetch(url, init);
    } }),
  } } as unknown as Env, async (stub, args) => { asks++; const answer = await stub.trees(...args); await gate; return answer; });
  const work = Array.from({ length: 25 }, () => read(r.id, r.cookie, target));
  try {
    await vi.waitFor(() => expect(asks).toBe(25));
    expect(copies).toBe(0);
  } finally {
    release();
    for (const result of await Promise.all(work)) expect([result.status, result.body.content]).toEqual([200, 'before\n']);
  }
  expect((await read(r.id, r.cookie, target)).body.content).toBe('before\n');
  expect(asks).toBe(25);
  expect(copies).toBe(0);
});

it('selected historical and staged commits keep their exact root and revision', async () => {
  const r = await setup('shared-read-selected');
  const made = await api(`/repos/${r.id}/commits`, { cookie: r.cookie }, { body: { ref: 'main', changes: [file('folder/a.txt', 'staged\n')], message: 'staged', author } }, switched);
  expect(made.status).toBe(200);
  const seen: any[][] = [];
  const target = treesVia(switched, async (stub, args) => { seen.push(args); return stub.trees(...args); });
  isolateTrees.clear();
  const staged = await read(r.id, r.cookie, target, `/blob?path=folder/a.txt&commit=${made.body.commit}`);
  expect([staged.status, staged.body.content, staged.body.commit]).toEqual([200, 'staged\n', made.body.commit]);
  expect(seen[0][3]).toBe(made.body.commit);
  isolateTrees.clear();
  const historical = await read(r.id, r.cookie, target, `/blob?path=folder/a.txt&commit=${r.head.head.id}`);
  expect([historical.status, historical.body.content, historical.body.commit]).toEqual([200, 'before\n', r.head.head.id]);
  const [, root, paths, revision] = seen[1];
  expect({ root, paths, revision }).toEqual({ root: r.head.head.tree, paths: ['folder/a.txt'], revision: r.head.head.id });
  isolateTrees.clear();
  expect((await read(r.id, r.cookie, target, '/tree?path=folder')).body.entries.map((entry: any) => entry.name)).toEqual(['a.txt']);
  expect(seen[2][2]).toEqual(['folder/']);
});

it('off, unknown and foreign regions keep ordinary nearby reads', async () => {
  const r = await setup('shared-read-regions');
  let asks = 0;
  const target = treesVia(switched, async () => { asks++; throw new Error('unexpected holder request'); });
  for (const [env, region] of [[{ ...target, SHARED_READ_TREES: 'off' }, 'NA'], [target, 'EU'], [target, 'T1']] as const) {
    isolateTrees.clear();
    expect((await read(r.id, r.cookie, env, undefined, region)).body.content).toBe('before\n');
  }
  expect(asks).toBe(0);
});

it('an unavailable tree holder falls back to the exact ordinary tree walk', async () => {
  const r = await setup('shared-read-fallback');
  let asks = 0;
  const target = treesVia(switched, async () => { asks++; throw new Error('simulated holder outage'); });
  isolateTrees.clear();
  expect((await read(r.id, r.cookie, target)).body.content).toBe('before\n');
  expect(asks).toBe(1);
});

it('forks retain inherited access and avoid the shared-read holder path', async () => {
  const r = await setup('shared-read-fork');
  const fork = await api(`/repos/${r.id}/fork`, { cookie: r.cookie }, { body: { name: 'forked' } }, switched);
  expect(fork.status).toBe(200);
  let asks = 0;
  const target = treesVia(switched, async () => { asks++; throw new Error('fork must retain inherited reads'); });
  isolateTrees.clear();
  expect((await read(fork.body.id, r.cookie, target)).body.content).toBe('before\n');
  expect(asks).toBe(0);
});

it('directory grants, quarantine and token revocation still govern cached trees', async () => {
  const r = await setup('shared-read-security');
  const minted = await api(`/repos/${r.id}/tokens`, { cookie: r.cookie }, { body: { name: 'reader', scopes: ['read'], paths: ['folder/a.txt'] } }, switched);
  expect(minted.status).toBe(200);
  let asks = 0;
  const target = treesVia(switched, async (stub, args) => { asks++; return stub.trees(...args); });
  const tokenRead = async (query: string) => {
    const res = await platformFetch(new Request(`https://yoneda/api/v1/repos/${r.id}${query}`, { headers: { authorization: `Bearer ${minted.body.token}` }, cf: { continent: 'NA' } }), target);
    return { status: res.status, body: await res.json<any>() };
  };
  isolateTrees.clear();
  expect((await read(r.id, '', target)).status).toBe(404);
  expect((await tokenRead('/blob?path=outside.txt')).status).toBe(403);
  expect(asks).toBe(0);
  expect((await tokenRead('/blob?path=folder/a.txt')).body.content).toBe('before\n');
  expect(asks).toBe(1);
  expect((await tokenRead('/tree?path=folder')).body.entries.map((e: any) => e.name)).toEqual(['a.txt']);
  const quarantined = await api(`/repos/${r.id}/quarantine`, { cookie: r.cookie }, { body: { path: 'folder/a.txt', reason: 'sensitive fixture' } }, switched);
  expect(quarantined.status).toBe(200);
  expect((await tokenRead('/blob?path=folder/a.txt')).status).toBe(451);
  isolateTrees.clear();
  expect((await tokenRead('/blob?path=folder/a.txt')).status).toBe(451);
  expect((await api(`/repos/${r.id}/tokens/reader`, { cookie: r.cookie }, { method: 'DELETE' }, switched)).status).toBe(200);
  const before = asks;
  expect((await tokenRead('/blob?path=folder/a.txt')).status).toBe(401);
  expect(asks).toBe(before);
});

it('a cancelled caller with a held tree RPC cannot hold a fresh request open', async () => {
  const r = await setup('shared-read-cancel');
  let asks = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const target = treesVia(switched, async (stub, args) => {
    if (++asks === 1) await gate;
    return stub.trees(...args);
  });
  isolateTrees.clear();
  const controller = new AbortController();
  const abandoned = read(r.id, r.cookie, target, undefined, undefined, controller.signal);
  try {
    await vi.waitFor(() => expect(asks).toBe(1));
    controller.abort();
    let fresh: Awaited<ReturnType<typeof read>> | undefined;
    const running = read(r.id, r.cookie, target).then((answer) => { fresh = answer; });
    await vi.waitFor(() => expect(fresh?.body.content).toBe('before\n'));
    await running;
    expect(asks).toBe(2);
  } finally {
    release();
    await abandoned;
  }
});

it('shared trees preserve missing path and non-directory errors', async () => {
  const r = await setup('shared-read-errors');
  isolateTrees.clear();
  const missing = await read(r.id, r.cookie, switched, '/blob?path=folder/missing.txt');
  expect([missing.status, missing.body.error.code]).toEqual([404, 'NOT_FOUND']);
  isolateTrees.clear();
  const directory = await read(r.id, r.cookie, switched, '/tree?path=folder/a.txt');
  expect([directory.status, directory.body.error.code]).toEqual([404, 'NOT_FOUND']);
});
