// What a jobs-queue consumer holds at once (prod's ended `exceededMemory` at batch size 2
// after a 12,000-file push): the derive job over a large bundled push reads its files a
// bounded wave at a time, in bulk from the bundles, never one tiered walk per file all at
// once. Counts are of R2 operations and Durable Object commands in flight in local
// workerd, the proxy for what an isolate holds (workerd reports no heap size).
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { isolateLocations } from '../../cloudflare/worker/repo-bundles';
import { compute } from '../../cloudflare/worker/repo-compute';
import { deriveAfterLanding } from '../../cloudflare/worker/repo-derived';
import { isolateTrees } from '../../cloudflare/worker/repo-tree-memo';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, PUSH_BUNDLES: 'on' } as unknown as Env;
type Raw = { id: string; kind: 'commit' | 'tree' | 'blob'; data: Uint8Array };
const text = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const bytesOf = (h: string) => (h.match(/../g) ?? []).map((x) => Number.parseInt(x, 16));

async function object(kind: Raw['kind'], data: Uint8Array): Promise<Raw> {
  const whole = new Uint8Array([...text.encode(`${kind} ${data.length}\0`), ...data]);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', whole))), kind, data };
}

/** A tree of `entries` (already in Git order). */
const treeOf = (entries: { mode: string; name: string; id: string }[]) =>
  object('tree', new Uint8Array(entries.flatMap((e) => [...text.encode(`${e.mode} ${e.name}\0`), ...bytesOf(e.id)])));

/** `env` whose R2 operations and authority and shard commands are counted, with the most
 * in flight at once. */
function inFlight(env: Env) {
  let now = 0;
  const seen = { peak: 0, total: 0 };
  const track = async <T>(work: () => Promise<T>) => {
    seen.total++;
    seen.peak = Math.max(seen.peak, ++now);
    try {
      return await work();
    } finally {
      now--;
    }
  };
  const r2 = env.OBJECTS;
  const objects = {
    get: (...a: Parameters<R2Bucket['get']>) => track(() => r2.get(...a)),
    put: (...a: Parameters<R2Bucket['put']>) => track(() => r2.put(...a)),
    head: (...a: Parameters<R2Bucket['head']>) => track(() => r2.head(...a)),
    delete: (...a: Parameters<R2Bucket['delete']>) => track(() => r2.delete(...a)),
    list: (...a: Parameters<R2Bucket['list']>) => track(() => r2.list(...a)),
  };
  const counted = (namespace: DurableObjectNamespace) => ({
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return { fetch: (url: string, init: RequestInit) => track(() => stub.fetch(url, init)) };
    },
  });
  const counting = {
    ...env,
    OBJECTS: objects,
    SOURCE_REPOS: counted(env.SOURCE_REPOS),
    COMMIT_SHARDS: counted(env.COMMIT_SHARDS as DurableObjectNamespace),
  } as unknown as Env;
  return { env: counting, seen };
}

/** One stock Git push to main of `count` files under `big/`, written as bundles. */
async function bigPush(name: string, count: number) {
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, { body: { name, policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, on);
  const repo = created.body.id as string;
  const minted = await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, on);
  const main = (await api(`/repos/${repo}/refs`, { cookie }, {}, on)).body.refs['refs/heads/main'] as string;
  const blobs = await Promise.all(Array.from({ length: count }, (_, i) => object('blob', text.encode(`file ${i}\n`))));
  const big = await treeOf(blobs.map((b, i) => ({ mode: '100644', name: `f${String(i).padStart(5, '0')}.txt`, id: b.id })));
  const readme = await object('blob', text.encode('a\n'));
  const root = await treeOf([
    { mode: '100644', name: 'a.md', id: readme.id },
    { mode: '40000', name: 'big', id: big.id },
  ]);
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const commit = await object('commit', text.encode(`tree ${root.id}\nparent ${main}\nauthor ${who}\ncommitter ${who}\n\n${count} files\n`));
  const objects = [commit, root, big, ...blobs];
  const { push_b64 } = compute({
    op: 'branch_push',
    refname: 'refs/heads/main',
    old: main,
    new: commit.id,
    objects: objects.map((o) => ({ id: o.id, kind: o.kind, data_b64: btoa(String.fromCharCode(...o.data)) })),
  });
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/git-receive-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${minted.body.token}`)}` },
      body: Uint8Array.from(atob(push_b64), (c) => c.charCodeAt(0)),
    }),
    on,
  );
  expect(new TextDecoder().decode(await response.arrayBuffer())).toContain('ok refs/heads/main');
  return { repo, cookie, blobs };
}

it('derives a 2,000-file bundled push a bounded wave at a time', async () => {
  const { repo, cookie, blobs } = await bigPush('derive_big', 2_000);
  // A fresh consumer isolate: nothing located or remembered, no cached copy of any file.
  isolateLocations.clear();
  isolateTrees.clear();
  const { env, seen } = inFlight(on);
  await deriveAfterLanding(env, { v: 1, kind: 'platform_derive', repo_id: repo, job_id: 'main' } as any);
  // Before: every file at once (2,000 in flight) and 10,009 operations, ~5 per file.
  expect(seen.peak).toBeLessThanOrEqual(8);
  expect(seen.total).toBeLessThan(blobs.length / 20);

  // The index and the seed it built serve as before.
  const found = await api(`/repos/${repo}/search?query=file 1234`, { cookie }, {}, on);
  expect(found.body.results.map((r: { path: string }) => r.path)).toContain('big/f01234.txt');
  expect(found.body.partitions_built).toBe(0);
  const seed = await bindings.OBJECTS.head(`platform/v1/${repo}/seeds/main.json`);
  expect(seed?.customMetadata?.commit).toBeDefined();
});

it('derives a large API commit (no bundles) through the read tiers, 32 at a time', async () => {
  const owner = { cookie: await signup('derive_tiers') };
  const files = Array.from({ length: 300 }, (_, i) => file(`writers/${i}.txt`, `writer ${i}\n`));
  const created = await api('/repos', owner, { body: { name: 'derive_tiers', policy: { approvals: 0, required_checks: [] }, files, author } });
  const repo = created.body.id as string;
  isolateTrees.clear();
  const { env, seen } = inFlight(scoped);
  await deriveAfterLanding(env, { v: 1, kind: 'platform_derive', repo_id: repo, job_id: 'main' } as any);
  expect(seen.peak).toBeLessThanOrEqual(40);
  const found = await api(`/repos/${repo}/search?query=writer 299`, owner);
  expect(found.body.results.map((r: { path: string }) => r.path)).toEqual(['writers/299.txt']);
});
