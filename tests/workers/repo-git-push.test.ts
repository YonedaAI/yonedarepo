// Where a stock Git push's objects go before any ref moves: a small push is staged in the
// authority with its commits (no object store write while Git waits; the drain writes R2
// afterwards), a larger one is written to R2 first, and a failed write moves nothing.
import { expect, it, vi } from 'vitest';
import { compute } from '../../cloudflare/worker/repo-compute';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { api, author, drainObjects, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

type Raw = { id: string; kind: 'commit' | 'tree' | 'blob'; data: Uint8Array };
const text = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function object(kind: Raw['kind'], data: Uint8Array): Promise<Raw> {
  const header = text.encode(`${kind} ${data.length}\0`);
  const whole = new Uint8Array(header.length + data.length);
  whole.set(header);
  whole.set(data, header.length);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', whole))), kind, data };
}

/** A commit on `parent` whose tree holds `count` small files (and nothing else). */
async function commitOf(parent: string, count: number, label: string) {
  const blobs = await Promise.all(Array.from({ length: count }, (_, i) => object('blob', text.encode(`${label} ${i}\n`))));
  const entries = blobs
    .map((b, i) => ({ name: `f${String(i).padStart(4, '0')}.txt`, id: b.id }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const parts = entries.flatMap((e) => [text.encode(`100644 ${e.name}\0`), Uint8Array.from(e.id.match(/../g) ?? [], (h) => Number.parseInt(h, 16))]);
  const tree = await object('tree', new Uint8Array(parts.flatMap((p) => [...p])));
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const commit = await object('commit', text.encode(`tree ${tree.id}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\n${label}\n`));
  return { commit, objects: [commit, tree, ...blobs] };
}

async function push(repo: string, token: string, refname: string, objects: Raw[]) {
  const { push_b64 } = compute({
    op: 'branch_push',
    refname,
    old: null,
    new: objects[0].id,
    objects: objects.map((o) => ({ id: o.id, kind: o.kind, data_b64: btoa(String.fromCharCode(...o.data)) })),
  });
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/git-receive-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token}`)}` },
      body: Uint8Array.from(atob(push_b64), (c) => c.charCodeAt(0)),
    }),
    scoped,
  );
  return new TextDecoder().decode(await response.arrayBuffer());
}

async function setup(name: string) {
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, { body: { name, policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } });
  const repo = created.body.id as string;
  const minted = await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } });
  const refs = async () => (await api(`/repos/${repo}/refs`, { cookie })).body.refs;
  return { repo, token: minted.body.token as string, refs, main: (await refs())['refs/heads/main'] as string };
}

const rawKey = (repo: string, id: string) => `platform/v1/${repo}/git/${id}`;

it('stages a small push with its commit, lands it, and writes R2 only in the drain', async () => {
  const { repo, token, refs, main } = await setup('push_staged');
  const { commit, objects } = await commitOf(main, 3, 'small');
  const puts = vi.spyOn(scoped.OBJECTS, 'put');
  queued.length = 0;
  const report = await push(repo, token, 'refs/heads/main', objects);
  expect(report).toContain('unpack ok');
  expect(report).toContain('ok refs/heads/main');
  expect((await refs())['refs/heads/main']).toBe(commit.id);
  // Nothing went to the store of record while Git waited; the drain was asked for.
  const written = () => puts.mock.calls.map(([key]) => key).filter((key) => key.includes('/git/'));
  expect(written()).toEqual([]);
  expect(queued.some((m) => m.kind === 'platform_objects' && m.repo_id === repo)).toBe(true);
  // Readable from the staged copies meanwhile, then from R2 once drained.
  const shown = await api(`/repos/${repo}/blob?path=f0000.txt`, { token });
  expect(shown.body.content).toBe('small 0\n');
  await drainObjects();
  expect(written().sort()).toEqual(objects.map((o) => rawKey(repo, o.id)).sort());
  expect(await scoped.OBJECTS.head(rawKey(repo, objects[2].id))).not.toBeNull();
});

it('writes a large push to R2 before recording it, and a failed write moves no ref', async () => {
  const { repo, token, refs, main } = await setup('push_large');
  // More objects than the authority stages for one commit.
  const { commit, objects } = await commitOf(main, 300, 'large');
  const before = await refs();
  const put = scoped.OBJECTS.put.bind(scoped.OBJECTS);
  const failing = vi.spyOn(scoped.OBJECTS, 'put').mockImplementation(async (key, ...rest) => {
    if (String(key).endsWith(objects[5].id)) throw new Error('injected R2 failure');
    return put(key, ...rest);
  });
  const refused = await push(repo, token, 'refs/heads/bulk', objects);
  expect(refused).toContain('ng refs/heads/bulk');
  expect(await refs()).toEqual(before);
  expect((await api(`/repos/${repo}/commits/${commit.id}`, { token })).status).toBe(404);

  failing.mockRestore();
  const pushed = await push(repo, token, 'refs/heads/bulk', objects);
  expect(pushed).toContain('ok refs/heads/bulk');
  expect((await refs())['refs/heads/bulk']).toBe(commit.id);
  expect(await scoped.OBJECTS.head(rawKey(repo, objects[299].id))).not.toBeNull();
});
