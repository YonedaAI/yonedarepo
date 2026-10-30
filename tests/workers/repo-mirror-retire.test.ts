// Retiring a repository's Artifacts mirror when a purge deletes a blob: the quarantine job
// copies what only the mirror holds into the store of record (a Git fetch from the fake
// mirror; the repository is an import, whose history is in its mirror alone), switches the
// repository to no mirror and deletes the Artifacts repository, and the repository clones
// from the platform (full, partial, shallow). A run that stops resumes at the step it
// reached; a projection that meets the retirement pushes nothing; a repository without a
// mirror purges as before; only the purging repository's mirror is deleted.
import { expect, it, vi } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { compute } from '../../cloudflare/worker/repo-compute';
import { type ImportStep, runImport } from '../../cloudflare/worker/repo-import';
import { RepoObjects } from '../../cloudflare/worker/repo-objects';
import { PlatformStore } from '../../cloudflare/worker/repo-platform-store';
import { projectRefs } from '../../cloudflare/worker/repo-projection';
import { quarantineJob } from '../../cloudflare/worker/repo-quarantine';
import type { Env } from '../../cloudflare/worker/types';
import { asGit } from './git-answer';
import { api, author, bindings, drainObjects, file, pushes, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const SECRET = 'staging password: hunter2-mirror\n';
const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
const fetchCommand = (args: string[]) =>
  `${pkt('command=fetch\n')}${pkt('agent=git/2.47.0\n')}${pkt('object-format=sha1\n')}0001${args.map((a) => pkt(`${a}\n`)).join('')}0000`;

async function blobId(text: string) {
  const content = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${content.length}\0`);
  const digest = await crypto.subtle.digest('SHA-1', new Uint8Array([...header, ...content]));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type Raw = { id: string; kind: string; data_b64: string };
/** The fake Artifacts repositories: each one's refs and objects (raw). */
const mirrors = new Map<string, { refs: Map<string, string>; objects: Map<string, Raw> }>();
/** Artifacts repositories deleted, commits fetched, and failures still to answer. */
const deleted: string[] = [];
const fetched: string[] = [];
const failing = { fetches: 0, deletes: 0 };
const missing = () => Object.assign(new Error('repository not found'), { code: 'NOT_FOUND' });

/** The Artifacts binding over the fake mirrors (reads parse their raw objects). */
const artifacts = {
  create: async () => ({}),
  import: async () => ({}),
  get: async (name: string) => {
    const mirror = mirrors.get(name);
    if (!mirror || deleted.includes(name)) throw missing();
    const parsed = (id: string) => {
      const raw = mirror.objects.get(id);
      return raw ? compute({ op: 'parse_objects', objects: [raw] }).objects[0] : null;
    };
    const commit = (id: string) => {
      const c = parsed(id);
      return c?.kind === 'commit' ? { hash: id, treeHash: c.tree, parents: c.parents, message: 'm', author, committer: author, authoredAt: 0, committedAt: 0 } : null;
    };
    return {
      [Symbol.dispose]() {},
      info: async () => ({ remote: `https://artifacts.test/${name}` }),
      createToken: async () => ({ id: 't', plaintext: 'artifact-token' }),
      readCommit: async (id: string) => commit(id),
      readTree: async (id: string) => {
        const t = parsed(id);
        return t?.kind === 'tree' ? t.entries.map((e: any) => ({ name: e.name, mode: '', hash: e.id, type: e.type })) : null;
      },
      readBlob: async (id: string) => {
        const raw = mirror.objects.get(id);
        return raw?.kind === 'blob' ? new Blob([Uint8Array.from(atob(raw.data_b64), (c) => c.charCodeAt(0))]) : null;
      },
      log: async ({ ref, limit = 50, offset = 0 }: any) => {
        const chain = [];
        for (let id: string | undefined = mirror.refs.get(`refs/heads/${ref}`) ?? ref; id; id = commit(id)?.parents[0]) chain.push(commit(id));
        return chain.slice(offset, offset + limit);
      },
    };
  },
  delete: async (name: string) => {
    if (failing.deletes > 0) {
      failing.deletes--;
      throw new Error('artifacts unavailable');
    }
    if (deleted.includes(name) || !mirrors.has(name)) throw missing();
    deleted.push(name);
  },
};

const step: ImportStep = { do: (_name, _config, callback) => callback() };
const workflows = { create: async (options: any) => ({ id: options.id }), get: async () => ({ status: async () => ({ status: 'running' }) }) };
const mirrorEnv = (extra: Record<string, unknown> = {}) =>
  ({ ...scoped, ARTIFACTS: artifacts, PLATFORM_IMPORT: workflows, ...extra }) as unknown as Env;

/** Serves the fake mirrors' Git upload-pack (protocol 0, side-band-64k), on top of the
 * fixture's receive-pack fake: a pack of every object the mirror holds (a server may send
 * more than the haves need). */
function serveMirrors() {
  const spy = vi.mocked(globalThis.fetch);
  const inner = spy.getMockImplementation() as typeof fetch;
  spy.mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const match = /^https:\/\/artifacts\.test\/([^/]+)\/(info\/refs|git-upload-pack)/.exec(url);
    if (!match) return inner(input, init);
    const mirror = mirrors.get(match[1]);
    if (!mirror || deleted.includes(match[1])) return new Response('not found', { status: 404 });
    if (match[2] === 'info/refs') {
      const lines = [...mirror.refs].map(([ref, id], i) => pkt(`${id} ${ref}${i ? '' : '\0side-band-64k ofs-delta'}\n`));
      return new Response(`${pkt('# service=git-upload-pack\n')}0000${lines.join('')}0000`);
    }
    if (failing.fetches > 0) {
      failing.fetches--;
      return new Response('busy', { status: 503 });
    }
    const request = new TextDecoder().decode(new Uint8Array(await new Response(init?.body).arrayBuffer()));
    fetched.push(...[...request.matchAll(/want ([0-9a-f]{40})/g)].map((m) => m[1]));
    const objects = [...mirror.objects.values()];
    const tip = objects.find((o) => o.kind === 'commit')?.id;
    const body = Uint8Array.from(atob(compute({ op: 'staged_push', commit: tip, objects }).push_b64), (c) => c.charCodeAt(0));
    const at = body.findIndex((_, i) => new TextDecoder().decode(body.subarray(i, i + 4)) === 'PACK');
    const pack = body.subarray(at);
    const parts: Uint8Array[] = [new TextEncoder().encode(pkt('NAK\n'))];
    for (let i = 0; i < pack.length; i += 1000) {
      const piece = pack.subarray(i, i + 1000);
      parts.push(new TextEncoder().encode((piece.length + 5).toString(16).padStart(4, '0')), Uint8Array.of(1), piece);
    }
    parts.push(new TextEncoder().encode('0000'));
    return new Response(new Blob(parts));
  });
}

/** A history built by the platform on the R2 store (it plays the remote): `main`, and the
 * secret on a commit of its own. Answers its refs and raw objects. */
async function remote(name: string, secretAtTip = false) {
  const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
  const cookie = await signup(name);
  const files = [file('README.md', '# m\n'), file('src/app.txt', 'hello\n'), ...(secretAtTip ? [file('config/staging.txt', SECRET)] : [])];
  const created = await api('/repos', { cookie }, {
    body: { name: 'remote', policy: { required_checks: [], approvals: 0 }, files, author },
  }, local);
  const main = created.body.commit as string;
  const leak = await api(`/repos/${created.body.id}/commits`, { cookie }, { body: { parent: main, changes: [file('config/staging.txt', SECRET)], message: 'leak', author } }, local);
  await drainObjects(local);
  const prefix = `platform/v1/${created.body.id}/git/`;
  const objects = new Map<string, Raw>();
  for (const { key } of (await bindings.OBJECTS.list({ prefix })).objects) {
    const stored = await bindings.OBJECTS.get(key);
    const data = new Uint8Array(await stored!.arrayBuffer());
    const id = key.slice(prefix.length);
    objects.set(id, { id, kind: stored!.customMetadata!.kind as string, data_b64: btoa(String.fromCharCode(...data)) });
  }
  return { main, leak: leak.body.commit as string, objects };
}

/** A repository imported from `source` (its mirror holds `main` and the secret's commit),
 * its history in the mirror alone. */
async function imported(name: string, env: Env, source: Awaited<ReturnType<typeof remote>>) {
  const cookie = await signup(name);
  const created = await api('/repos/import', { cookie }, { body: { name: 'imported', url: 'https://git.example/r.git' } }, env);
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  // The leak's commit first: the fake answers its pack with it as the tip.
  const objects = new Map([...source.objects].sort(([a], [b]) => Number(b === source.leak) - Number(a === source.leak)));
  mirrors.set(`yr-${id}`, { refs: new Map([['refs/heads/main', source.main], ['refs/heads/leak', source.leak]]), objects });
  await runImport(env, { repo: id, url: 'https://git.example/r.git', branch: 'main', max: 10 }, step);
  return { cookie, id };
}

async function purge(id: string, cookie: string, env: Env) {
  const blob = await blobId(SECRET);
  const made = await api(`/repos/${id}/quarantine`, { cookie }, { body: { blob, path: 'config/staging.txt', reason: 'a leaked password' } }, env);
  expect(made.status).toBe(200);
  return api(`/repos/${id}/quarantine/${made.body.record.id}/purge`, { cookie }, { body: { confirm: blob } }, env);
}

const job = (env: Env, id: string) => quarantineJob(env, { v: 1, kind: 'platform_quarantine', repo_id: id, job_id: 'quarantine-test' });

let readers = 0;
async function git(id: string, cookie: string, args: string[], env: Env) {
  return new TextDecoder().decode(await gitBytes(id, cookie, args, env));
}

async function gitBytes(id: string, cookie: string, args: string[], env: Env) {
  const token = await api(`/repos/${id}/tokens`, { cookie }, { body: { name: `reader-${++readers}`, scopes: ['read'] } }, env);
  const response = await platformFetch(
    new Request(`https://yoneda/git/${id}.git/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token.body.token}`)}`, 'git-protocol': 'version=2' },
      body: fetchCommand(args),
    }),
    env,
  );
  return new Uint8Array(await response.arrayBuffer());
}

async function inStore(env: Env, id: string, objects: Raw[]) {
  const store = new RepoObjects(env, id, new PlatformStore(env, id));
  return (await store.stored(objects.map((o) => ({ id: o.id, kind: o.kind })))).map((o) => o.id).sort();
}

for (const bundles of ['off', 'on'])
  it(`retires the mirror of a purged repository and clones from the platform (bundles ${bundles})`, async () => {
    deleted.length = fetched.length = 0;
    const env = mirrorEnv({ PUSH_BUNDLES: bundles });
    serveMirrors();
    const source = await remote(`remote_${bundles}`);
    const { main, leak } = source;
    const objects = [...source.objects.values()];
    const { cookie, id } = await imported(`mirror_${bundles}`, env, source);
    const other = await imported(`mirror_other_${bundles}`, env, source);
    const secret = await blobId(SECRET);
    // Imported history is in the mirror alone: the platform cannot serve it yet.
    expect(await inStore(env, id, objects)).toEqual([]);
    expect(await git(id, cookie, [`want ${main}`, 'done'], env)).toContain('held only as imported history');

    const purged = await purge(id, cookie, env);
    expect([purged.status, purged.body.purged, purged.body.mirror]).toEqual([200, 1, true]);
    let listed = await api(`/repos/${id}/quarantine`, { cookie }, {}, env);
    expect(listed.body.records[0].mirror).toBe('retiring');
    expect(listed.body.mirror.state).toBe('copying');
    // The purge asked for the job at once.
    expect(queued.filter((m) => m.kind === 'platform_quarantine' && m.repo_id === id)).toHaveLength(1);

    await job(env, id);
    expect(new Set(fetched)).toEqual(new Set([main, leak]));
    listed = await api(`/repos/${id}/quarantine`, { cookie }, {}, env);
    expect(listed.body.mirror, JSON.stringify(listed.body.mirror)).toMatchObject({ state: 'retired', detail: null });
    expect(listed.body.records[0]).toMatchObject({ state: 'purged', mirror: 'retired' });
    expect(listed.body.mirror.state).toBe('retired');
    expect((await api(`/repos/${id}`, { cookie }, {}, env)).body.object_store).toBe(`platform:${id}`);
    // Only this repository's mirror is gone.
    expect(deleted).toEqual([`yr-${id}`]);
    expect(mirrors.has(`yr-${other.id}`) && !deleted.includes(`yr-${other.id}`)).toBe(true);
    // Everything the mirror held is in the store of record, but the purged blob.
    const kept = objects.filter((o) => o.id !== secret).map((o) => o.id).sort();
    expect(await inStore(env, id, objects)).toEqual(kept);

    // Clones come from the platform: full, partial and shallow.
    for (const args of [[`want ${main}`, 'done'], [`want ${main}`, 'filter blob:none', 'done'], [`want ${main}`, 'deepen 1', 'done']]) {
      const text = await git(id, cookie, args, env);
      expect(text, args.join(' ')).toContain('packfile');
      expect(text, args.join(' ')).not.toContain('ERR');
    }
    // The purged blob is not served, and its bytes were never copied.
    const read = await api(`/repos/${id}/objects`, { cookie }, { body: { objects: [{ id: secret, kind: 'blob' }] } }, env);
    expect([read.status, read.body.error?.code]).toEqual([451, 'QUARANTINED']);
    expect(await bindings.OBJECTS.head(`platform/v1/${id}/git/${secret}`)).toBeNull();
    expect((await api(`/repos/${id}/blob?path=src/app.txt`, { cookie }, {}, env)).body.content).toBe('hello\n');

    // Nothing is projected to the deleted mirror again.
    const before = pushes.length;
    const landed = await api(`/repos/${id}/commits`, { cookie }, { body: { ref: 'main', changes: [file('b.txt', 'b\n')], message: 'after', author } }, env);
    expect(landed.status).toBe(200);
    await api(`/repos/${id}/land`, { cookie }, { body: { ref: 'main', commit: landed.body.commit } }, env);
    expect(await projectRefs(env, { v: 1, kind: 'platform_project', repo_id: id, job_id: 'refs' })).toEqual({ projected: 0 });
    expect(pushes.length).toBe(before);
    // The job has nothing left to do.
    await job(env, id);
    expect(deleted).toEqual([`yr-${id}`]);
  });

it('resumes a retirement that stopped, at the step it reached, and fences a racing projection', async () => {
  deleted.length = fetched.length = 0;
  const env = mirrorEnv({ PUSH_BUNDLES: 'on' });
  serveMirrors();
  const source = await remote('remote_resume');
  const { main } = source;
  const objects = [...source.objects.values()];
  const { cookie, id } = await imported('mirror_resume', env, source);
  // A landing waits to be projected to the mirror when the purge comes.
  const next = await api(`/repos/${id}/commits`, { cookie }, { body: { ref: 'main', changes: [file('c.txt', 'c\n')], message: 'c', author } }, env);
  await api(`/repos/${id}/land`, { cookie }, { body: { ref: 'main', commit: next.body.commit } }, env);
  await drainObjects(env);
  expect((await api(`/repos/${id}`, { cookie }, {}, env)).body.projections.length).toBeGreaterThan(0);
  expect((await purge(id, cookie, env)).body.mirror).toBe(true);

  // The mirror is unavailable: the run records why and keeps the mirror.
  failing.fetches = 1;
  await job(env, id);
  let listed = await api(`/repos/${id}/quarantine`, { cookie }, {}, env);
  expect(listed.body.mirror).toMatchObject({ state: 'copying' });
  expect(listed.body.mirror.detail).toContain('503');
  expect((await api(`/repos/${id}`, { cookie }, {}, env)).body.object_store).toBe(`artifacts:${env.ARTIFACTS_NAMESPACE}/yr-${id}`);
  expect(deleted).toEqual([]);

  // Copied and switched, then the delete fails: the repository already reads from the
  // store of record, and projection has stopped for good.
  failing.deletes = 1;
  await job(env, id);
  listed = await api(`/repos/${id}/quarantine`, { cookie }, {}, env);
  expect(listed.body.mirror.state).toBe('switched');
  const status = (await api(`/repos/${id}`, { cookie }, {}, env)).body;
  expect([status.object_store, status.projections]).toEqual([`platform:${id}`, []]);
  const before = pushes.length;
  expect(await projectRefs(env, { v: 1, kind: 'platform_project', repo_id: id, job_id: 'refs' })).toEqual({ projected: 0 });
  expect(pushes.length).toBe(before);
  expect((await api(`/repos/${id}/blob?path=src/app.txt`, { cookie }, {}, env)).body.content).toBe('hello\n');
  expect(await git(id, cookie, [`want ${main}`, 'done'], env)).toContain('packfile');

  // The next run deletes the mirror and closes the retirement.
  await job(env, id);
  listed = await api(`/repos/${id}/quarantine`, { cookie }, {}, env);
  expect([listed.body.mirror.state, listed.body.records[0].mirror]).toEqual(['retired', 'retired']);
  expect(deleted).toEqual([`yr-${id}`]);
  expect((await inStore(env, id, objects)).length).toBe(objects.length - 1);
});

it('purges a repository without an Artifacts mirror as before', async () => {
  deleted.length = fetched.length = 0;
  const local = { ...mirrorEnv(), PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
  const cookie = await signup('mirror_none');
  const created = await api('/repos', { cookie }, {
    body: { name: 'plain', policy: { required_checks: [], approvals: 0 }, files: [file('config/staging.txt', SECRET)], author },
  }, local);
  await drainObjects(local);
  const purged = await purge(created.body.id, cookie, local);
  expect([purged.status, purged.body.purged, purged.body.mirror]).toEqual([200, 1, false]);
  await job(local, created.body.id);
  const listed = await api(`/repos/${created.body.id}/quarantine`, { cookie }, {}, local);
  expect([listed.body.mirror, listed.body.records[0].mirror]).toEqual([null, null]);
  expect((await api(`/repos/${created.body.id}`, { cookie }, {}, local)).body.object_store).toMatch(/^r2:/);
  expect([deleted, fetched]).toEqual([[], []]);
});

it('serves Git a framed refusal after retirement when the purged blob is in the tip, and a partial clone the rest', async () => {
  deleted.length = fetched.length = 0;
  const env = mirrorEnv({ PUSH_BUNDLES: 'on' });
  serveMirrors();
  const source = await remote('remote_tip', true);
  const { cookie, id } = await imported('mirror_tip', env, source);
  expect((await purge(id, cookie, env)).body.mirror).toBe(true);
  await job(env, id);
  expect((await api(`/repos/${id}/quarantine`, { cookie }, {}, env)).body.mirror.state).toBe('retired');
  const answer = async (args: string[]) => asGit(await gitBytes(id, cookie, args, env), true);
  for (const args of [[`want ${source.main}`, 'done'], [`want ${source.main}`, 'deepen 1', 'done']]) {
    const full = await answer(args);
    expect(full, args.join(' ')).toMatchObject({ badBand: null, pack: 0 });
    expect(full.error, args.join(' ')).toMatch(/QUARANTINED: Blob [0-9a-f]{40} \(config\/staging\.txt\) is quarantined/);
  }
  const partial = await answer([`want ${source.main}`, 'filter blob:none', 'done']);
  expect([partial.error, partial.badBand, partial.pack > 0]).toEqual([null, null, true]);
  const lazy = await answer([`want ${await blobId(SECRET)}`, `want ${await blobId('hello\n')}`, 'filter blob:none', 'done']);
  expect([lazy.error, lazy.badBand, lazy.pack > 0]).toEqual([null, null, true]);
  expect(lazy.progress.join('\n')).toMatch(/QUARANTINED/);
});
