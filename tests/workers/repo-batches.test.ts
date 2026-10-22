// Batched landing through the API: commits begin from main's published head, land from
// their commit shard's records in one authority call per batch (access re-checked then,
// no adoption), reads are served from the published head with read-your-writes, and
// main's Git view gets one commit per batch.
import { expect, it } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const batched = { ...scoped, LAND_MODE: 'batch' } as unknown as Env;

async function repoWith(name: string, files: ReturnType<typeof file>[], target: Env) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, { body: { name, policy: { required_checks: [], approvals: 0 }, files, author } }, target);
  return { owner, repo: `/repos/${created.body.id}` };
}
const commitOn = (repo: string, who: { cookie?: string; token?: string }, changes: unknown[], target: Env) =>
  api(`${repo}/commits`, who, { body: { ref: 'main', changes, message: 'change', author } }, target);
const landOn = (repo: string, who: { cookie?: string; token?: string }, commit: string, target: Env) =>
  api(`${repo}/land`, who, { body: { ref: 'main', commit } }, target);

it('lands a batch from shard records, reads its own writes, and adopts only when asked', async () => {
  const { owner, repo } = await repoWith('batched', [file('a.txt', '0\n')], batched);
  const made = await Promise.all(Array.from({ length: 8 }, (_, i) => commitOn(repo, owner, [file(`w/${i}.txt`, `${i}\n`)], batched)));
  expect(made.map((m) => m.status)).toEqual(Array(8).fill(200));
  const landed = await Promise.all(made.map((m) => landOn(repo, owner, m.body.commit, batched)));
  expect(landed.map((l) => [l.status, l.body.git_commit])).toEqual(Array(8).fill([200, null]));
  const log = (await api(`${repo}/txlog`, owner, {}, batched)).body.entries;
  expect(log.filter((e: any) => e.kind === 'changeset')).toHaveLength(8);
  // Read-your-writes: a reader passing its landing's version sees it, projected or not.
  for (const [i, l] of landed.entries())
    expect((await api(`${repo}/blob?path=w/${i}.txt&min_version=${l.body.version}`, owner, {}, batched)).body.content).toBe(`${i}\n`);
  // Landing never adopted; a read of the full commit adopts it then.
  const shown = await api(`${repo}/commits/${made[0].body.commit}`, owner, {}, batched);
  expect(shown.status).toBe(200);
  expect(shown.body.landings[0].version).toBe(landed[0].body.version);
  // Main's Git view: batches merge their landed commits, so every pushed commit is in
  // main's history by its own id (each lander's pull fast-forwards).
  const head = (await api(`${repo}/refs`, owner, {}, batched)).body;
  expect(head.version).toBe(9);
  const history = await ancestors(repo, owner, head.refs['refs/heads/main'], batched);
  for (const m of made) expect(history.has(m.body.commit)).toBe(true);
  expect((await api(`${repo}/blob?path=w/7.txt`, owner, {}, batched)).body.content).toBe('7\n');
});

/** Every commit reachable from `head` (small test histories). */
async function ancestors(repo: string, who: { cookie?: string }, head: string, target: Env) {
  const seen = new Set<string>([head]);
  const pending = [head];
  while (pending.length) {
    const shown = (await api(`${repo}/commits/${pending.pop()}`, who, {}, target)).body;
    for (const parent of shown.parents as string[])
      if (!seen.has(parent)) {
        seen.add(parent);
        pending.push(parent);
      }
  }
  return seen;
}

it('lands a lone push on main as the pushed commit, and concurrent ones as a merge of each', async () => {
  const target = { ...batched, LAND_COMBINERS: bindings.LAND_COMBINERS } as unknown as Env;
  const { owner, repo } = await repoWith('shapes', [file('a.txt', '0\n')], target);
  const seed = (await api(`${repo}/refs`, owner, {}, target)).body.refs['refs/heads/main'];
  const lone = await commitOn(repo, owner, [file('b.txt', 'b\n')], target);
  expect((await landOn(repo, owner, lone.body.commit, target)).status).toBe(200);
  // No wrapper commit: main is the pushed commit, a child of the old main.
  const main = (await api(`${repo}/refs`, owner, {}, target)).body.refs['refs/heads/main'];
  expect(main).toBe(lone.body.commit);
  expect((await api(`${repo}/commits/${main}`, owner, {}, target)).body.parents).toEqual([seed]);
  const made = await Promise.all(
    ['c', 'd'].map((p) => commitOn(repo, owner, [file(`${p}.txt`, `${p}\n`)], target)),
  );
  const landed = await Promise.all(made.map((m) => landOn(repo, owner, m.body.commit, target)));
  expect(landed.map((l) => l.status)).toEqual([200, 200]);
  const merged = (await api(`${repo}/refs`, owner, {}, target)).body.refs['refs/heads/main'];
  const tip = (await api(`${repo}/commits/${merged}`, owner, {}, target)).body;
  expect(tip.principal).toBe('platform:merge');
  const history = await ancestors(repo, owner, merged, target);
  for (const m of [lone, ...made]) expect(history.has(m.body.commit)).toBe(true);
});

it('creates main at the first pushed commit of an empty repository', async () => {
  const { owner, repo } = await repoWith('emptyfirst', [], batched);
  expect((await api(`${repo}/refs`, owner, {}, batched)).body.refs).toEqual({});
  const root = await commitOn(repo, owner, [file('a.txt', 'a\n')], batched);
  expect([root.status, root.body.parents]).toEqual([200, []]);
  const child = await api(`${repo}/commits`, owner, {
    body: { parent: root.body.commit, base_version: 0, changes: [file('b.txt', 'b\n')], message: 'b', author },
  }, batched);
  expect(child.status).toBe(200);
  const landed = await landOn(repo, owner, child.body.commit, batched);
  expect(landed.status).toBe(200);
  const refs = (await api(`${repo}/refs`, owner, {}, batched)).body.refs;
  expect(refs['refs/heads/main']).toBe(child.body.commit);
  expect((await api(`${repo}/blob?path=a.txt`, owner, {}, batched)).body.content).toBe('a\n');
});

it('refuses a landing whose token was revoked after its commit began', async () => {
  const { owner, repo } = await repoWith('revoked', [file('a.txt', '0\n')], batched);
  const token = (await api(`${repo}/tokens`, owner, { body: { name: 'lander', scopes: ['read', 'write', 'land'] } }, batched)).body.token;
  const made = await commitOn(repo, { token }, [file('b.txt', 'b\n')], batched);
  expect(made.status).toBe(200);
  expect((await api(`${repo}/tokens/lander`, owner, { method: 'DELETE' }, batched)).status).toBe(200);
  const landed = await landOn(repo, { token }, made.body.commit, batched);
  expect([landed.status, landed.body.error?.code]).toEqual([401, 'UNAUTHORIZED']);
  // Nothing landed: main still has only the seed.
  expect((await api(`${repo}/blob?path=b.txt`, owner, {}, batched)).status).toBe(404);
});

it('lands same-file work through the merge path', async () => {
  const base = Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n');
  const { owner, repo } = await repoWith('batchmerge', [file('f.txt', `${base}\n`)], batched);
  const edit = (line: number) => base.split('\n').map((l, i) => (i === line ? `edited ${i}` : l)).join('\n');
  const made = await Promise.all([0, 8].map((line) => commitOn(repo, owner, [file('f.txt', `${edit(line)}\n`)], batched)));
  const landed = await Promise.all(made.map((m) => landOn(repo, owner, m.body.commit, batched)));
  expect(landed.map((l) => l.status)).toEqual([200, 200]);
  const merged = (await api(`${repo}/blob?path=f.txt&min_version=3`, owner, {}, batched)).body.content;
  expect(merged).toContain('edited 0');
  expect(merged).toContain('edited 8');
});

it('runs inside the LandCombiner Durable Object, with its head holder and projector', async () => {
  const target = { ...batched, LAND_COMBINERS: bindings.LAND_COMBINERS } as unknown as Env;
  const { owner, repo } = await repoWith('durablebatch', [file('a.txt', '0\n')], target);
  const made = await Promise.all(Array.from({ length: 6 }, (_, i) => commitOn(repo, owner, [file(`d/${i}.txt`, `${i}\n`)], target)));
  const landed = await Promise.all(made.map((m) => landOn(repo, owner, m.body.commit, target)));
  expect(landed.map((l) => [l.status, l.body.error?.message])).toEqual(Array(6).fill([200, undefined]));
  for (const [i, l] of landed.entries())
    expect((await api(`${repo}/blob?path=d/${i}.txt&min_version=${l.body.version}`, owner, {}, target)).body.content).toBe(`${i}\n`);
});

it('reads main at a landing version as the contract says: at once, or STALE_READ before main reaches it', async () => {
  const target = { ...batched, LAND_COMBINERS: bindings.LAND_COMBINERS } as unknown as Env;
  const { owner, repo } = await repoWith('minversion', [file('a.txt', '0\n')], target);
  const token = (await api(`${repo}/tokens`, owner, { body: { name: 'rw', scopes: ['read', 'write', 'land'] } }, target)).body.token;
  const made = await commitOn(repo, { token }, [file('m.txt', 'm\n')], target);
  const landed = await landOn(repo, { token }, made.body.commit, target);
  expect(landed.status).toBe(200);
  const at = (v: number) => api(`${repo}/blob?path=m.txt&min_version=${v}`, owner, {}, target);
  expect((await at(landed.body.version)).body).toMatchObject({ content: 'm\n', version: landed.body.version });
  const ahead = await at(landed.body.version + 5);
  expect([ahead.status, ahead.body.error?.code]).toEqual([400, 'STALE_READ']);
});

it('falls back to the queued path when the combiner cannot be reached', async () => {
  const broken = {
    idFromName: (n: string) => n,
    get: () => ({
      wait: async () => { throw new Error('combiner evicted'); },
      submit: async () => { throw new Error('combiner evicted'); },
    }),
  };
  const target = { ...batched, LAND_COMBINERS: broken } as unknown as Env;
  const { owner, repo } = await repoWith('nocombiner', [file('a.txt', '0\n')], target);
  const made = await Promise.all(Array.from({ length: 4 }, (_, i) => commitOn(repo, owner, [file(`n/${i}.txt`, `${i}\n`)], target)));
  const landed = await Promise.all(made.map((m) => landOn(repo, owner, m.body.commit, target)));
  expect(landed.map((l) => l.status)).toEqual(Array(4).fill(200));
});

it('returns the three sides of a content conflict, as changeset mode does', async () => {
  const base = 'fn a() {\n    1\n}\n';
  const { owner, repo } = await repoWith('batchclash', [file('src/lib.rs', base)], batched);
  const [ours, theirs] = await Promise.all([
    commitOn(repo, owner, [file('src/lib.rs', base.replace('    1\n', '    10\n'))], batched),
    commitOn(repo, owner, [file('src/lib.rs', base.replace('    1\n', '    100\n'))], batched),
  ]);
  expect((await landOn(repo, owner, ours.body.commit, batched)).status).toBe(200);
  const conflict = await landOn(repo, owner, theirs.body.commit, batched);
  expect([conflict.status, conflict.body.error?.code]).toEqual([409, 'CONFLICT']);
  const sides = conflict.body.error.details.conflicts[0];
  expect(sides).toMatchObject({ path: 'src/lib.rs', kind: 'content' });
  for (const side of [sides.base, sides.ours, sides.theirs]) expect(side).toMatch(/^[0-9a-f]{40}$/);
  expect(sides.marked).toContain('<<<<<<< ours\n    10\n||||||| base\n    1\n=======\n    100\n>>>>>>> theirs\n');
});

it('refuses a landing without a commit id as invalid input', async () => {
  const { owner, repo } = await repoWith('nocommit', [file('a.txt', '0\n')], batched);
  for (const commit of [undefined, 'main', 'e'.repeat(39)]) {
    const landed = await api(`${repo}/land`, owner, { body: { ref: 'main', commit } }, batched);
    expect([landed.status, landed.body.error?.code]).toEqual([400, 'INVALID_INPUT']);
  }
});

it('lands the tip of a chain on an unmoved main as one fast-forward', async () => {
  const { owner, repo } = await repoWith('batchchain', [file('a.txt', '0\n')], batched);
  let parent: string | undefined;
  let version = 1;
  for (const path of ['c1.txt', 'c2.txt', 'c3.txt']) {
    const made = await api(`${repo}/commits`, owner, {
      body: { ...(parent ? { parent, base_version: version } : { ref: 'main' }), changes: [file(path, `${path}\n`)], message: path, author },
    }, batched);
    expect(made.status).toBe(200);
    parent = made.body.commit;
    version = made.body.base_version;
  }
  const landed = await landOn(repo, owner, parent as string, batched);
  expect([landed.status, landed.body.version]).toEqual([200, 2]);
  expect((await api(`${repo}/refs`, owner, {}, batched)).body.refs['refs/heads/main']).toBe(parent);
  for (const path of ['c1.txt', 'c3.txt'])
    expect((await api(`${repo}/blob?path=${path}&min_version=2`, owner, {}, batched)).body.content).toBe(`${path}\n`);
});
