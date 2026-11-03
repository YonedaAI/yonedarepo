import { expect, it, vi } from 'vitest';
import { edgeDelete } from '../../cloudflare/worker/repo-cache-tiers';
import { caller } from '../../cloudflare/worker/repo-ops';
import { toBase64 } from '../../cloudflare/worker/repo-stores';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, countingOps, drainObjects, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const on = { ...scoped, OVERVIEW_BOOTSTRAP: 'on' } as Env;
const mode = 'summary=true&overview=true';
async function setup(name: string) {
  const owner = { cookie: await signup(name) };
  const made = await api('/repos', owner, { body: { name: 'project', files: [file('README.md', '# Before\n')], author, policy: { approvals: 0, required_checks: [] } } }, on);
  expect(made.status).toBe(200);
  await drainObjects(on);
  return { owner, id: made.body.id, commit: made.body.commit, version: made.body.version };
}

it('a real landing between admission and log cannot overwrite the earlier historic key', async () => {
  const r = await setup('overview_cache_race');
  const made = await api(`/repos/${r.id}/commits`, r.owner, { body: { ref: 'main', changes: [file('README.md', '# After\n')], message: 'after', author } }, on);
  expect(made.status).toBe(200);
  let moved = false;
  const ns = on.SOURCE_REPOS;
  const intercepted = { ...on, SOURCE_REPOS: { idFromName: (name: string) => ns.idFromName(name), get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
    const c = JSON.parse(String(init.body));
    if (!moved && c.op === 'repo_log') {
      moved = true;
      expect((await api(`/repos/${r.id}/land`, r.owner, { body: { ref: 'main', commit: made.body.commit } }, on)).status).toBe(200);
    }
    return ns.get(id).fetch(url, init);
  } }) } } as unknown as Env;
  const seen = countingOps(intercepted);
  const path = `/repos/${r.id}?${mode}`;
  const raced = await api(path, r.owner, {}, seen.env);
  expect(raced.body.version).toBe(r.version);
  expect(raced.body.overview.tree.commit).toBe(r.commit);
  expect(seen.take().repo_log).toBe(1);
  const historic = await api(`${path}&at=${r.version}`, r.owner, {}, seen.env);
  expect(historic.body.overview.tree.commit).toBe(r.commit);
  expect(seen.take().repo_log).toBe(1);
  await api(`${path}&at=${r.version}`, r.owner, {}, seen.env);
  expect(seen.take().repo_log ?? 0).toBe(0);
  const pinned = await api(`${path}&commit=${r.commit}`, r.owner, {}, seen.env);
  expect(pinned.body.overview.readme.content).toBe('# Before\n');
  expect(seen.take().repo_log).toBe(1);
  await api(`${path}&commit=${r.commit}`, r.owner, {}, seen.env);
  expect(seen.take().repo_log ?? 0).toBe(0);
});

it('a populated cache is bypassed after quarantine and the fresh blob guard still refuses bytes', async () => {
  const r = await setup('overview_cache_epoch');
  const seen = countingOps(on);
  const path = `/repos/${r.id}?${mode}`;
  await api(path, r.owner, {}, seen.env);
  await api(path, r.owner, {}, seen.env);
  expect(seen.take().repo_log).toBe(1);
  expect((await api(`/repos/${r.id}/quarantine`, r.owner, { body: { path: 'README.md', reason: 'fixture' } }, on)).status).toBe(200);
  const shown = await api(path, r.owner, {}, seen.env);
  expect(shown.body.overview.readme).toBeNull();
  expect(shown.body.overview.errors.readme.code).toBe('QUARANTINED');
  expect(seen.take().repo_log).toBe(1);
});

it('a real authority reset and reimport at the same commit/version cannot return old provenance', async () => {
  const r = await setup('overview_cache_reset');
  const seen = countingOps(on);
  const path = `/repos/${r.id}?${mode}`;
  const before = await api(path, r.owner, {}, seen.env);
  await api(path, r.owner, {}, seen.env);
  expect(seen.take().repo_log).toBe(1);
  const raw = await on.OBJECTS.get(`platform/v1/${r.id}/git/${r.commit}`);
  expect(raw).not.toBeNull();
  const bytes = new Uint8Array(await raw!.arrayBuffer());
  const call = caller(on, r.id, { _system: 'import' });
  for (;;) {
    if ((await call({ op: 'repo_import_reset' })).done) break;
  }
  expect((await call({ op: 'repo_status' })).history_chain).toBeNull();
  await call({ op: 'repo_record_pushed', commits: [{ commit: r.commit, data_b64: toBase64(bytes), touches: [], objects: [{ id: r.commit, kind: 'commit' }] }] });
  await call({ op: 'repo_import', ref: 'main', commit: r.commit });
  const after = await api(path, r.owner, {}, seen.env);
  expect(after.body.version).toBe(before.body.version);
  expect(after.body.object_store).toBe(before.body.object_store);
  expect(after.body.history_chain).not.toBe(before.body.history_chain);
  expect(after.body.overview.tree.commit).toBe(r.commit);
  expect(after.body.overview.activity.commits[0].principal).not.toBe(before.body.overview.activity.commits[0].principal);
  expect(seen.take().repo_log).toBe(1);
  await api(path, r.owner, {}, seen.env);
  expect(seen.take().repo_log ?? 0).toBe(0);
});

it('fork activity remains authoritative while README keeps its inherited-object guards', async () => {
  const r = await setup('overview_cache_fork');
  const fork = await api(`/repos/${r.id}/fork`, r.owner, { body: { name: 'fork' } }, on);
  expect(fork.status).toBe(200);
  const seen = countingOps(on);
  const path = `/repos/${fork.body.id}?${mode}`;
  for (let n = 0; n < 2; n++) {
    const shown = await api(path, r.owner, {}, seen.env);
    expect(shown.body.overview.readme.content).toBe('# Before\n');
  }
  expect(seen.take().repo_log).toBe(2);
  expect((await api(`/repos/${r.id}/quarantine`, r.owner, { body: { path: 'README.md', reason: 'parent fixture' } }, on)).status).toBe(200);
  const shown = await api(path, r.owner, {}, on);
  expect(shown.body.overview.readme).toBeNull();
  expect(shown.body.overview.errors.readme.code).toBe('QUARANTINED');
});

it('reads the selected root README without resolving its commit through object tiers again', async () => {
  const r = await setup('overview_cache_root');
  await edgeDelete(r.id, r.commit);
  const bucket = on.OBJECTS;
  const asked: string[] = [];
  const env = { ...on, OBJECTS: new Proxy(bucket, { get: (t, key) => key === 'get' ? async (...args: unknown[]) => {
    asked.push(String(args[0]));
    return Reflect.apply(t.get, t, args);
  } : typeof Reflect.get(t, key) === 'function' ? Reflect.get(t, key).bind(t) : Reflect.get(t, key) }) } as unknown as Env;
  const shown = await api(`/repos/${r.id}?${mode}`, r.owner, {}, env);
  expect(shown.body.overview.readme).toMatchObject({ commit: r.commit, content: '# Before\n' });
  expect(asked).not.toContain(`platform/v1/${r.id}/objects/${r.commit}`);
  expect(asked).not.toContain(`platform/v1/${r.id}/git/${r.commit}`);
});

it('a cancelled request holding activity cannot stall the next admitted bootstrap', async () => {
  const r = await setup('overview_cache_cancel');
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ns = on.SOURCE_REPOS;
  const env = { ...on, SOURCE_REPOS: { idFromName: (name: string) => ns.idFromName(name), get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
    const c = JSON.parse(String(init.body));
    const answer = await ns.get(id).fetch(url, init);
    if (c.op === 'repo_log' && ++started === 1) await gate;
    return answer;
  } }) } } as unknown as Env;
  const controller = new AbortController();
  const first = platformFetch(new Request(`https://yoneda/api/v1/repos/${r.id}?${mode}`, { headers: { cookie: r.owner.cookie }, signal: controller.signal }), env);
  try {
    await vi.waitFor(() => expect(started).toBe(1));
    controller.abort();
    let shown: any;
    const second = api(`/repos/${r.id}?${mode}`, r.owner, {}, env).then((v) => { shown = v; });
    await vi.waitFor(() => expect(shown?.body.overview?.activity?.commits[0].commit).toBe(r.commit));
    await second;
    expect(started).toBe(2);
  } finally { release(); await first; }
});
