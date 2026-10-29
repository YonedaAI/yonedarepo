// C3: reads answered from published or immutable data never queue on the repository's
// authority. Main's published head serves access and main's latest tree; a commit's header
// comes from the object tiers; main at a version the head covers comes from the head, other
// pinned versions from an immutable snapshot cache; refs from a snapshot at most two
// `REFS_MS` old (or at least at the reader's `min_version`). Grants hold on every path.
import { expect, it, vi } from 'vitest';
import { HeadHolder } from '../../cloudflare/worker/repo-head-holder';
import { REFS_MS, RefsHolder } from '../../cloudflare/worker/repo-snapshots';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

/** `target` whose authority calls are recorded by op, with an in-process head holder (the
 * land combiner's head role) on the same counted bindings. */
function counted(target: Env) {
  const ops: string[] = [];
  const repos = target.SOURCE_REPOS;
  const SOURCE_REPOS = {
    idFromName: (name: string) => repos.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = repos.get(id);
      return new Proxy(stub, {
        get: (s, key) =>
          key === 'fetch'
            ? (url: string, init: RequestInit) => {
                const body = JSON.parse(String(init.body));
                ops.push(...(Array.isArray(body) ? body : [body]).map((c) => c.op));
                return s.fetch(url, init);
              }
            : Reflect.get(s, key),
      });
    },
  };
  const env = { ...target, SOURCE_REPOS } as unknown as Env;
  const held = new Map<string, { head: HeadHolder; refs: RefsHolder }>();
  const role = (name: string) => held.get(name) ?? held.set(name, { head: new HeadHolder(env), refs: new RefsHolder(env) }).get(name)!;
  const LAND_COMBINERS = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      head: (repo: string, min: number, since?: number) => role(name).head.head(repo, min, since),
      access: (repo: string) => role(name).head.access(repo),
      refs: (repo: string, min: number) => role(name).refs.refs(repo, min),
      refresh: async (repo: string, access?: boolean) => {
        role(name).refs.forget();
        await role(name).head.refresh(repo, access);
      },
    }),
  };
  return { env: { ...env, LAND_COMBINERS } as unknown as Env, ops };
}

const seeded = [
  ...Array.from({ length: 10 }, (_, i) => file(`seed/${i}.txt`, `seed ${i}\n`)),
  file('pub/a.txt', 'public\n'),
  file('secret/k.txt', 'hidden\n'),
];

async function seededRepo(name: string, target: Env) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, { body: { name, policy: { required_checks: [], approvals: 0 }, files: seeded, author } }, target);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const repo = `/repos/${created.body.id}`;
  const refs = (await api(`${repo}/refs`, owner, {}, target)).body;
  return { owner, repo, id: created.body.id as string, commit: refs.refs['refs/heads/main'] as string, version: refs.version as number };
}

/** The bench's read sources (tools/fanout-bench/reads.mjs), for reader `i`. */
const sources = (commit: string, version: number) => ({
  'published-blob': (i: number) => [`/blob?path=seed/${i % 10}.txt`, `seed ${i % 10}\n`],
  'pinned-blob': (i: number) => [`/blob?path=seed/${i % 10}.txt&min_version=${version}`, `seed ${i % 10}\n`],
  'commit-blob': (i: number) => [`/blob?path=seed/${i % 10}.txt&commit=${commit}`, `seed ${i % 10}\n`],
  'version-blob': (i: number) => [`/blob?path=seed/${i % 10}.txt&ref=main&at=${version}`, `seed ${i % 10}\n`],
  tree: () => ['/tree?path=seed', null],
  refs: () => ['/refs', null],
});

it('serves every hot read source without an authority call', async () => {
  const { env, ops } = counted(scoped);
  const { owner, repo, commit, version } = await seededRepo('hotreads', env);
  const reads = Object.entries(sources(commit, version));
  // One read of each warms the holder and the object tiers.
  for (const [, source] of reads) expect((await api(`${repo}${source(0)[0]}`, owner, {}, env)).status).toBe(200);
  ops.length = 0;
  for (const [name, source] of reads) {
    const replies = await Promise.all(Array.from({ length: 25 }, (_, i) => api(`${repo}${source(i)[0]}`, owner, {}, env)));
    for (const [i, reply] of replies.entries()) {
      expect(reply.status, name).toBe(200);
      const content = source(i)[1];
      if (content !== null) expect(reply.body.content, name).toBe(content);
    }
    if (name === 'tree') expect(replies[0].body.entries).toHaveLength(10);
    // `annotated` maps annotated tags to their tag objects (none here).
    if (name === 'refs') expect(replies[0].body).toEqual({ version, refs: { 'refs/heads/main': commit }, annotated: {} });
    if (name === 'commit-blob' || name === 'version-blob') expect(replies[0].body.commit).toBe(commit);
  }
  expect(ops).toEqual([]);
});

it('reloads an aged refs snapshot once for a burst, and bounds what a reader can miss', async () => {
  const { env, ops } = counted(scoped);
  const { owner, repo, id, commit } = await seededRepo('refsnap', env);
  const writer = (await api(`${repo}/tokens`, owner, { body: { name: 'elsewhere', scopes: ['read', 'write'] } }, env)).body.token as string;
  expect((await api(`${repo}/refs`, owner, {}, env)).status).toBe(200);
  // Another isolate moves a branch (straight to the authority, unseen by this isolate).
  const elsewhere = async (ref: string) => {
    const stub = bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(id));
    const response = await stub.fetch('https://source-repository/', { method: 'POST', body: JSON.stringify({ op: 'repo_branch_set', ref, commit, expected: null, _token: writer }) });
    const moved = await response.json<any>();
    expect(moved.version).toBeGreaterThan(0);
    return moved.version as number;
  };
  const refs = async (query = '') => (await api(`${repo}/refs${query}`, owner, {}, env)).body;
  const topic = await elsewhere('refs/heads/topic');
  // A snapshot younger than the bound may not show it; a reader passing the move's version does.
  expect((await refs()).refs['refs/heads/topic']).toBeUndefined();
  expect((await refs(`?min_version=${topic}`)).refs['refs/heads/topic']).toBe(commit);
  expect((await refs()).refs['refs/heads/topic']).toBe(commit);

  const other = await elsewhere('refs/heads/other');
  expect((await refs()).refs['refs/heads/other']).toBeUndefined();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now + 2 * REFS_MS + 1);
  ops.length = 0;
  const burst = await Promise.all(Array.from({ length: 25 }, () => refs()));
  // Past the bound every reader sees the move, from one authority read for the burst.
  expect(burst.every((r) => r.refs['refs/heads/other'] === commit && r.version === other)).toBe(true);
  expect(ops).toEqual(['repo_refs']);
  vi.restoreAllMocks();

  // This isolate's own branch move is visible to its next read at once.
  const mine = await api(`${repo}/branches`, owner, { body: { ref: 'mine', commit, expected: null } }, env);
  expect(mine.status).toBe(200);
  expect((await refs()).refs['refs/heads/mine']).toBe(commit);
  // A version that does not exist yet is refused, not served stale.
  expect((await api(`${repo}/refs?min_version=${mine.body.version + 50}`, owner, {}, env)).body.error.code).toBe('STALE_READ');
});

it('serves pinned versions from the snapshot cache after one authority read', async () => {
  const { env, ops } = counted(scoped);
  const { owner, repo, commit, version } = await seededRepo('pinned', env);
  const made = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('seed/0.txt', 'changed\n')], message: 'change', author } }, env);
  const landed = await api(`${repo}/land`, owner, { body: { ref: 'main', commit: made.body.commit } }, env);
  expect(landed.status).toBe(200);
  // Main at its old version is past the head's projected version: one authority read, then cached.
  const old = `${repo}/blob?path=seed/0.txt&ref=main&at=${version}`;
  ops.length = 0;
  const first = await api(old, owner, {}, env);
  expect([first.body.content, first.body.commit]).toEqual(['seed 0\n', commit]);
  expect(ops).toEqual(['repo_snapshot']);
  ops.length = 0;
  const again = await Promise.all(Array.from({ length: 10 }, () => api(old, owner, {}, env)));
  expect(again.every((r) => r.body.content === 'seed 0\n')).toBe(true);
  expect((await api(`${repo}/tree?path=seed&ref=main&at=${version}`, owner, {}, env)).body.commit).toBe(commit);
  expect((await api(`${repo}/refs?at=${version}`, owner, {}, env)).body.refs['refs/heads/main']).toBe(commit);
  expect(ops).toEqual(['repo_refs']);
  // Main's latest content reads the landing.
  expect((await api(`${repo}/blob?path=seed/0.txt&min_version=${landed.body.version}`, owner, {}, env)).body.content).toBe('changed\n');
  expect((await api(`${repo}/tree?path=seed&min_version=${landed.body.version}`, owner, {}, env)).body.commit).not.toBe(commit);
});

it('enforces grants and repository scope on every snapshot read path', async () => {
  const { env } = counted(scoped);
  const { owner, repo, commit, version } = await seededRepo('snapgrants', env);
  const minted = await api(`${repo}/tokens`, owner, { body: { name: 'contractor', scopes: ['read'], paths: ['pub/'] } }, env);
  const contractor = { token: minted.body.token as string };
  const forbidden = async (path: string) => {
    const result = await api(`${repo}${path}`, contractor, {}, env);
    expect(result.status, path).toBe(403);
    expect(result.body.error.message, path).toBe('Path is outside your grant');
  };
  for (const at of [`commit=${commit}`, `ref=main&at=${version}`, `ref=main`]) {
    // The owner warms every tier with the hidden content first.
    expect((await api(`${repo}/blob?path=secret/k.txt&${at}`, owner, {}, env)).body.content).toBe('hidden\n');
    await forbidden(`/blob?path=secret/k.txt&${at}`);
    await forbidden(`/blob?path=secret/missing.txt&${at}`);
    await forbidden(`/tree?path=secret&${at}`);
    expect((await api(`${repo}/tree?path=&${at}`, contractor, {}, env)).body.entries.map((e: any) => e.name)).toEqual(['pub']);
    expect((await api(`${repo}/blob?path=pub/a.txt&${at}`, contractor, {}, env)).body.content).toBe('public\n');
  }
  // A commit of another repository is not readable here by its id.
  const other = await seededRepo('othersnap', env);
  const made = await api(`${other.repo}/commits`, other.owner, { body: { ref: 'main', changes: [file('pub/a.txt', 'elsewhere\n')], message: 'other', author } }, env);
  expect((await api(`${other.repo}/blob?path=pub/a.txt&commit=${made.body.commit}`, other.owner, {}, env)).body.content).toBe('elsewhere\n');
  expect((await api(`${repo}/blob?path=pub/a.txt&commit=${made.body.commit}`, owner, {}, env)).status).toBe(404);
  expect((await api(`${repo}/tree?path=pub&commit=${made.body.commit}`, owner, {}, env)).status).toBe(404);
  // A revoked token is refused on every path at once.
  expect((await api(`${repo}/tokens/contractor`, owner, { method: 'DELETE' }, env)).status).toBe(200);
  for (const path of [`/blob?path=pub/a.txt&commit=${commit}`, `/blob?path=pub/a.txt&ref=main&at=${version}`, '/tree?path=pub', '/refs'])
    expect((await api(`${repo}${path}`, contractor, {}, env)).status, path).toBe(401);
});

it("serves refs through the land combiner's head role", async () => {
  const target = { ...scoped, LAND_COMBINERS: bindings.LAND_COMBINERS } as unknown as Env;
  const { owner, repo, id, commit, version } = await seededRepo('refsrole', target);
  const role = bindings.LAND_COMBINERS.get(bindings.LAND_COMBINERS.idFromName(`${id}#head`)) as unknown as RefsHolder;
  expect(await role.refs(id, 0)).toEqual({ version, refs: { 'refs/heads/main': commit }, annotated: {} });
  const moved = await api(`${repo}/branches`, owner, { body: { ref: 'topic', commit, expected: null } }, target);
  expect((await role.refs(id, moved.body.version)).refs['refs/heads/topic']).toBe(commit);
  expect((await api(`${repo}/refs`, owner, {}, target)).body.refs['refs/heads/topic']).toBe(commit);
});
