// Shared by the stored-pack tests (repo-pack-cache, repo-pack-jobs): a repository with a
// pushed history of a few MiB, Git requests against it, and R2 reads counted in a fresh
// isolate.
import { expect, vi } from 'vitest';
import { type BuildPlan, buildPacks } from '../../cloudflare/worker/pack-builder';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import { isolateLocations } from '../../cloudflare/worker/repo-bundles';
import { compute } from '../../cloudflare/worker/repo-compute';
import { uploadPackV2 } from '../../cloudflare/worker/repo-git-v2';
import { fromBase64, toBase64 } from '../../cloudflare/worker/repo-objects';
import { caller, RepoContext } from '../../cloudflare/worker/repo-ops';
import type { Fresh } from '../../cloudflare/worker/repo-pack-cache';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { isolateTrees } from '../../cloudflare/worker/repo-tree-memo';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, delayed, file, queued, scoped, signup } from './repo-fixture';

export const on = { ...scoped, PUSH_BUNDLES: 'on', PACK_CACHE: 'on' } as unknown as Env;
export type Raw = { id: string; kind: 'commit' | 'tree' | 'blob'; data: Uint8Array };
const text = new TextEncoder();
export const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const binary = (id: string) => (id.match(/../g) ?? []).map((h) => Number.parseInt(h, 16));

async function object(kind: Raw['kind'], data: Uint8Array): Promise<Raw> {
  const whole = new Uint8Array([...text.encode(`${kind} ${data.length}\0`), ...data]);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', whole))), kind, data };
}

/** `commits` commits on `parent`, each adding a file of about 600 KB of distinct text
 * (a pack of a few MiB) under d/. */
export async function history(parent: string, commits: number, salt = '') {
  const objects: Raw[] = [];
  const files: [string, string, string][] = [];
  for (let i = 0; i < commits; i++) {
    const lines = Array.from({ length: 12_000 }, (_, n) => `${salt}line ${n} of file ${i}: ${(n * 7919 + i) % 100003}\n`);
    const blob = await object('blob', text.encode(lines.join('')));
    files.push(['100644', `n${i}.txt`, blob.id]);
    const d = await object('tree', new Uint8Array(files.flatMap(([mode, name, id]) => [...text.encode(`${mode} ${name}\0`), ...binary(id)])));
    const root = await object('tree', new Uint8Array([...text.encode('40000 d\0'), ...binary(d.id)]));
    const who = `${author.name} <${author.email}> ${1700000000 + i} +0000`;
    const commit = await object('commit', text.encode(`tree ${root.id}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\n${salt}step ${i}\n`));
    objects.unshift(commit, root, d, blob);
    parent = commit.id;
  }
  return objects;
}

export async function request(env: Env, repo: string, token: string, service: string, body: BodyInit, headers = {}) {
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/${service}`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token}`)}`, ...headers },
      body,
    }),
    env,
  );
  return new Uint8Array(await response.arrayBuffer());
}

export const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

/** The pack a v2 fetch answers (side-band data joined), or the answer when it has none. */
export async function fetchV2(env: Env, repo: string, token: string, args: readonly string[]) {
  const body = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${args.map((a) => pkt(`${a}\n`)).join('')}0000`;
  const bytes = await request(env, repo, token, 'git-upload-pack', body, { 'git-protocol': 'version=2' });
  const at = new TextDecoder('latin1').decode(bytes).indexOf('packfile\n');
  if (at < 0) return new TextDecoder().decode(bytes);
  const parts: number[] = [];
  for (let i = at + 'packfile\n'.length; i + 4 <= bytes.length; ) {
    const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(i, i + 4)), 16);
    if (length === 0) break;
    if (bytes[i + 4] === 1) parts.push(...bytes.subarray(i + 5, i + length));
    i += length;
  }
  return new Uint8Array(parts);
}

/** R2 reads while `run` runs in a fresh isolate: of this repository's bundles and of stored
 * packs. */
export async function reads(repo: string, run: () => Promise<unknown>) {
  isolateLocations.clear();
  isolateTrees.clear();
  const gets = vi.spyOn(scoped.OBJECTS, 'get');
  try {
    await run();
    const keys = gets.mock.calls.map(([key]) => String(key));
    return {
      bundles: keys.filter((k) => k.startsWith(`platform/v1/${repo}/bundles/`)).length,
      packs: keys.filter((k) => k.startsWith(`derived/v1/${repo}/packs/`)).length,
    };
  } finally {
    gets.mockRestore();
  }
}

/** A pack's object count, or the answer when the fetch sent none. */
export const count = (pack: Uint8Array | string) =>
  typeof pack === 'string' ? pack : new DataView(pack.buffer, pack.byteOffset + 8, 4).getUint32(0);

/** A repository whose main gained `commits` commits by `git push` (bundled), with a token
 * that reads and pushes, and `push` for more. */
export async function pushedRepo(name: string, env: Env, commits = 6) {
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, { body: { name: name.replaceAll('_', '-'), policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, env);
  const repo = created.body.id as string;
  const { token } = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, env)).body;
  const push = async (old: string, objects: Raw[]) => {
    const { push_b64 } = compute({
      op: 'branch_push',
      refname: 'refs/heads/main',
      old,
      new: objects[0].id,
      objects: objects.map((o) => ({ id: o.id, kind: o.kind, data_b64: toBase64(o.data) })),
    });
    const pushed = await request(env, repo, token, 'git-receive-pack', fromBase64(push_b64));
    expect(new TextDecoder().decode(pushed)).toContain('ok refs/heads/main');
  };
  const main = (await api(`/repos/${repo}/refs`, { cookie }, {}, env)).body.refs['refs/heads/main'] as string;
  const objects = await history(main, commits);
  await push(main, objects);
  return { cookie, repo, token, push, main, objects, tip: objects[0].id };
}

/** The queued (and delayed) messages of `kind`, taken off the queue. */
export function take(kind: string) {
  const out: any[] = [];
  for (const list of [queued, delayed])
    for (let i = list.length - 1; i >= 0; i--) if (list[i].kind === kind) out.unshift(...list.splice(i, 1));
  return out;
}

/** Runs `message` as the consumer does. */
export async function runJob(env: Env, body: unknown) {
  await platformJob(env, { body, attempts: 1, ack: () => {}, retry: () => {} } as unknown as Message<any>);
}

/** Runs pack-build jobs until none is left (each may queue the next), answering their ids. */
export async function drainPackBuilds(env: Env, limit = 20) {
  const ran: string[] = [];
  for (let jobs = take('platform_pack_build'); jobs.length; jobs = take('platform_pack_build'))
    for (const message of jobs) {
      if (ran.length >= limit) throw new Error(`more than ${limit} pack builds: ${ran.join(', ')}`);
      ran.push(message.job_id);
      await runJob(env, message);
    }
  return ran;
}

/** The packfile a v2 fetch answer carries (its side-band data joined). */
function packfile(bytes: Uint8Array) {
  const at = new TextDecoder('latin1').decode(bytes).indexOf('packfile\n');
  if (at < 0) throw new Error(new TextDecoder().decode(bytes).slice(0, 300));
  const parts: number[] = [];
  for (let i = at + 'packfile\n'.length; i + 4 <= bytes.length; ) {
    const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(i, i + 4)), 16);
    if (length === 0) break;
    if (bytes[i + 4] === 1) parts.push(...bytes.subarray(i + 5, i + length));
    i += length;
  }
  return new Uint8Array(parts);
}

/** What the platform's own upload-pack sends for `fresh` (built, never from the store). */
export async function platformPack(env: Env, repo: string, fresh: Fresh) {
  const built = new RepoContext({ ...env, PACK_CACHE: 'off' } as Env, repo, caller(env, repo, { _system: 'derive' }));
  const args = [...fresh.wants.map((w) => `want ${w}`), ...(fresh.omit_blobs ? ['filter blob:none'] : []), ...(fresh.depth ? [`deepen ${fresh.depth}`] : []), 'done'];
  const body = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${args.map((a) => pkt(`${a}\n`)).join('')}0000`;
  const answer = await uploadPackV2(built, await built.objects(), new Response(body).body as ReadableStream<Uint8Array>);
  return packfile(new Uint8Array(await answer.arrayBuffer()));
}

/** Test double of the PackBuilder container (the image itself is tested with Git in its
 * crate and in Docker): it answers /fetch, /pack and /stats with what the platform's
 * upload-pack builds. `calls` records each request; `destroyed` counts kills. */
export function fakeBuilders(env: () => Env, options: { packs?: (fresh: Fresh, pack: Uint8Array) => Uint8Array; withheld?: () => Promise<boolean> } = {}) {
  const record = { calls: [] as string[], started: 0, destroyed: 0 };
  const instance = (repo: string) => {
    let last = 0;
    return {
      async startAndWaitForPorts(start: any) {
        record.started++;
        expect(start.startOptions.envVars.MIRROR_URL).toBe(`http://mirror.internal/${repo}.git`);
      },
      async destroy() {
        record.destroyed++;
      },
      async containerFetch(req: Request) {
        const url = new URL(req.url);
        record.calls.push(`${url.pathname}${url.search}`);
        const wants = (await req.text()).split('\n').filter(Boolean);
        if (url.pathname === '/fetch') {
          const full = await platformPack(env(), repo, { wants, omit_blobs: false, depth: null, deepen_relative: false });
          return Response.json({ mirror: false, from_platform: wants.length, objects: new DataView(full.buffer, full.byteOffset + 8, 4).getUint32(0), ms: 1, cpu_ms: 1, peak_mib: 1 });
        }
        if (url.pathname === '/pack') {
          const fresh = { wants, omit_blobs: url.searchParams.get('filter') === 'blob:none', depth: url.searchParams.get('depth') ? 1 : null, deepen_relative: false };
          const pack = await platformPack(env(), repo, fresh);
          last = pack.length;
          return new Response(options.packs ? options.packs(fresh, pack) : pack);
        }
        return Response.json({ ok: true, bytes: last, ms: 1, cpu_ms: 1, peak_mib: 1 });
      },
    };
  };
  const namespace = {
    idFromName: (name: string) => ({ toString: () => `id:${name}`, name }),
    get: (id: { name: string }) => {
      const repo = id.name.replace(/^packs:/, '');
      const withheld = options.withheld ?? (async () => (await new RepoContext(env(), repo, caller(env(), repo, { _system: 'derive' })).objects()).withholdsAny());
      return { build: (plan: BuildPlan) => buildPacks(instance(repo), env(), plan, withheld) };
    },
  };
  return { namespace, record };
}
