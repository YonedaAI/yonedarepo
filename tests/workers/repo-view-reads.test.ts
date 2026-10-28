// What a repository overview (the human view) costs to read. A revision's view analyses
// every supported file's facts: built cold, its trees come a directory level per bundle
// read and its files in one pass, then the facts are one object keyed by the root tree, so
// the next view of that revision is one read. The derive job builds them for each new
// head. Counts are of R2 reads in local workerd.
import { expect, it, vi } from 'vitest';
import { isolateLocations } from '../../cloudflare/worker/repo-bundles';
import { compute } from '../../cloudflare/worker/repo-compute';
import { deriveAfterLanding } from '../../cloudflare/worker/repo-derived';
import { fromBase64, toBase64 } from '../../cloudflare/worker/repo-objects';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { isolateTrees } from '../../cloudflare/worker/repo-tree-memo';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, PUSH_BUNDLES: 'on' } as unknown as Env;
type Raw = { id: string; kind: 'commit' | 'tree' | 'blob'; data: Uint8Array };
const text = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const binary = (id: string) => (id.match(/../g) ?? []).map((h) => Number.parseInt(h, 16));

async function object(kind: Raw['kind'], data: Uint8Array): Promise<Raw> {
  const whole = new Uint8Array([...text.encode(`${kind} ${data.length}\0`), ...data]);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', whole))), kind, data };
}

const tree = (entries: [mode: string, name: string, id: string][]) =>
  object('tree', new Uint8Array(entries.flatMap(([mode, name, id]) => [...text.encode(`${mode} ${name}\0`), ...binary(id)])));

/** One commit on `parent` holding src/{a,b,c}/deep/m0..m3.ts, each calling the next. */
async function sources(parent: string) {
  const objects: Raw[] = [];
  const dirs: [string, string, string][] = [];
  for (const d of ['a', 'b', 'c']) {
    const files: [string, string, string][] = [];
    for (let i = 0; i < 4; i++) {
      const blob = await object('blob', text.encode(`export function ${d}${i}(): number {\n  return ${d}${(i + 1) % 4}();\n}\n`));
      objects.push(blob);
      files.push(['100644', `m${i}.ts`, blob.id]);
    }
    const deep = await tree(files);
    const dir = await tree([['40000', 'deep', deep.id]]);
    objects.push(deep, dir);
    dirs.push(['40000', d, dir.id]);
  }
  const src = await tree(dirs);
  const root = await tree([['40000', 'src', src.id]]);
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const commit = await object('commit', text.encode(`tree ${root.id}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\nsources\n`));
  return [commit, root, src, ...objects];
}

/** This repository's R2 reads while `run` runs, in a fresh isolate, by kind. */
async function reads(repo: string, run: () => Promise<unknown>) {
  isolateLocations.clear();
  isolateTrees.clear();
  const gets = vi.spyOn(scoped.OBJECTS, 'get');
  try {
    await run();
    const keys = gets.mock.calls.map(([key]) => String(key));
    return {
      bundles: keys.filter((k) => k.startsWith(`platform/v1/${repo}/bundles/`)).length,
      perFile: keys.filter((k) => k.startsWith(`derived/v1/${repo}/facts/`)).length,
      views: keys.filter((k) => k.startsWith(`derived/v1/${repo}/view-facts/`)).length,
    };
  } finally {
    gets.mockRestore();
  }
}

it('builds a revision overview in bulk once, then serves it from one facts object', async () => {
  const cookie = await signup('view_reads');
  const created = await api('/repos', { cookie }, { body: { name: 'view-reads', policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, on);
  const repo = created.body.id as string;
  const { token } = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, on)).body;
  const main = (await api(`/repos/${repo}/refs`, { cookie }, {}, on)).body.refs['refs/heads/main'] as string;
  const objects = await sources(main);
  const { push_b64 } = compute({
    op: 'branch_push',
    refname: 'refs/heads/main',
    old: main,
    new: objects[0].id,
    objects: objects.map((o) => ({ id: o.id, kind: o.kind, data_b64: toBase64(o.data) })),
  });
  const pushed = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/git-receive-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token}`)}` },
      body: fromBase64(push_b64),
    }),
    on,
  );
  expect(new TextDecoder().decode(await pushed.arrayBuffer())).toContain('ok refs/heads/main');

  // Cold: four directory levels a bundle read each, the twelve files in one more.
  let cold: any;
  const built = await reads(repo, async () => (cold = await api(`/repos/${repo}/views/human`, { cookie }, {}, on)));
  expect(cold.status, JSON.stringify(cold.body)).toBe(200);
  expect(cold.body.files_analyzed).toBe(12);
  expect(cold.body.subsystems.map((s: any) => s.path)).toEqual(['src']);
  expect(built.bundles).toBeLessThanOrEqual(6);
  expect(built.perFile).toBe(0);

  // Warm, in a fresh isolate: one read of the revision's facts, no trees or files.
  let warm: any;
  const served = await reads(repo, async () => (warm = await api(`/repos/${repo}/views/human`, { cookie }, {}, on)));
  expect(warm.body).toEqual(cold.body);
  expect(served).toEqual({ bundles: 0, perFile: 0, views: 1 });
  expect(warm.headers.get('server-timing')).toContain('view.facts');

  // The derive job builds a new head's facts before anyone asks.
  const listed = await bindings.OBJECTS.list({ prefix: `derived/v1/${repo}/view-facts/` });
  await Promise.all(listed.objects.map((o) => bindings.OBJECTS.delete(o.key)));
  await deriveAfterLanding(on, { v: 1, kind: 'platform_derive', repo_id: repo, job_id: 'main' });
  const prebuilt = await reads(repo, () => api(`/repos/${repo}/views/human`, { cookie }, {}, on));
  expect(prebuilt).toEqual({ bundles: 0, perFile: 0, views: 1 });
});
