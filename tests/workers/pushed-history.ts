// Pushed histories for bundle-read tests: Git objects built here, sent in one push over
// smart HTTP to a repository with bundles on, then fetched back over protocol v2.
import { expect, vi } from 'vitest';
import { isolateLocations } from '../../cloudflare/worker/repo-bundles';
import { compute } from '../../cloudflare/worker/repo-compute';
import { fromBase64, toBase64 } from '../../cloudflare/worker/repo-objects';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { isolateTrees } from '../../cloudflare/worker/repo-tree-memo';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup } from './repo-fixture';

export const on = { ...scoped, PUSH_BUNDLES: 'on' } as unknown as Env;
export type Raw = { id: string; kind: 'commit' | 'tree' | 'blob'; data: Uint8Array };
const text = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const binary = (id: string) => (id.match(/../g) ?? []).map((h) => Number.parseInt(h, 16));

export async function object(kind: Raw['kind'], data: Uint8Array): Promise<Raw> {
  const whole = new Uint8Array([...text.encode(`${kind} ${data.length}\0`), ...data]);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', whole))), kind, data };
}

export const blob = (content: string) => object('blob', text.encode(content));

export const tree = (entries: [mode: string, name: string, id: string][]) =>
  object('tree', new Uint8Array(entries.flatMap(([mode, name, id]) => [...text.encode(`${mode} ${name}\0`), ...binary(id)])));

/** Entries sorted by name, as Git orders a tree's entries (no names here are prefixes). */
export const sorted = (entries: [string, string, string][]) => [...entries].sort(([, a], [, b]) => (a < b ? -1 : 1));

export const commitObject = (root: string, parent: string, i: number) => {
  const who = `${author.name} <${author.email}> ${1700000000 + i} +0000`;
  return object('commit', text.encode(`tree ${root}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\nstep ${i}\n`));
};

export async function request(repo: string, token: string, service: string, body: BodyInit, headers = {}) {
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

export const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

/** A v2 fetch's pack object count, or the answer when it holds no pack. */
export async function fetchV2(repo: string, token: string, args: string[]) {
  const body = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${args.map((a) => pkt(`${a}\n`)).join('')}0000`;
  const bytes = await request(repo, token, 'git-upload-pack', body, { 'git-protocol': 'version=2' });
  const at = new TextDecoder('latin1').decode(bytes).indexOf('PACK');
  if (at < 0) return new TextDecoder().decode(bytes);
  return new DataView(bytes.buffer, bytes.byteOffset + at + 8, 4).getUint32(0);
}

/** A v2 fetch asking for timings: its pack object count and the `yoneda-timing` fields
 * (PackStats: `walk_reads`, `walk_read` in MiB, ...), units dropped. */
export async function fetchTimed(repo: string, token: string, args: string[]) {
  const body = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${args.map((a) => pkt(`${a}\n`)).join('')}0000`;
  const bytes = await request(repo, token, 'git-upload-pack', body, { 'git-protocol': 'version=2', 'x-yoneda-timing': '1' });
  const text = new TextDecoder('latin1').decode(bytes);
  const at = text.indexOf('PACK');
  const count = new DataView(bytes.buffer, bytes.byteOffset + at + 8, 4).getUint32(0);
  const line = /yoneda-timing (.*)\n/.exec(text)?.[1] ?? '';
  const timing: Record<string, number> = {};
  for (const [, key, value] of line.matchAll(/(\w+)=([\d.]+)/g)) timing[key] = Number(value);
  return { count, timing };
}

/** The kinds each of this repository's bundles holds, as a sorted string of frame kinds
 * (1 commit, 2 tree, 3 blob): `'12'` holds commits and trees only. */
export async function bundleKinds(repo: string) {
  const listed = await scoped.OBJECTS.list({ prefix: `platform/v1/${repo}/bundles/` });
  const kinds: string[] = [];
  for (const { key } of listed.objects) {
    const bytes = new Uint8Array(await ((await scoped.OBJECTS.get(key)) as R2ObjectBody).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const held = new Set<number>();
    for (let at = 0; at < bytes.length; at += 25 + view.getUint32(at + 21)) held.add(bytes[at]);
    kinds.push([...held].sort().join(''));
  }
  return kinds;
}

/** Waits (up to 2 s) until no read of `repo`'s bundles happens for two 25 ms windows: a
 * push leaves the head holder warming the new head's trees in the background, which a
 * measurement must not count as its own. */
async function quiet(repo: string) {
  const gets = vi.spyOn(scoped.OBJECTS, 'get');
  try {
    for (let calm = 0, round = 0; calm < 2 && round < 80; round++) {
      const before = gets.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 25));
      const read = gets.mock.calls.slice(before).some(([key]) => String(key).startsWith(`platform/v1/${repo}/bundles/`));
      calm = read ? 0 : calm + 1;
    }
  } finally {
    gets.mockRestore();
  }
}

/** R2 reads of this repository's objects while `run` runs, in a fresh isolate: `reads` and
 * `bytes` of its bundles (ranged reads count the range), `others` of its other keys. */
export async function objectReads(repo: string, run: () => Promise<unknown>) {
  await quiet(repo);
  isolateLocations.clear();
  isolateTrees.clear();
  const gets = vi.spyOn(scoped.OBJECTS, 'get');
  try {
    await run();
    const counts = { reads: 0, bytes: 0, others: 0 };
    for (const [i, [key, options]] of gets.mock.calls.entries()) {
      if (!String(key).startsWith(`platform/v1/${repo}/`)) continue;
      if (!String(key).startsWith(`platform/v1/${repo}/bundles/`)) {
        counts.others++;
        continue;
      }
      const range = (options as R2GetOptions | undefined)?.range as { length?: number } | undefined;
      const body = (await gets.mock.results[i].value) as R2Object | null;
      counts.reads++;
      counts.bytes += range?.length ?? body?.size ?? 0;
    }
    return counts;
  } finally {
    gets.mockRestore();
  }
}

/** A new repository with `build(main)`'s objects (tip first) pushed to main in one push. */
export async function pushHistory(name: string, build: (main: string) => Promise<Raw[]>) {
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, { body: { name, policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, on);
  const repo = created.body.id as string;
  const { token } = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, on)).body;
  const main = (await api(`/repos/${repo}/refs`, { cookie }, {}, on)).body.refs['refs/heads/main'] as string;
  const objects = await build(main);
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
  return { cookie, repo, token, tip, objects };
}
