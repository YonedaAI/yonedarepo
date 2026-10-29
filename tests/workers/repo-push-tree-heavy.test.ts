// A tree-heavy push, like a monorepo's history: 400 commits each rewrite one of 1,500
// directories, so every commit carries a new root tree of 1,500 entries (about 20 MiB of
// trees in all, more than the receive path keeps in memory). It is accepted, and this
// isolate's Wasm memory (which never shrinks) stays bounded. In local workerd the
// authority's Durable Objects share this Wasm memory.
import { expect, it } from 'vitest';
import { wasmMemoryBytes } from '../../cloudflare/worker/repo-git-sessions';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';
import { git, join, type Obj, object, pack, pkt, text, tree } from './synthetic-pack';

usePlatformFixture();

const on = { ...scoped, PUSH_BUNDLES: 'on' } as unknown as Env;
const MiB = 1024 * 1024;
const DIRS = 1500;
const COMMITS = 400;

it('accepts a push whose trees outgrow what receive keeps in memory', { timeout: 600_000 }, async () => {
  const cookie = await signup('tree_heavy');
  const created = await api('/repos', { cookie }, { body: { name: 'tree-heavy', policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, on);
  const repo = created.body.id as string;
  const { token } = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, on)).body;
  const old = (await api(`/repos/${repo}/refs`, { cookie }, {}, on)).body.refs['refs/heads/main'] as string;
  const objects: Obj[] = [];
  const dir = async (d: number, version: number) => {
    const blob = await object('blob', text.encode(`dir ${d} v${version}\n`));
    const t = await tree([['100644', 'f.txt', blob.id]]);
    objects.push(blob, t);
    return t.id;
  };
  const dirs: string[] = [];
  for (let d = 0; d < DIRS; d++) dirs.push(await dir(d, 0));
  let parent = old;
  let treeBytes = 0;
  for (let c = 0; c <= COMMITS; c++) {
    if (c > 0) dirs[(c * 7) % DIRS] = await dir((c * 7) % DIRS, c);
    const root = await tree(dirs.map((id, d) => ['40000', `d${String(d).padStart(4, '0')}`, id] as [string, string, string]));
    treeBytes += root.data.length;
    const who = `${author.name} <${author.email}> ${1700000000 + c} +0000`;
    const commit = await object('commit', text.encode(`tree ${root.id}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\nc${c}\n`));
    objects.push(root, commit);
    parent = commit.id;
  }
  expect(treeBytes).toBeGreaterThan(16 * MiB);
  const body = join([text.encode(`${pkt(`${old} ${parent} refs/heads/main\0report-status\n`)}0000`), await pack(objects)]);
  const start = wasmMemoryBytes();
  const report = new TextDecoder().decode(await git(repo, token, 'git-receive-pack', body, on));
  const after = wasmMemoryBytes();
  console.log(`tree-heavy push: ${(treeBytes / MiB).toFixed(0)} MiB of trees, pack ${(body.length / MiB).toFixed(0)} MiB, Wasm ${(start / MiB).toFixed(0)} -> ${(after / MiB).toFixed(0)} MiB`);
  expect(report).toContain('ok refs/heads/main');
  expect((await api(`/repos/${repo}/refs`, { cookie }, {}, on)).body.refs['refs/heads/main']).toBe(parent);
  expect(after).toBeLessThan(96 * MiB);
});
