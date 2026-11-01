// REGION_HINT_TEST through the real create route, real repository and shard Durable Objects
// (workerd): a hint reaches every first `get` of a fresh test repository's objects, and off, or
// for anything else, nothing changes. workerd accepts a hint and has one location, so where an
// object lands is a live question (tools/platform-region-matrix.mjs), never answered here.
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { coloOf, hintedEnv, regionHint } from '../../cloudflare/worker/repo-region-hint';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, fakeCombiners, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const body = (name: string, extra = {}) => ({ name, policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author, ...extra });

/** `target` with each object namespace recording the location hint of every `get`. */
function recording(target: Env, extra: Partial<Env> = {}) {
  const gets: { binding: string; hint: unknown }[] = [];
  const proxied = (binding: string, namespace: any) => ({
    idFromName: (name: string) => namespace.idFromName(name),
    idFromString: (id: string) => namespace.idFromString(id),
    get(id: any, options?: { locationHint?: string }) {
      gets.push({ binding, hint: options?.locationHint ?? null });
      return namespace.get(id, options);
    },
  });
  return {
    gets,
    env: {
      ...target,
      SOURCE_REPOS: proxied('SOURCE_REPOS', target.SOURCE_REPOS),
      COMMIT_SHARDS: proxied('COMMIT_SHARDS', target.COMMIT_SHARDS),
      LAND_COMBINERS: combinersWithWhere((b) => gets.push(b)),
      ...extra,
    } as Env,
  };
}

/** The fixture's in-process combiners, recording too, with the one method a test adds. */
function combinersWithWhere(note: (entry: { binding: string; hint: unknown }) => void) {
  return {
    idFromName: fakeCombiners.idFromName,
    get(name: string, options?: { locationHint?: string }) {
      note({ binding: 'LAND_COMBINERS', hint: options?.locationHint ?? null });
      return { ...fakeCombiners.get(name), where: async () => 'TST' };
    },
  };
}

it('off, a create ignores a hint: no answer field, no hinted get, no route', async () => {
  const cookie = await signup('hintoff');
  const { env, gets } = recording(scoped);
  const created = await api('/repos', { cookie }, { body: body('region-hint-off', { region_hint: 'weur' }) }, env);
  expect(created.status).toBe(200);
  expect(created.body.region_hint).toBeUndefined();
  expect(gets.length).toBeGreaterThan(0);
  expect(gets.every((g) => g.hint === null)).toBe(true);
  const where = await api(`/repos/${created.body.id}/where`, { cookie }, {}, env);
  expect(where.status).toBe(404);
  expect(where.body.error.code).toBe('NOT_FOUND');
});

it('on, without a hint a create is today\'s: nothing hinted, shards after the answer', async () => {
  const cookie = await signup('hintnone');
  const { env, gets } = recording(scoped, { REGION_HINT_TEST: 'on' });
  const created = await api('/repos', { cookie }, { body: body('plain') }, env);
  expect(created.status).toBe(200);
  expect(created.body.region_hint).toBeUndefined();
  expect(gets.every((g) => g.hint === null)).toBe(true);
});

it('on, a hint reaches the first get of every object of the new repository', async () => {
  const cookie = await signup('hinton');
  const { env, gets } = recording(scoped, { REGION_HINT_TEST: 'on' });
  const created = await api('/repos', { cookie }, { body: body('region-hint-a', { region_hint: 'weur' }) }, env);
  expect(created.status).toBe(200);
  expect(created.body.region_hint).toBe('weur');
  const by = (binding: string) => gets.filter((g) => g.binding === binding);
  expect(by('SOURCE_REPOS')[0].hint).toBe('weur');
  expect(by('SOURCE_REPOS').every((g) => g.hint === 'weur')).toBe(true);
  // All 64 shards start before the answer, so no later request is the first get of one.
  expect(by('COMMIT_SHARDS').filter((g) => g.hint === 'weur').length).toBeGreaterThanOrEqual(64);
  expect(by('COMMIT_SHARDS').every((g) => g.hint === 'weur')).toBe(true);
  // Main's combiner, its head holder and its projector.
  expect(by('LAND_COMBINERS').filter((g) => g.hint === 'weur').length).toBeGreaterThanOrEqual(3);
  expect(by('LAND_COMBINERS').every((g) => g.hint === 'weur')).toBe(true);
});

it('on, the repository works as any other after a hinted create', async () => {
  const cookie = await signup('hintwork');
  const { env } = recording(scoped, { REGION_HINT_TEST: 'on' });
  const { body: repo } = await api('/repos', { cookie }, { body: body('region-hint-b', { region_hint: 'apac' }) }, env);
  const read = await api(`/repos/${repo.id}/blob?path=a.md`, { cookie }, {}, env);
  expect(read.body.content).toBe('a\n');
  const made = await api(`/repos/${repo.id}/commits`, { cookie }, { body: { ref: 'main', changes: [file('b.md', 'b\n')], message: 'b', author } }, env);
  expect(made.status).toBe(200);
  const landed = await api(`/repos/${repo.id}/land`, { cookie }, { body: { ref: 'main', commit: made.body.commit } }, env);
  expect(landed.status).toBe(200);
  expect(landed.body.landed).toBe(true);
});

it('on, a hint is refused for any other name or code, and nothing is created', async () => {
  const cookie = await signup('hintbad');
  const { env, gets } = recording(scoped, { REGION_HINT_TEST: 'on' });
  for (const asked of [body('ordinary', { region_hint: 'weur' }), body('region-hint-c', { region_hint: 'mars' }), { ...body('x'), name: undefined, region_hint: 'weur' }]) {
    const refused = await api('/repos', { cookie }, { body: asked }, env);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('INVALID_INPUT');
  }
  expect(gets).toEqual([]);
  expect((await api('/repos', { cookie }, {}, env)).body.repos).toEqual([]);
});

it('on, an import never takes a hint: only a create reads one', async () => {
  const cookie = await signup('hintimport');
  const { env, gets } = recording(scoped, { REGION_HINT_TEST: 'on' });
  await api('/repos/import', { cookie }, { body: { name: 'region-hint-i', url: 'https://example.com/r.git', region_hint: 'weur' } }, env);
  expect(gets.every((g) => g.hint === null)).toBe(true);
});

it("where answers the owner, says nothing it did not read, and refuses anyone else", async () => {
  const [owner, stranger] = [await signup('whereowner'), await signup('wherestranger')];
  const { env } = recording(scoped, { REGION_HINT_TEST: 'on' });
  const { body: repo } = await api('/repos', { cookie: owner }, { body: body('region-hint-w', { region_hint: 'enam' }) }, env);
  const seen = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('fl=1\ncolo=TST\nloc=US\n'));
  const where = await api(`/repos/${repo.id}/where`, { cookie: owner }, {}, env);
  expect(seen).toHaveBeenCalled();
  seen.mockRestore();
  expect(where.status).toBe(200);
  expect(where.body).toMatchObject({ worker: 'TST', combiner: 'TST', head: 'TST', projector: 'TST' });
  // The Rust objects read the page themselves: a code or null, depending on this machine.
  for (const colo of [where.body.authority, where.body.shard]) expect(colo === null || /^[A-Z]{3}$/.test(colo)).toBe(true);
  const refused = await api(`/repos/${repo.id}/where`, { cookie: stranger }, {}, env);
  expect(refused.status).toBeGreaterThanOrEqual(403);
  expect(refused.body.worker).toBeUndefined();
});

it('a hinted namespace only adds the hint, and leaves the rest of the environment', () => {
  const asked: unknown[] = [];
  const namespace = { get: (_: unknown, options: unknown) => asked.push(options), idFromName: (n: string) => n };
  const near = hintedEnv({ ...bindings, SOURCE_REPOS: namespace, COMMIT_SHARDS: undefined, LAND_COMBINERS: undefined } as unknown as Env, 'apac');
  near.SOURCE_REPOS.get(near.SOURCE_REPOS.idFromName('r') as any);
  expect(asked).toEqual([{ locationHint: 'apac' }]);
  expect(near.OBJECTS).toBe(bindings.OBJECTS);
  expect(near.SHARD_START).toBe('request');
  expect(near.COMMIT_SHARDS).toBeUndefined();
});

it('reads a colo from a trace page and nothing from anything else', () => {
  expect(coloOf('fl=1\nh=x\ncolo=FRA\nloc=DE\n')).toBe('FRA');
  expect(coloOf('colo=frankfurt\n')).toBeNull();
  expect(coloOf('')).toBeNull();
});

it('only a test name and a known code pass', () => {
  const on = { REGION_HINT_TEST: 'on' } as Env;
  expect(regionHint(on, { name: 'region-hint-x', region_hint: 'apac' })).toBe('apac');
  expect(regionHint(on, { name: 'region-hint-x' })).toBeNull();
  expect(regionHint({} as Env, { name: 'nothing', region_hint: 'mars' })).toBeNull();
});

it('a real combiner answers where it runs, and stores a key only when told to', async () => {
  const name = 'region-hint-combiner';
  const stub = () => bindings.LAND_COMBINERS!.get(bindings.LAND_COMBINERS!.idFromName(name)) as any;
  const stored = () => runInDurableObject(stub(), async (_: unknown, state: DurableObjectState) => (await state.storage.list()).size);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('colo=TST\n'));
  expect(await stub().where()).toBe('TST');
  expect(await stored()).toBe(0);
  expect(await stub().where(true)).toBe('TST');
  expect(await stored()).toBe(1);
  await stub().erase();
  expect(await stored()).toBe(0);
  vi.restoreAllMocks();
});
