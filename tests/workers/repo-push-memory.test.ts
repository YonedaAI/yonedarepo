// What large pushes cost this isolate's Wasm memory, which never shrinks: five pushes of
// 40,000 objects each (200 commits, each rewriting one of 200 directories of 197 files, so
// every push does the same work) stay well under the 128 MB isolate limit and do not
// ratchet. In local workerd the authority's Durable Objects share this Wasm memory, so the
// counts cover the receiving Worker and the recording authority together.
import { expect, it } from 'vitest';
import { wasmMemoryBytes } from '../../cloudflare/worker/repo-git-sessions';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';
import { git, join, type Obj, object, pack, pkt, text, tree } from './synthetic-pack';

usePlatformFixture();

const on = { ...scoped, PUSH_BUNDLES: 'on' } as unknown as Env;
const MiB = 1024 * 1024;
const DIRS = 200;
const FILES = 197;

it('keeps 40,000-object pushes well under the isolate limit, push after push', { timeout: 900_000 }, async () => {
  const cookie = await signup('push_memory');
  const created = await api('/repos', { cookie }, { body: { name: 'push-memory', policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, on);
  const repo = created.body.id as string;
  const { token } = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, on)).body;
  let parent = (await api(`/repos/${repo}/refs`, { cookie }, {}, on)).body.refs['refs/heads/main'] as string;
  const dirs = new Map<string, string>();
  const after: number[] = [];
  const start = wasmMemoryBytes();
  for (let p = 0; p < 5; p++) {
    const objects: Obj[] = [];
    const old = parent;
    for (let d = 0; d < DIRS; d++) {
      const i = p * DIRS + d;
      const blobs = await Promise.all(Array.from({ length: FILES }, (_, k) => object('blob', text.encode(`push ${p} dir ${d} file ${k}\n`))));
      const dir = await tree(blobs.map((b, k) => ['100644', `f${String(k).padStart(3, '0')}`, b.id]));
      dirs.set(`d${String(d).padStart(3, '0')}`, dir.id);
      const root = await tree([...dirs].map(([name, id]) => ['40000', name, id] as [string, string, string]));
      const who = `${author.name} <${author.email}> ${1700000000 + i} +0000`;
      const commit = await object('commit', text.encode(`tree ${root.id}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\nc${i}\n`));
      objects.push(commit, root, dir, ...blobs);
      parent = commit.id;
    }
    const head = text.encode(`${pkt(`${old} ${parent} refs/heads/main\0report-status\n`)}0000`);
    const report = new TextDecoder().decode(await git(repo, token, 'git-receive-pack', join([head, await pack(objects)]), on));
    expect(report, `push ${p + 1}`).toContain('ok refs/heads/main');
    after.push(wasmMemoryBytes());
  }
  const mib = (n: number) => (n / MiB).toFixed(0);
  console.log(`push memory: start ${mib(start)} MiB, after each push ${after.map(mib).join(', ')} MiB`);
  expect(after[0]).toBeLessThan(64 * MiB);
  // Repeating the same work grows it by at most a few MiB (allocator slack), not per push.
  expect(after[4] - after[1]).toBeLessThan(8 * MiB);
});
