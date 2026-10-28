// No directory is left out of code search for its size: the top-level files of a
// repository (more than one chunk's 8 MiB of them) are indexed in chunks, and only a file
// over the per-file cap is searched by path alone, named with the reason (dev showed "Not
// searched (too large): /" for claude-code, whose root holds an 11 MB GIF).
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { compute } from '../../cloudflare/worker/repo-compute';
import { fromBase64, toBase64 } from '../../cloudflare/worker/repo-objects';
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

it('indexes a root of more than 8 MiB in chunks and names only the file over the cap', async () => {
  const cookie = await signup('search_chunks');
  const created = await api('/repos', { cookie }, { body: { name: 'search-chunks', policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, on);
  const repo = created.body.id as string;
  const { token } = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, on)).body;
  const main = (await api(`/repos/${repo}/refs`, { cookie }, {}, on)).body.refs['refs/heads/main'] as string;

  // 30 top-level files of 300 KB (9 MB), one with a needle, and a 4.5 MB log.
  const files: [string, Raw][] = [];
  for (let i = 0; i < 30; i++) {
    const line = i === 17 ? 'a haystack needle here\n' : `filler line of file ${i}\n`;
    files.push([`part${String(i).padStart(2, '0')}.txt`, await object('blob', text.encode(line.repeat(Math.ceil(300_000 / line.length))))]);
  }
  files.push(['huge.log', await object('blob', text.encode('needle in a huge log\n'.repeat(225_000)))]);
  files.push(['README.md', await object('blob', text.encode('# Readme with a needle\n'))]);
  files.sort(([a], [b]) => (a < b ? -1 : 1));
  const root = await object('tree', new Uint8Array(files.flatMap(([name, b]) => [...text.encode(`100644 ${name}\0`), ...binary(b.id)])));
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const commit = await object('commit', text.encode(`tree ${root.id}\nparent ${main}\nauthor ${who}\ncommitter ${who}\n\nbig root\n`));
  const { push_b64 } = compute({
    op: 'branch_push',
    refname: 'refs/heads/main',
    old: main,
    new: commit.id,
    objects: [commit, root, ...files.map(([, b]) => b)].map((o) => ({ id: o.id, kind: o.kind, data_b64: toBase64(o.data) })),
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

  const found = (await api(`/repos/${repo}/search?query=needle`, { cookie }, {}, on)).body;
  // The root's files are searched (part17 by content, README too); the log is matched by
  // neither content nor path, and is named as not searched, with why.
  expect(found.results.map((r: { path: string }) => r.path).sort()).toEqual(['README.md', 'part17.txt']);
  expect(found.skipped_files).toEqual([{ path: 'huge.log', reason: 'larger than 4 MiB' }]);
  expect(found.skipped_count).toBe(1);
  expect(found.partitions_built).toBe(1);
  // Stored as two chunks or more: the partition's key holds their count.
  const keys = (await bindings.OBJECTS.list({ prefix: `derived/v1/${repo}/search/v3/` })).objects.map((o) => o.key);
  const manifest = keys.find((k) => !/\/\d+$/.test(k)) as string;
  const chunks = (await (await bindings.OBJECTS.get(manifest))?.json<{ chunks: number }>())?.chunks ?? 0;
  expect(chunks).toBeGreaterThanOrEqual(2);
  expect(keys.filter((k) => k.startsWith(`${manifest}/`))).toHaveLength(chunks);

  // A second search reads the stored chunks and builds nothing.
  const again = (await api(`/repos/${repo}/search?query=needle`, { cookie }, {}, on)).body;
  expect(again.partitions_built).toBe(0);
  expect(again.results).toHaveLength(2);
});
