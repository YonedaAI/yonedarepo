// Real workerd source/shard objects. Hints prove first-get intent, not physical placement.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { hintedEnv } from '../../cloudflare/worker/repo-region-hint';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { inScope } from '../../cloudflare/worker/request-scope';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, fakeCombiners, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
type Seen = { binding: string; name: string; hint: string | null };
function recording(env: Env, held?: Promise<void>) {
  const gets: Seen[] = [];
  const namespace = (binding: string, original: any) => {
    const names = new Map<string, string>();
    return {
      idFromName: (name: string) => { const id = original.idFromName(name); names.set(String(id), name); return id; },
      get: (id: any, options?: { locationHint?: string }) => {
        gets.push({ binding, name: names.get(String(id)) ?? String(id), hint: options?.locationHint ?? null });
        const stub = original.get(id, options);
        if (!held || binding !== 'shard') return stub;
        return new Proxy(stub, { get(target, key) {
          if (key === 'fetch') return async (url: string, init: RequestInit) => {
            if (JSON.parse(String(init.body)).op === 'store_status') await held;
            return target.fetch(url, init);
          };
          const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } });
      },
    };
  };
  const combiners = { ...fakeCombiners, get: (name: string) => ({ ...fakeCombiners.get(name), where: async () => { if (held) await held; return 'TST'; } }) };
  return { gets, env: { ...env, SOURCE_REPOS: namespace('source', env.SOURCE_REPOS), COMMIT_SHARDS: namespace('shard', env.COMMIT_SHARDS), LAND_COMBINERS: namespace('combiner', combiners) } as Env };
}
async function create(target: Env, cookie: string, name: string, continent?: string, extra: object = {}, headers: Record<string, string> = {}, waitUntil?: (p: Promise<unknown>) => void, path = '/repos') {
  const req = new Request(`https://yoneda/api/v1${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name, files: [file('a.txt', 'a\n')], author, policy: { approvals: 0, required_checks: [] }, ...extra }), ...(continent && { cf: { continent } }) });
  const response = await inScope({ env: target, req, waitUntil }, () => platformFetch(req, target));
  return { status: response.status, body: await response.json<any>() };
}
it.each([['AS', 'apac'], ['OC', 'oc']])('places a fresh %s repository from original origin, not API execution', async (continent, hint) => {
  const cookie = await signup(`origin_${continent.toLowerCase()}`);
  const r = recording({ ...scoped, AUTOMATIC_LOCALITY: 'on' });
  const made = await create(r.env, cookie, `origin-${continent.toLowerCase()}`, continent);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  for (const binding of ['source', 'shard', 'combiner']) {
    const first = new Map<string, Seen>();
    for (const get of r.gets.filter((g) => g.binding === binding)) if (!first.has(get.name)) first.set(get.name, get);
    expect(first.size).toBeGreaterThan(0);
    expect([...first.values()].every((g) => g.hint === hint)).toBe(true);
  }
});

it.each([['AS', 'apac'], ['OC', 'oc'], ['SA', 'sam'], ['AF', 'afr']])('keeps default %s creation near its origin with authority routing enabled', async (continent, hint) => {
  const cookie = await signup(`origin_global_${continent.toLowerCase()}`);
  const r = recording({ ...scoped, CELLS: 'on', AUTOMATIC_LOCALITY: 'on',
    CELL_WEUR: { fetch: async () => Response.json({ error: { code: 'WRONG_AUTHORITY', message: 'Default non-EU creation must not enter the EU authority' } }, { status: 409 }) } as Fetcher,
  });
  const made = await create(r.env, cookie, `origin-global-${continent.toLowerCase()}`, continent);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  expect(made.body.id.endsWith('eea001')).toBe(false);
  expect(made.body.region_hint).toBe(hint);
  expect(r.gets.length).toBeGreaterThan(0);
  expect(r.gets.every((g) => g.hint === hint)).toBe(true);
});

it('an explicit legacy authority selection preserves its identity while first placement follows the origin', async () => {
  const cookie = await signup('origin_explicit_authority');
  const r = recording({ ...scoped, CELLS: 'on', AUTOMATIC_LOCALITY: 'on' });
  const made = await create(r.env, cookie, 'origin-explicit-authority', 'AS', { region: 'enam' });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  expect(made.body.id.endsWith('eea001')).toBe(false);
  expect(made.body.region_hint).toBe('apac');
  expect(r.gets.every((g) => g.hint === 'apac')).toBe(true);
});

it.each([['NA', 'enam'], ['EU', 'weur']])('keeps existing %s origin behavior', async (continent, hint) => {
  const cookie = await signup(`origin_existing_${continent.toLowerCase()}`);
  const r = recording({ ...scoped, AUTOMATIC_LOCALITY: 'on' });
  expect((await create(r.env, cookie, 'existing-origin', continent)).status).toBe(200);
  expect(r.gets.every((g) => g.hint === hint)).toBe(true);
});

it('missing runtime geography, forged headers/body and switch-off add no origin hint', async () => {
  const cookie = await signup('origin_untrusted');
  for (const [name, continent, automatic] of [['unknown', undefined, 'on'], ['unknown-tor', 'T1', 'on'], ['disabled', 'AS', 'off']] as const) {
    const r = recording({ ...scoped, AUTOMATIC_LOCALITY: automatic });
    const made = await create(r.env, cookie, name, continent, { region_hint: 'apac', cf: { continent: 'AS' } }, { 'cf-ipcountry': 'JP', 'cf-continent': 'AS', 'x-yoneda-region': 'apac' });
    expect(made.status).toBe(200); expect(made.body.region_hint).toBeUndefined();
    expect(r.gets.every((g) => g.hint === null)).toBe(true);
  }
});

it.each(['AS', 'OC'])('keeps %s visitors within the already selected EU namespace', async (continent) => {
  const cookie = await signup(`origin_eu_${continent.toLowerCase()}`);
  const eu = { ...scoped, AUTOMATIC_LOCALITY: 'on', CELL: 'weur', CELL_HINT: 'weur', CELL_JURISDICTION: 'eu',
    // workerd does not implement jurisdiction(); these runtime assertions prove the selected-cell hint only.
    SOURCE_REPOS: bindings.SOURCE_REPOS, COMMIT_SHARDS: bindings.COMMIT_SHARDS };
  const r = recording(eu); const made = await create(r.env, cookie, 'eu-origin', continent);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  expect(made.body.id.endsWith('eea001')).toBe(true); expect(made.body.region_hint).toBe('weur');
  expect(r.gets.every((g) => g.hint === 'weur')).toBe(true);
  expect(r.env.CELL_JURISDICTION).toBe('eu');
  expect(r.env.SOURCE_REPOS.idFromName(made.body.id).toString()).toBe(eu.SOURCE_REPOS.idFromName(made.body.id).toString());
});

it('keeps the explicit development hint override independent of automatic origin', async () => {
  const cookie = await signup('origin_experiment');
  const r = recording({ ...scoped, AUTOMATIC_LOCALITY: 'on', REGION_HINT_TEST: 'on' });
  const made = await create(r.env, cookie, 'region-hint-origin', 'OC', { region_hint: 'apac' });
  expect(made.status).toBe(200); expect(made.body.region_hint).toBe('apac');
  expect(r.gets.every((g) => g.hint === 'apac')).toBe(true);
});

it.each([['AS', 'apac'], ['OC', 'oc'], ['SA', 'sam'], ['AF', 'afr']])('%s origin warmup captures first gets without blocking on shards or combiners', async (continent, hint) => {
  const cookie = await signup('origin_background');
  let release!: () => void; const held = new Promise<void>((done) => { release = done; });
  const r = recording({ ...scoped, AUTOMATIC_LOCALITY: 'on' }, held); const ctx = createExecutionContext();
  const work = create(r.env, cookie, 'origin-background', continent, { files: [] }, {}, (p) => ctx.waitUntil(p));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([work, new Promise<null>((done) => { timer = setTimeout(() => done(null), 1000); })]);
    expect(result?.status).toBe(200);
    expect(new Set(r.gets.filter((g) => g.binding === 'shard').map((g) => g.name)).size).toBe(64);
    expect(new Set(r.gets.filter((g) => g.binding === 'combiner').map((g) => g.name)).size).toBe(3);
    expect(r.gets.every((g) => g.hint === hint)).toBe(true);
    expect(r.env.SHARD_START).toBeUndefined();
  } finally { clearTimeout(timer); release(); await work; await waitOnExecutionContext(ctx); }
});

it('subsequent reads from a different origin keep the existing identity and use no new hint', async () => {
  const cookie = await signup('origin_existing_object'); const r = recording({ ...scoped, AUTOMATIC_LOCALITY: 'on' });
  const made = await create(r.env, cookie, 'origin-existing-object', 'AS'); expect(made.status).toBe(200);
  const identity = r.env.SOURCE_REPOS.idFromName(made.body.id).toString(); r.gets.length = 0;
  const req = new Request(`https://yoneda/api/v1/repos/${made.body.id}/blob?path=a.txt`, { headers: { cookie }, cf: { continent: 'OC' } });
  const response = await inScope({ env: r.env, req }, () => platformFetch(req, r.env));
  expect(response.status).toBe(200); expect((await response.json<any>()).content).toBe('a\n');
  r.env.SOURCE_REPOS.get(r.env.SOURCE_REPOS.idFromName(made.body.id));
  expect(r.gets.every((g) => g.hint === null)).toBe(true);
  expect(r.env.SOURCE_REPOS.idFromName(made.body.id).toString()).toBe(identity);
});

it.each([['AS', 'apac'], ['OC', 'oc'], ['SA', 'sam'], ['AF', 'afr']])('fresh imports allocate %s objects before Workflow execution, ignoring test body hints', async (continent, hint) => {
  const cookie = await signup(`origin_import_${continent.toLowerCase()}`); const workflows: any[] = [];
  const r = recording({ ...scoped, AUTOMATIC_LOCALITY: 'on', REGION_HINT_TEST: 'on',
    PLATFORM_IMPORT: { create: async (value: unknown) => { workflows.push(value); return {}; } } } as unknown as Env);
  const made = await create(r.env, cookie, 'origin-import', continent, { url: 'https://github.com/example/demo.git', region_hint: 'weur' }, {}, undefined, '/repos/import');
  expect(made.status, JSON.stringify(made.body)).toBe(200); expect(workflows).toHaveLength(1);
  for (const binding of ['source', 'shard', 'combiner']) {
    expect(r.gets.some((g) => g.binding === binding)).toBe(true);
    expect(r.gets.filter((g) => g.binding === binding).every((g) => g.hint === hint)).toBe(true);
  }
  expect(workflows[0].params.repo).toBe(made.body.id);
  expect(workflows[0].params).not.toHaveProperty('region_hint');
});

it('the hint adapter preserves an already-restricted namespace and its distinct IDs', () => {
  // Adapter boundary only: actual jurisdiction enforcement needs a live Cloudflare receipt.
  const gets: unknown[] = [];
  const restricted = { idFromName: (name: string) => `eu:${name}`,
    get: (id: unknown, options: unknown) => { gets.push({ id, options }); },
    jurisdiction: () => { throw new Error('must not replace the selected jurisdiction'); },
  } as unknown as DurableObjectNamespace;
  const eu = { ...scoped, SOURCE_REPOS: restricted, COMMIT_SHARDS: undefined, LAND_COMBINERS: undefined, CELL_JURISDICTION: 'eu' };
  const near = hintedEnv(eu, 'weur', false);
  const id = near.SOURCE_REPOS.idFromName('new-repo'); near.SOURCE_REPOS.get(id);
  expect(String(id)).toBe('eu:new-repo'); expect(eu.SOURCE_REPOS).toBe(restricted);
  expect(gets).toEqual([{ id: 'eu:new-repo', options: { locationHint: 'weur' } }]);
  expect(near.CELL_JURISDICTION).toBe('eu');
});

it.each([['AS', 'apac'], ['OC', 'oc'], ['SA', 'sam'], ['AF', 'afr']])('a %s import starts hinted objects before its deferred Workflow while warmup remains held', async (continent, hint) => {
  const cookie = await signup('origin_import_background');
  let release!: () => void; const held = new Promise<void>((done) => { release = done; });
  const atWorkflow: Seen[][] = [];
  const r = recording({ ...scoped, AUTOMATIC_LOCALITY: 'on', PLATFORM_IMPORT: { create: async () => { atWorkflow.push([...r.gets]); return {}; } } } as unknown as Env, held);
  const ctx = createExecutionContext();
  const work = create(r.env, cookie, 'origin-import-background', continent, { url: 'https://github.com/example/demo.git' }, {}, (p) => ctx.waitUntil(p), '/repos/import');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([work, new Promise<null>((done) => { timer = setTimeout(() => done(null), 1000); })]);
    expect(answer?.status).toBe(200); expect(atWorkflow).toHaveLength(1);
    expect(new Set(atWorkflow[0].filter((g) => g.binding === 'shard').map((g) => g.name)).size).toBe(64);
    expect(new Set(atWorkflow[0].filter((g) => g.binding === 'combiner').map((g) => g.name)).size).toBe(3);
    expect(atWorkflow[0].every((g) => g.hint === hint)).toBe(true);
  } finally { clearTimeout(timer); release(); await work; await waitOnExecutionContext(ctx); }
});

it.each(['NA', 'AS'])('a %s import respects the selected EU authority instead of its foreign origin', async (continent) => {
  const cookie = await signup(`origin_import_eu_${continent.toLowerCase()}`);
  const r = recording({ ...scoped, CELLS: 'on', AUTOMATIC_LOCALITY: 'on', CELL: 'weur', CELL_HINT: 'weur', CELL_JURISDICTION: 'eu',
    PLATFORM_IMPORT: { create: async () => ({}) } } as unknown as Env);
  const made = await create(r.env, cookie, 'eu-import-origin', continent,
    { region: 'weur', url: 'https://github.com/example/demo.git' }, {}, undefined, '/repos/import');
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  expect(made.body.id.endsWith('eea001')).toBe(true);
  expect(r.gets.every((g) => g.hint === 'weur')).toBe(true);
});

it.each([['enam', 'apac'], ['weur', 'weur']])('a foreign-origin fork retains the %s authority and uses its permitted hint', async (cell, hint) => {
  const cookie = await signup(`origin_fork_${cell}`);
  const r = recording({ ...scoped, CELLS: 'on', AUTOMATIC_LOCALITY: 'on', CELL: cell,
    ...(cell === 'weur' && { CELL_HINT: 'weur', CELL_JURISDICTION: 'eu' }),
  });
  const parent = await create(r.env, cookie, 'origin-fork-parent', cell === 'weur' ? 'EU' : 'NA', { region: cell });
  expect(parent.status, JSON.stringify(parent.body)).toBe(200);
  r.gets.length = 0;
  const request = new Request(`https://yoneda/api/v1/repos/${parent.body.id}/fork`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'origin-fork-child', policy: { approvals: 0, required_checks: [] } }), cf: { continent: 'AS' },
  });
  const answer = await inScope({ env: r.env, req: request }, () => platformFetch(request, r.env));
  const fork = await answer.json<any>();
  expect(answer.status, JSON.stringify(fork)).toBe(200);
  expect(fork.id.endsWith('eea001')).toBe(cell === 'weur');
  const own = r.gets.filter((get) => get.name === fork.id || get.name.startsWith(`${fork.id}:`) || get.name.startsWith(`${fork.id}#`));
  expect(own.some((get) => get.binding === 'source')).toBe(true);
  expect(own.every((get) => get.hint === hint)).toBe(true);
  let copies = 0;
  const ns = bindings.READ_COPIES!;
  const watched = { idFromName: (name: string) => ns.idFromName(name), get: (id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) => { copies++; return ns.get(id, options); } } as DurableObjectNamespace;
  const read = new Request(`https://yoneda/api/v1/repos/${fork.id}/blob?path=a.txt`, { headers: { cookie }, cf: { continent: 'AS' } });
  const response = await platformFetch(read, { ...r.env, READ_COPIES: watched });
  expect(response.status).toBe(200); expect((await response.json<any>()).content).toBe('a\n');
  expect(copies).toBe(0);
});
