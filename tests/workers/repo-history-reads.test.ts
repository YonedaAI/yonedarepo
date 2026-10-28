// What a clone of a pushed history costs in bundle reads. A fetch's walk reads trees a
// directory level per round across every commit, and a partial clone reads every commit:
// when a push's bundles interleave those with its files, each round is a ranged read per
// commit; laid out commits first, then trees, then files, a round is a read or two.
// Blame and search read a pushed history's files from its bundles in bulk too. Counts are
// of R2 reads and Durable Object commands in local workerd.
import { expect, it, vi } from 'vitest';
import { isolateLocations } from '../../cloudflare/worker/repo-bundles';
import { compute } from '../../cloudflare/worker/repo-compute';
import { fromBase64, toBase64 } from '../../cloudflare/worker/repo-objects';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { isolateTrees } from '../../cloudflare/worker/repo-tree-memo';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, countingOps, file, scoped, signup, usePlatformFixture } from './repo-fixture';

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

/** `commits` commits on `parent`, each adding one file of about 140 KB (more than the gap
 * bundle reads bridge; together more than a push stages) under d/e/f/ and listing it in
 * log.txt: four new trees and two files per commit, newest first. */
async function history(parent: string, commits: number) {
  const objects: Raw[] = [];
  const files: [string, string, string][] = [];
  for (let i = 0; i < commits; i++) {
    const blob = await object('blob', text.encode(`${`file ${i} `.repeat(20_000)}\n`));
    files.push(['100644', `n${i}.txt`, blob.id]);
    const f = await tree([...files].sort(([, a], [, b]) => (a < b ? -1 : 1)));
    const e = await tree([['40000', 'f', f.id]]);
    const d = await tree([['40000', 'e', e.id]]);
    const log = await object('blob', text.encode(`${files.map(([, name]) => name).join('\n')}\n`));
    const root = await tree([
      ['40000', 'd', d.id],
      ['100644', 'log.txt', log.id],
    ]);
    const who = `${author.name} <${author.email}> ${1700000000 + i} +0000`;
    const commit = await object('commit', text.encode(`tree ${root.id}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\nstep ${i}\n`));
    objects.unshift(commit, root, d, e, f, blob, log);
    parent = commit.id;
  }
  return objects;
}

async function request(repo: string, token: string, service: string, body: BodyInit, headers = {}) {
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/${service}`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token}`)}`, ...headers },
      body,
    }),
    on,
  );
  return new Uint8Array(await response.arrayBuffer());
}

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

/** A v2 fetch's pack object count, or the answer when it holds no pack. */
async function fetchV2(repo: string, token: string, args: string[]) {
  const body = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${args.map((a) => pkt(`${a}\n`)).join('')}0000`;
  const bytes = await request(repo, token, 'git-upload-pack', body, { 'git-protocol': 'version=2' });
  const at = new TextDecoder('latin1').decode(bytes).indexOf('PACK');
  if (at < 0) return new TextDecoder().decode(bytes);
  return new DataView(bytes.buffer, bytes.byteOffset + at + 8, 4).getUint32(0);
}

/** R2 reads of this repository's bundles while `run` runs, in a fresh isolate. */
async function bundleReads(repo: string, run: () => Promise<unknown>) {
  isolateLocations.clear();
  isolateTrees.clear();
  const gets = vi.spyOn(scoped.OBJECTS, 'get');
  try {
    await run();
    return gets.mock.calls.filter(([key]) => String(key).startsWith(`platform/v1/${repo}/bundles/`)).length;
  } finally {
    gets.mockRestore();
  }
}

/** A new repository with `commits` commits of `history` pushed to main in one push. */
async function pushedHistory(name: string, commits: number) {
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, { body: { name, policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, on);
  const repo = created.body.id as string;
  const { token } = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, on)).body;
  const main = (await api(`/repos/${repo}/refs`, { cookie }, {}, on)).body.refs['refs/heads/main'] as string;
  const objects = await history(main, commits);
  const tip = objects[0].id;
  const { push_b64 } = compute({
    op: 'branch_push',
    refname: 'refs/heads/main',
    old: main,
    new: tip,
    objects: objects.map((o) => ({ id: o.id, kind: o.kind, data_b64: toBase64(o.data) })),
  });
  const pushed = await request(repo, token, 'git-receive-pack', fromBase64(push_b64));
  expect(new TextDecoder().decode(pushed)).toContain('ok refs/heads/main');
  return { cookie, repo, token, tip };
}

it('keeps the commits and trees of a large push in bundles of their own', async () => {
  // 60 commits: 420 objects, more than a push stages.
  const { repo } = await pushedHistory('history_split', 60);
  const listed = await bindings.OBJECTS.list({ prefix: `platform/v1/${repo}/bundles/` });
  expect(listed.objects.length).toBeGreaterThan(1);
  const kinds: string[] = [];
  for (const { key } of listed.objects) {
    const bytes = new Uint8Array(await ((await bindings.OBJECTS.get(key)) as R2ObjectBody).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const held = new Set<number>();
    for (let at = 0; at < bytes.length; at += 25 + view.getUint32(at + 21)) held.add(bytes[at]);
    kinds.push([...held].sort().join(''));
  }
  // Commits (1) and trees (2) apart from files (3).
  expect(kinds.every((k) => k === '3' || !k.includes('3'))).toBe(true);
  expect(kinds).toContain('3');
});

it('clones a pushed history in a few bundle reads per directory level', async () => {
  const { cookie, repo, token, tip } = await pushedHistory('history_reads', 8);

  // Everything: 9 commits, 1 + 8 * 4 trees, 1 + 8 * 2 files. Five walk rounds (a directory
  // level each, then the last) and the commits and files: a read or two each.
  let count: unknown;
  const full = await bundleReads(repo, async () => (count = await fetchV2(repo, token, [`want ${tip}`, 'done'])));
  expect(count).toBe(59);
  expect(full).toBeGreaterThan(0);
  expect(full).toBeLessThanOrEqual(8);
  // Asked for timings, the pack ends with them; log.txt's later versions went as deltas.
  const timed = await request(repo, token, 'git-upload-pack', `${pkt('command=fetch\n')}0001${pkt(`want ${tip}\n`)}${pkt('done\n')}0000`, {
    'git-protocol': 'version=2',
    'x-yoneda-timing': '1',
  });
  const line = /yoneda-timing (.*)\n/.exec(new TextDecoder('latin1').decode(timed))?.[1] ?? '';
  expect(line).toMatch(/entries=59 /);
  // Walk and pack reads each report what they read against what they wanted.
  expect(line).toMatch(/walk_reads=\d+ walk_read=[\d.]+MiB walk_wanted=[\d.]+MiB walk_bundles=1 walk_span=/);
  expect(line).toMatch(/ reads=\d+ read=[\d.]+MiB wanted=[\d.]+MiB bundles=1 span=/);
  expect(Number(/deltas=(\d+)/.exec(line)?.[1])).toBeGreaterThanOrEqual(4);
  // A partial clone: the same walk, and the commits (no files).
  const partial = await bundleReads(repo, async () => (count = await fetchV2(repo, token, [`want ${tip}`, 'filter blob:none', 'done'])));
  expect(count).toBe(42);
  expect(partial).toBeLessThanOrEqual(7);

  // Blame and search in a fresh isolate: the repository's status says it holds bundles, so
  // every version and candidate file is read from them in bulk, none through a staged read.
  isolateLocations.clear();
  isolateTrees.clear();
  const { env, take } = countingOps(on);
  const blamed = (await api(`/repos/${repo}/blame?path=log.txt`, { cookie }, {}, env)).body;
  expect(blamed.versions).toBe(8);
  expect(blamed.lines).toHaveLength(8);
  const found = (await api(`/repos/${repo}/search?q=file%207`, { cookie }, {}, env)).body;
  expect(found.results.map((r: { path: string }) => r.path)).toEqual(['d/e/f/n7.txt']);
  const ops = take();
  expect(ops.repo_staged_objects ?? 0).toBe(0);
});
