// Bundles: with PUSH_BUNDLES=on a large stock Git push writes its objects as one R2 bundle
// per batch (its commits and trees apart from its files), indexed by the authority, instead of one R2 object per Git object. Every
// reader serves them (file reads, a v2 partial clone's lazy fetch, a thin follow-up push,
// the Artifacts projection), compaction and vacuum leave them readable, a repository
// delete purges them, and a push that dies between the bundle and its index leaves only
// an unreferenced bundle.
import { expect, it, vi } from 'vitest';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { isolateLocations, platformCall } from '../../cloudflare/worker/repo-bundles';
import { compute } from '../../cloudflare/worker/repo-compute';
import { projectObjects, projectRefs } from '../../cloudflare/worker/repo-projection';
import { isolateTrees } from '../../cloudflare/worker/repo-tree-memo';
import type { Env } from '../../cloudflare/worker/types';
import { api, artifacts, author, bindings, countingOps, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, PUSH_BUNDLES: 'on' } as unknown as Env;
type Raw = { id: string; kind: 'commit' | 'tree' | 'blob'; data: Uint8Array };
const text = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function object(kind: Raw['kind'], data: Uint8Array): Promise<Raw> {
  const whole = new Uint8Array([...text.encode(`${kind} ${data.length}\0`), ...data]);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', whole))), kind, data };
}

/** A commit on `parent` whose tree lists `blobs` as f0000.txt…, and that tree. */
async function commitOver(parent: string, blobs: Raw[], label: string) {
  const parts = blobs.flatMap((b, i) => [
    ...text.encode(`100644 f${String(i).padStart(4, '0')}.txt\0`),
    ...(b.id.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)),
  ]);
  const tree = await object('tree', new Uint8Array(parts));
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const commit = await object('commit', text.encode(`tree ${tree.id}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\n${label}\n`));
  return { commit, tree };
}

const blobsOf = (count: number, label: string) =>
  Promise.all(Array.from({ length: count }, (_, i) => object('blob', text.encode(`${label} ${i}\n`))));

async function push(target: Env, repo: string, token: string, refname: string, old: string | null, objects: Raw[]) {
  const { push_b64 } = compute({
    op: 'branch_push',
    refname,
    old,
    new: objects[0].id,
    objects: objects.map((o) => ({ id: o.id, kind: o.kind, data_b64: btoa(String.fromCharCode(...o.data)) })),
  });
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/git-receive-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token}`)}` },
      body: Uint8Array.from(atob(push_b64), (c) => c.charCodeAt(0)),
    }),
    target,
  );
  return new TextDecoder().decode(await response.arrayBuffer());
}

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
const command = (args: string[]) =>
  `${pkt('command=fetch\n')}${pkt('agent=git/2.47.0\n')}${pkt('object-format=sha1\n')}0001${args.map((a) => pkt(`${a}\n`)).join('')}0000`;

/** A v2 fetch; answers the pack's object count, or the ERR line. */
async function fetchV2(target: Env, repo: string, token: string, args: string[]) {
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token}`)}`, 'git-protocol': 'version=2' },
      body: command(args),
    }),
    target,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  const at = new TextDecoder('latin1').decode(bytes).indexOf('PACK');
  if (at < 0) return new TextDecoder().decode(bytes);
  return new DataView(bytes.buffer, bytes.byteOffset + at + 8, 4).getUint32(0);
}

async function setup(name: string, target: Env = on) {
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, { body: { name, policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, target);
  const repo = created.body.id as string;
  const minted = await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, target);
  const refs = async () => (await api(`/repos/${repo}/refs`, { cookie }, {}, target)).body.refs;
  return { repo, cookie, token: minted.body.token as string, refs, main: (await refs())['refs/heads/main'] as string };
}

/** 300 files on main in one bundled push (more than the authority stages). */
async function bundledPush(name: string, target: Env = on) {
  const repo = await setup(name, target);
  const blobs = await blobsOf(300, name);
  const { commit, tree } = await commitOver(repo.main, blobs, name);
  expect(await push(target, repo.repo, repo.token, 'refs/heads/main', repo.main, [commit, tree, ...blobs])).toContain('ok refs/heads/main');
  return { ...repo, blobs, commit, tree };
}

const bundleKeys = async (repo: string) =>
  (await bindings.OBJECTS.list({ prefix: `platform/v1/${repo}/bundles/` })).objects.map((o) => o.key);
const keysOf = (calls: unknown[][], part: string) => calls.map(([key]) => String(key)).filter((k) => k.includes(part));

it('writes a large push as bundles (commits and trees, then files) and serves them to every reader', async () => {
  const puts = vi.spyOn(scoped.OBJECTS, 'put');
  const { repo, cookie, token, refs, blobs, commit, tree } = await bundledPush('bundled');
  expect((await refs())['refs/heads/main']).toBe(commit.id);
  expect(keysOf(puts.mock.calls, '/git/')).toEqual([]);
  expect(keysOf(puts.mock.calls, '/bundles/')).toHaveLength(2);
  expect(await bundleKeys(repo)).toHaveLength(2);
  puts.mockRestore();

  // File reads, and a partial clone: commits and trees, then every file by id in one
  // fetch (each reachable from main), read from the bundle in one ranged read.
  expect((await api(`/repos/${repo}/blob?path=f0123.txt`, { cookie }, {}, on)).body.content).toBe('bundled 123\n');
  expect(await fetchV2(on, repo, token, [`want ${commit.id}`, 'filter blob:none', 'done'])).toBe(4);
  const gets = vi.spyOn(scoped.OBJECTS, 'get');
  const wants = blobs.map((b) => `want ${b.id}`);
  expect(await fetchV2(on, repo, token, [...wants, 'filter blob:none', 'done'])).toBe(300);
  expect(keysOf(gets.mock.calls, '/git/')).toEqual([]);
  expect(keysOf(gets.mock.calls, '/bundles/')).toHaveLength(1);
  gets.mockRestore();
  // An object no ref reaches is still refused.
  const stray = await object('blob', text.encode('never pushed\n'));
  expect(await fetchV2(on, repo, token, [`want ${stray.id}`, 'filter blob:none', 'done'])).toMatch(/ERR/);

  // A thin follow-up push sends only what changed; the files it keeps are found in the
  // bundle's index without reading them, and the tree it builds on from the bundle.
  const added = await object('blob', text.encode('added\n'));
  const next = await commitOver(commit.id, [...blobs, added], 'thin');
  const heads = vi.spyOn(scoped.OBJECTS, 'head');
  expect(await push(on, repo, token, 'refs/heads/main', commit.id, [next.commit, next.tree, added])).toContain('ok refs/heads/main');
  expect(keysOf(heads.mock.calls, '/git/')).toEqual([]);
  heads.mockRestore();
  expect((await api(`/repos/${repo}/blob?path=f0300.txt`, { cookie }, {}, on)).body.content).toBe('added\n');

  // The Artifacts projection reads both commits' objects from the bundles: in a fresh
  // consumer isolate, located in bulk because the repository's status says it holds bundles.
  isolateLocations.clear();
  const { env: consumer, take } = countingOps(on);
  for (const message of queued.splice(0)) {
    if (message.kind === 'platform_objects') await projectObjects(consumer, message.repo_id);
    if (message.kind === 'platform_project') await projectRefs(consumer, message);
  }
  // (Without the status, each 64 objects that missed R2 would cost a staged read: 5 here.)
  const ops = take();
  expect(ops.repo_bundle_locate).toBe(1);
  expect(ops.repo_staged_objects ?? 0).toBeLessThanOrEqual(1);
  const held = artifacts.get(`yr-${repo}`);
  for (const id of [commit.id, tree.id, blobs[299].id, next.commit.id, added.id]) expect(held?.has(id), id).toBe(true);
});

it('reads a bundled file in a fresh isolate through the staged read, with no locate call', async () => {
  const { repo, cookie, blobs, tree } = await bundledPush('bundle_fresh');
  // Another isolate: nothing located, no cached copy of the tree or the file.
  isolateLocations.clear();
  isolateTrees.clear();
  for (const id of [tree.id, blobs[42].id]) {
    await bindings.OBJECTS.delete(`platform/v1/${repo}/objects/${id}`);
    await caches.default.delete(new Request(`https://objects.yoneda.internal/${repo}/${id}`));
  }
  const { env, take } = countingOps(on);
  expect((await api(`/repos/${repo}/blob?path=f0042.txt`, { cookie }, {}, env)).body.content).toBe('bundle_fresh 42\n');
  // Whatever missed every tier was found in the one staged read the miss already made.
  const ops = take();
  expect(ops.repo_bundle_locate ?? 0).toBe(0);
  expect(ops.repo_staged_objects).toBeGreaterThanOrEqual(1);
  expect(ops.repo_staged_objects).toBeLessThanOrEqual(2);
});

it('leaves only an unreferenced bundle when a push dies before or while indexing it', async () => {
  const { repo, token, refs, main } = await setup('bundle_crash');
  const blobs = await blobsOf(300, 'crash');
  const { commit, tree } = await commitOver(main, blobs, 'crash');
  const objects = [commit, tree, ...blobs];
  const before = await refs();
  const indexed = async () =>
    (await platformCall(bindings, repo, { op: 'repo_bundle_locate', ids: objects.map((o) => o.id) })).located;

  // The bundle write fails: nothing is indexed or recorded.
  const put = scoped.OBJECTS.put.bind(scoped.OBJECTS);
  const failing = vi.spyOn(scoped.OBJECTS, 'put').mockImplementation(async (key, ...rest) => {
    if (String(key).includes('/bundles/')) throw new Error('injected R2 failure');
    return put(key, ...rest);
  });
  expect(await push(on, repo, token, 'refs/heads/bulk', null, objects)).toContain('ng refs/heads/bulk');
  failing.mockRestore();
  expect(await bundleKeys(repo)).toEqual([]);
  expect(await indexed()).toEqual([]);

  // The process dies after the first bundle is durable, before the authority indexes it.
  const repos = bindings.SOURCE_REPOS;
  const dying = {
    ...on,
    SOURCE_REPOS: {
      idFromName: (name: string) => repos.idFromName(name),
      get: (id: DurableObjectId) => {
        const stub = repos.get(id);
        return {
          fetch: async (url: string, init: RequestInit) => {
            if (String(init.body).includes('"op":"repo_bundle_index"')) throw new Error('injected crash');
            return stub.fetch(url, init);
          },
        };
      },
    },
  } as unknown as Env;
  expect(await push(dying, repo, token, 'refs/heads/bulk', null, objects)).toContain('ng refs/heads/bulk');
  expect(await bundleKeys(repo)).toHaveLength(1);
  expect(await indexed()).toEqual([]);
  expect(await refs()).toEqual(before);
  expect((await api(`/repos/${repo}/commits/${commit.id}`, { token }, {}, on)).status).toBe(404);

  // Pushing again writes the same bundles (content-addressed) and records the commit.
  expect(await push(on, repo, token, 'refs/heads/bulk', null, objects)).toContain('ok refs/heads/bulk');
  expect(await bundleKeys(repo)).toHaveLength(2);
  expect(await indexed()).toHaveLength(302);
  expect((await refs())['refs/heads/bulk']).toBe(commit.id);
});

it('purges a deleted repository bundles with the rest of its objects', async () => {
  const local = { ...on, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
  const { repo, cookie } = await bundledPush('bundle_delete', local);
  expect(await bundleKeys(repo)).toHaveLength(2);
  expect((await api(`/repos/${repo}?confirm=bundle_delete`, { cookie }, { method: 'DELETE' }, local)).body).toEqual({ deleted: true });
  const purge = queued.find((m) => m.kind === 'platform_purge' && m.repo_id === repo);
  await platformJob(local, { body: purge, attempts: 1, ack: () => {}, retry: () => {} } as unknown as Message<any>);
  expect(await bundleKeys(repo)).toEqual([]);
  expect((await bindings.OBJECTS.list({ prefix: `platform/v1/${repo}/` })).objects).toEqual([]);
});

it('keeps bundled objects readable after log compaction and vacuum', async () => {
  const { repo, cookie, token, blobs, commit } = await bundledPush('bundle_maintenance');
  expect(await bundleKeys(repo)).toHaveLength(2);
  const owner = { cookie };
  // Grow the log past one segment (1,024 versions), then compact all but 64 of them.
  let version = (await api(`/repos/${repo}`, owner, {}, on)).body.version as number;
  const at: (string | null)[] = Array(100).fill(null);
  while (version < 1_100) {
    const updates = at.map((was, i) => {
      at[i] = was ? null : commit.id;
      return { ref: `b${i}`, commit: at[i], expected: was };
    });
    const moved = await api(`/repos/${repo}/refs/batch`, { token }, { body: { updates } }, on);
    expect(moved.status).toBe(200);
    version = moved.body.version;
  }
  await api(`/repos/${repo}/retention`, owner, { method: 'PUT', body: { keep_versions: 64 } }, on);
  expect((await api(`/repos/${repo}/compact`, owner, { body: {} }, on)).body).toMatchObject({ segments: 1 });
  expect((await api(`/repos/${repo}/vacuum`, owner, { body: {} }, on)).status).toBe(200);

  expect((await api(`/repos/${repo}/blob?path=f0042.txt`, owner, {}, on)).body.content).toBe('bundle_maintenance 42\n');
  const wants = blobs.map((b) => `want ${b.id}`);
  expect(await fetchV2(on, repo, token, [...wants, 'filter blob:none', 'done'])).toBe(300);
  expect(await fetchV2(on, repo, token, [`want ${commit.id}`, 'done'])).toBe(305);
});
