// An import is a clone: `cloneRepository` runs Git in a check container and hands what it
// fetched to what a push stores and records with. GitHub is a fake that names a head, and the
// container a fake serving what its real half serves (yoneda-runtime's clone_import_tests,
// against real Git) of a history built here: several branches, some diverged, a merge, and
// lightweight and annotated tags. No test here reaches any other object store: R2 and the
// authority are real, and a clone is read back through the platform's own Git.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CheckInstance, startCheck } from '../../cloudflare/worker/check-container';
import { cloneSession } from '../../cloudflare/worker/import-container';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { type CloneParams, cloneRepository, MAX_PACK_BYTES } from '../../cloudflare/worker/repo-clone';
import { caller } from '../../cloudflare/worker/repo-ops';
import { packKey, seedOf, wholeClone } from '../../cloudflare/worker/repo-pack-cache';
import { reimportRepository } from '../../cloudflare/worker/repo-reimport';
import type { Env } from '../../cloudflare/worker/types';
import { asGit } from './git-answer';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';
import { binary, join, object, type Obj, pack, pkt, text, tree } from './synthetic-pack';

usePlatformFixture();
afterEach(() => vi.restoreAllMocks());

const URL_OF = 'https://github.com/acme/src.git';
const WHO = 'A <a@example.com> 1700000000 +0000';
const running = { do: <T>(_name: string, _config: unknown, work: () => Promise<T>) => work() };
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

type Built = { id: string; tree: string; files: Map<string, string> };

/** A repository built object by object. */
class Remote {
  objects: Obj[] = [];
  lines: string[] = [];
  refs: { ref: string; id: string; commit: string; tag_b64?: string }[] = [];
  seen = new Set<string>();

  add(made: Obj) {
    if (!this.seen.has(made.id)) this.objects.push(made);
    this.seen.add(made.id);
    return made;
  }

  /** A commit of `files` (path to content), changing them over its first parent. */
  async commit(message: string, files: Record<string, string>, parents: Built[] = []) {
    const held = new Map(parents[0]?.files ?? []);
    const touches: unknown[] = [];
    for (const [path, content] of Object.entries(files)) {
      const blob = this.add(await object('blob', text.encode(content)));
      const old = held.get(path) ?? null;
      touches.push({ path, op: old ? 'modify' : 'add', old_blob: old, new_blob: blob.id, mode: 'blob' });
      held.set(path, blob.id);
    }
    const entries = [...held].sort().map(([name, id]): [string, string, string] => ['100644', name, id]);
    const root = this.add(await tree(entries));
    const lines = [`tree ${root.id}`, ...parents.map((p) => `parent ${p.id}`), `author ${WHO}`, `committer ${WHO}`, '', message, ''];
    const made = this.add(await object('commit', text.encode(lines.join('\n'))));
    this.lines.push(JSON.stringify({
      commit: made.id,
      data_b64: base64(made.data),
      touches,
      objects: [{ id: made.id, kind: 'commit' }],
      check: false,
    }));
    return { id: made.id, tree: root.id, files: held };
  }

  branch(name: string, at: Built) {
    this.refs.push({ ref: `refs/heads/${name}`, id: at.id, commit: at.id });
  }
  light(name: string, at: Built) {
    this.refs.push({ ref: `refs/tags/${name}`, id: at.id, commit: at.id });
  }
  /** An annotated tag. Answers its object's id. */
  async annotated(name: string, at: Built) {
    const body = `object ${at.id}\ntype commit\ntag ${name}\ntagger ${WHO}\n\nreleased\n`;
    const data = text.encode(body);
    const head = text.encode(`tag ${data.length}\0`);
    const digest = await crypto.subtle.digest('SHA-1', join([head, data]));
    const id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    this.refs.push({ ref: `refs/tags/${name}`, id, commit: at.id, tag_b64: base64(data) });
    return id;
  }

  /** All objects, framed as `/clone/objects` frames them. */
  frames() {
    return this.objects.map((o) => {
      const size = new Uint8Array(4);
      new DataView(size.buffer).setUint32(0, o.data.length);
      return join([Uint8Array.of({ commit: 1, tree: 2, blob: 3 }[o.kind]), binary(o.id), size, o.data]);
    });
  }
}

/** main with a merge, `side` merged into it and on ahead, `other` diverged from an old commit,
 * and tags on all of them. */
async function history() {
  const remote = new Remote();
  const root = await remote.commit('root', { 'a.txt': 'one\n', 'b.txt': 'two\n' });
  const second = await remote.commit('second', { 'a.txt': 'three\n' }, [root]);
  const sideOne = await remote.commit('side one', { 'side.txt': 'side\n' }, [second]);
  const third = await remote.commit('third', { 'b.txt': 'four\n' }, [second]);
  const merge = await remote.commit('merge', { 'side.txt': 'side\n' }, [third, sideOne]);
  const sideTwo = await remote.commit('side two', { 'side.txt': 'more\n' }, [sideOne]);
  const other = await remote.commit('other', { 'other.txt': 'other\n' }, [root]);
  const otherTwo = await remote.commit('other two', { 'other.txt': 'again\n' }, [other]);
  remote.branch('main', merge);
  remote.branch('side', sideTwo);
  remote.branch('other', otherTwo);
  remote.light('light', second);
  const tag = await remote.annotated('v1', sideOne);
  return { remote, root, second, sideOne, third, merge, sideTwo, other, otherTwo, tag };
}

type Behavior = {
  start?: Error;
  answer?: (path: string) => Response | null;
  pieces?: number;
  default_branch?: string | null;
  lost?: () => boolean;
};

/** A container with the clone of `remote` on its disk, and what was asked of it. */
async function container(remote: Remote, behavior: Behavior = {}) {
  const calls: string[] = [];
  const starts: any[] = [];
  const asks: any[] = [];
  const bytes = await pack(remote.objects);
  const frames = remote.frames();
  const stream = (of: Uint8Array) =>
    new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const size = behavior.pieces ?? 65536;
        for (let at = 0; at < of.length; at += size) controller.enqueue(of.slice(at, at + size));
        controller.close();
      },
    }));
  const fake: CheckInstance = {
    async startAndWaitForPorts(options) {
      calls.push('start');
      starts.push(options);
      if (behavior.start) throw behavior.start;
    },
    async containerFetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      calls.push(`${path}${url.search}`);
      expect(request.headers.get('authorization')).toMatch(/^Bearer /);
      const held = behavior.answer?.(path);
      if (held) return held;
      if (path === '/clone') {
        asks.push(await request.json());
        return Response.json({
          default_branch: behavior.default_branch === undefined ? 'main' : behavior.default_branch,
          pack_bytes: bytes.length,
          pack_objects: remote.objects.length,
          objects: remote.objects.length,
          commits: remote.lines.length,
          refs: remote.refs.length,
          refs_skipped: 0,
        });
      }
      if (path === '/clone/pack') return stream(bytes);
      if (path === '/clone/objects') return stream(join(frames.slice(Number(url.searchParams.get('from')))));
      if (path === '/clone/commits') {
        const from = Number(url.searchParams.get('from'));
        const count = Number(url.searchParams.get('count'));
        return new Response(remote.lines.slice(from, from + count).map((l) => `${l}\n`).join(''));
      }
      if (path === '/clone/refs') return new Response(remote.refs.map((r) => `${JSON.stringify(r)}\n`).join(''));
      return new Response('not found', { status: 404 });
    },
    async destroy() {
      calls.push('destroy');
    },
  };
  return { fake, calls, starts, asks, bytes };
}

/** What GitHub answers when asked for a head. */
function github(answer: () => Response | null = () => null) {
  const asked: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://github.com/')) return original(input, init);
    asked.push({ url, init });
    const body = String(init?.body ?? '');
    const prefix = /ref-prefix (\S+)/.exec(body)?.[1] ?? 'HEAD';
    const held = answer();
    if (held) return held;
    const line = `${'a'.repeat(40)} ${prefix} symref-target:refs/heads/main\n`;
    return new Response(`${pkt(line)}0000`, { headers: { 'content-type': 'application/x-git-upload-pack-result' } });
  });
  return asked;
}

/** A repository waiting for its clone, as an import's request leaves it. */
async function asked(name: string, instance: CheckInstance, extra: object = {}) {
  const owner = { cookie: await signup(`clone_${name}`) };
  let session: ReturnType<typeof cloneSession> | undefined;
  let started: any;
  const holder: { env?: Env; named: string[]; steps: any[] } = { named: [], steps: [] };
  const IMPORT_RUNNERS = {
    idFromName: (n: string) => (holder.named.push(n), n),
    get: () => ({
      cloneStep: (stage: any, params: CloneParams, credential?: string) => {
        holder.steps.push(stage.stage);
        session ??= cloneSession(instance, holder.env as Env);
        return session.step(stage, params, credential);
      },
    }),
  };
  const workflows = { create: async (o: any) => ((started = o), { id: o.id }), get: async () => ({ status: async () => ({ status: 'running' }) }) };
  const env = { ...scoped, IMPORT_RUNNERS, PLATFORM_IMPORT: workflows, PACK_CACHE: 'on', PUSH_BUNDLES: 'on', ...extra } as unknown as Env;
  holder.env = env;
  const created = await api('/repos/import', owner, { body: { name, url: URL_OF, policy: { required_checks: [], approvals: 0 } } }, env);
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  const repo = `/repos/${id}`;
  const token = (await api(`${repo}/tokens`, owner, { body: { name: 'reader', scopes: ['read'] } }, env)).body.token as string;
  return { env, owner, repo, id, token, holder, params: started.params as CloneParams };
}

const refsOf = async (repo: string, owner: object, env: Env) =>
  (await api(`${repo}/refs`, owner, {}, env)).body.refs as Record<string, string>;

/** Git's own question to the platform: what are your refs, as `ls-refs` answers. */
async function lsRefs(env: Env, id: string, token: string) {
  const body = `${pkt('command=ls-refs\n')}${pkt('object-format=sha1\n')}0001${pkt('peel\n')}${pkt('symrefs\n')}0000`;
  const answer = await git(env, id, token, body);
  return new TextDecoder().decode(answer);
}

function git(env: Env, id: string, token: string, body: string) {
  return platformFetch(
    new Request(`https://yoneda/git/${id}.git/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token}`)}`, 'git-protocol': 'version=2' },
      body,
    }),
    env,
  ).then(async (r) => new Uint8Array(await r.arrayBuffer()));
}

/** A whole clone of `wants`, read as Git reads it. */
async function cloneOf(env: Env, id: string, token: string, wants: string[]) {
  const lines = [...wants.map((w) => `want ${w}`), 'ofs-delta', 'no-progress', 'done'];
  const body = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${lines.map((l) => pkt(`${l}\n`)).join('')}0000`;
  return asGit(await git(env, id, token, body), true);
}

describe('a repository cloned', () => {
  it('is a normal repository: every branch and tag at its real id, every commit recorded', async () => {
    const h = await history();
    github();
    const box = await container(h.remote);
    const { env, owner, repo, id, token, params, holder } = await asked('whole', box.fake);

    const done = await cloneRepository(env, params, running);

    expect(done).toMatchObject({
      commit: h.merge.id,
      commits: 8,
      refs: 5,
      left_out: 0,
      timing: { start_ms: expect.any(Number), clone_ms: expect.any(Number), usable_ms: expect.any(Number) },
    });
    expect(await refsOf(repo, owner, env)).toEqual({
      'refs/heads/main': h.merge.id,
      'refs/heads/side': h.sideTwo.id,
      'refs/heads/other': h.otherTwo.id,
      'refs/tags/light': h.second.id,
      'refs/tags/v1': h.sideOne.id,
    });
    // An annotated tag keeps its object's id: Git is told it, and what it peels to.
    expect(await lsRefs(env, id, token)).toContain(`${h.tag} refs/tags/v1 peeled:${h.sideOne.id}`);
    // Each branch keeps its full history, diverged or not.
    const log = async (ref: string) => {
      const { body } = await api(`${repo}/log?ref=${ref}&limit=50`, owner, {}, env);
      return (body.commits as { commit: string }[]).map((c) => c.commit);
    };
    expect(await log('main')).toEqual([h.merge.id, h.third.id, h.second.id, h.root.id]);
    expect(await log('other')).toEqual([h.otherTwo.id, h.other.id, h.root.id]);
    expect(await log('side')).toEqual([h.sideTwo.id, h.sideOne.id, h.second.id, h.root.id]);
    // A commit off main's first parents reads like any other, with its files.
    expect((await api(`${repo}/commits/${h.other.id}`, owner, {}, env)).status).toBe(200);
    const read = await api(`${repo}/blob?ref=other&path=other.txt`, owner, {}, env);
    expect(read.status).toBe(200);
    // The instance held the internet alone, the name is the repository's, and it went.
    expect(box.starts[0].startOptions.enableInternet).toBe(true);
    expect(holder.named).toEqual([`clone:${params.repo}`]);
    expect(box.calls.at(-1)).toBe('destroy');
    expect(box.calls.filter((c) => c === 'destroy')).toHaveLength(1);
    expect(box.asks[0]).toEqual({ url: URL_OF, max_pack_bytes: MAX_PACK_BYTES, timeout_seconds: 3600 });
  });

  it('is clonable from its stored pack, and from its objects alone with no pack at all', async () => {
    const h = await history();
    github();
    const box = await container(h.remote);
    const { env, id, token, params } = await asked('clonable', box.fake);
    await cloneRepository(env, params, running);
    const wants = [h.merge.id, h.sideTwo.id, h.otherTwo.id, h.second.id, h.tag];

    const stored = await cloneOf(env, id, token, wants);
    expect(stored).toMatchObject({ error: null, pack: box.bytes.length });

    const off = { ...env, PACK_CACHE: 'off' } as unknown as Env;
    const built = await cloneOf(off, id, token, wants);
    expect(built.error).toBeNull();
    expect(built.pack).toBeGreaterThan(0);
  });

  it('keeps the pack as what later packs start from', async () => {
    const h = await history();
    github();
    const box = await container(h.remote);
    const { env, id, params } = await asked('seed', box.fake);
    await cloneRepository(env, params, running);

    const seed = await seedOf(env, id);
    const tips = h.remote.refs.map((r) => r.id);
    expect(seed).toEqual({ key: await packKey(id, wholeClone(tips)), tips: [...new Set(tips)] });
  });

  it('keeps a default branch of another name under that name, with main beside it', async () => {
    const h = await history();
    h.remote.refs = h.remote.refs.map((r) => (r.ref === 'refs/heads/main' ? { ...r, ref: 'refs/heads/master' } : r));
    github();
    const box = await container(h.remote, { default_branch: 'master' });
    const { env, owner, repo, params } = await asked('master', box.fake);

    await cloneRepository(env, params, running);

    const refs = await refsOf(repo, owner, env);
    expect(refs['refs/heads/master']).toBe(h.merge.id);
    expect(refs['refs/heads/main']).toBe(h.merge.id);
  });

  it('leaves the remote’s own main as main, whatever its default branch', async () => {
    const h = await history();
    h.remote.refs = h.remote.refs.map((r) => (r.ref === 'refs/heads/main' ? { ...r, ref: 'refs/heads/master' } : r));
    h.remote.branch('main', h.other);
    github();
    const box = await container(h.remote, { default_branch: 'master' });
    const { env, owner, repo, params } = await asked('both', box.fake);

    await cloneRepository(env, params, running);

    const refs = await refsOf(repo, owner, env);
    expect(refs['refs/heads/main']).toBe(h.other.id);
    expect(refs['refs/heads/master']).toBe(h.merge.id);
    expect(refs['refs/heads/imported/main']).toBeUndefined();
  });

  it('starts main at the branch asked for, keeps that branch, and moves only the remote’s main aside', async () => {
    const h = await history();
    github();
    const box = await container(h.remote);
    const { env, owner, repo, params } = await asked('named', box.fake);

    await cloneRepository(env, { ...params, branch: 'side' }, running);

    const refs = await refsOf(repo, owner, env);
    expect(refs['refs/heads/main']).toBe(h.sideTwo.id);
    expect(refs['refs/heads/side']).toBe(h.sideTwo.id);
    expect(refs['refs/heads/imported/main']).toBe(h.merge.id);
  });

  it('after a re-import is the same repository again, and takes a commit', async () => {
    const h = await history();
    github();
    const box = await container(h.remote);
    const { env, owner, repo, id, params } = await asked('twice', box.fake);
    await cloneRepository(env, params, running);
    const first = await refsOf(repo, owner, env);
    const created: any[] = [];
    const target = { ...env, PLATFORM_IMPORT: { create: async (o: any) => created.push(o), get: async () => ({ status: async () => ({ status: 'complete' }) }) } } as unknown as Env;

    await reimportRepository(target, 'operator', id, { url: params.url, confirm: true });
    expect(await refsOf(repo, owner, env)).toEqual({});
    await cloneRepository(env, created[0].params, running);

    expect(await refsOf(repo, owner, env)).toEqual(first);
    const commit = await api(`${repo}/commits`, owner, { body: { ref: 'main', message: 'after', author, changes: [file('after.txt', 'yes\n')] } }, env);
    expect(commit.status).toBe(200);
  });

  it('every step repeats harmlessly', async () => {
    const h = await history();
    github();
    const box = await container(h.remote);
    const { env, owner, repo, params } = await asked('repeats', box.fake);
    const twice = {
      do: async <T>(_name: string, _config: unknown, work: () => Promise<T>) => {
        await work();
        return work();
      },
    };

    await cloneRepository(env, params, {
      do: (name, config, work) => (name.startsWith('clone') ? running.do(name, config, work) : twice.do(name, config, work)),
    });

    expect(Object.keys(await refsOf(repo, owner, env))).toHaveLength(5);
    const { body } = await api(`${repo}/log?ref=main&limit=50`, owner, {}, env);
    expect(body.commits).toHaveLength(4);
  });

  it('a step out of time hands on where it stopped, at the end of an object', async () => {
    const h = await history();
    github();
    const box = await container(h.remote, { pieces: 7 });
    const { env, owner, repo, params } = await asked('handson', box.fake);
    const session = cloneSession(box.fake, env);
    await session.step({ stage: 'clone' }, params);
    const real = Date.now;
    let clock = real();
    // Every look at the clock is past the step's end: one object a step.
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 200_000));

    let from: number | null = 0;
    let steps = 0;
    while (from !== null) {
      from = (await session.step({ stage: 'objects', from }, params)) as number | null;
      steps++;
    }

    expect(steps).toBeGreaterThan(10);
    vi.mocked(Date.now).mockRestore();
    await session.step({ stage: 'commits', from: 0 }, params);
    const cloned = await box.fake.containerFetch(new Request('http://check/clone', { method: 'POST', body: '{}', headers: { authorization: 'Bearer x' } })).then((r) => r.json<any>());
    await session.step({ stage: 'refs', cloned }, params);
    expect((await api(`${repo}/blob?ref=main&path=side.txt`, owner, {}, env)).status).toBe(200);
  });

  it('takes a large file whole as an object of its own, frames split anywhere', async () => {
    const filler = new Uint8Array(9 * 1024 * 1024);
    filler.set(crypto.getRandomValues(new Uint8Array(1 << 16)));
    const large = await object('blob', filler);
    const remote = new Remote();
    remote.add(large);
    const root = await remote.commit('root', { 'a.txt': 'one\n' });
    remote.branch('main', root);
    github();
    const box = await container(remote, { pieces: 4099 });
    const { env, params } = await asked('large', box.fake);

    await cloneRepository(env, params, running);

    const stored = await env.OBJECTS.get(`platform/v1/${params.repo}/git/${large.id}`);
    const held = new Uint8Array(await (stored as R2ObjectBody).arrayBuffer());
    expect((await object('blob', held)).id).toBe(large.id);
  }, 60_000);

  it('starts again on a fresh instance when the clone went between steps', async () => {
    const h = await history();
    github();
    const box = await container(h.remote);
    const { env, owner, repo, params } = await asked('lost', box.fake);
    let lost = true;
    const step = {
      do: async <T>(name: string, config: unknown, work: () => Promise<T>) => {
        if (name.startsWith('commits') && lost) {
          lost = false;
          await box.fake.destroy();
          throw new Error('The clone is gone');
        }
        return running.do(name, config, work);
      },
    };

    await cloneRepository(env, params, step);

    expect(box.calls.filter((c) => c === 'start')).toHaveLength(2);
    expect(Object.keys(await refsOf(repo, owner, env))).toHaveLength(5);
  });

  it('leaves out a ref the platform cannot name and keeps the rest, with no stored pack', async () => {
    const h = await history();
    h.remote.refs.push({ ref: 'refs/heads/bad..name', id: h.root.id, commit: h.root.id });
    github();
    const box = await container(h.remote);
    const { env, owner, repo, params } = await asked('leftout', box.fake);

    const done = await cloneRepository(env, params, running);

    expect(done).toMatchObject({ left_out: 1 });
    expect(Object.keys(await refsOf(repo, owner, env))).toHaveLength(5);
    expect(box.calls).not.toContain('/clone/pack');
  });

  it('a stored pack that failed ends nothing', async () => {
    const h = await history();
    github();
    const box = await container(h.remote, { answer: (path) => (path === '/clone/pack' ? new Response('no', { status: 500 }) : null) });
    const { env, owner, repo, params } = await asked('nopack', box.fake);

    await cloneRepository(env, params, running);

    expect(Object.keys(await refsOf(repo, owner, env))).toHaveLength(5);
    expect(box.calls.at(-1)).toBe('destroy');
  });
});

describe('a clone that cannot finish', () => {
  it('refuses a repository past the limit, saying so, with nothing landed and the instance gone', async () => {
    const h = await history();
    github();
    const refusal = { error: { code: 'REPO_TOO_LARGE', message: "This repository's history is over 10.0 GB." } };
    const box = await container(h.remote, { answer: (path) => (path === '/clone' ? Response.json(refusal, { status: 422 }) : null) });
    const { env, owner, repo, params } = await asked('toolarge', box.fake);

    await expect(cloneRepository(env, params, running)).rejects.toThrow(/^REPO_TOO_LARGE: This repository's history is over 10\.0 GB\.$/);

    expect(await refsOf(repo, owner, env)).toEqual({});
    expect(box.calls).toEqual(['start', '/clone', 'destroy']);
  });

  it.each([
    ['the clone fails', '/clone', () => Response.json({ error: { code: 'GIT_FAILED', message: 'no' } }, { status: 422 }), /The clone failed: no/],
    ['it runs out of time', '/clone', () => Response.json({ error: { code: 'TIME_LIMIT', message: 'late' } }, { status: 422 }), /The clone failed: late/],
    ['the image is older than the route', '/clone', () => new Response('not found', { status: 404 }), /The clone failed: 404/],
    ['the objects end early', '/clone/objects', () => new Response(new Uint8Array(30)), /ended early/],
    ['the objects are refused', '/clone/objects', () => new Response('no', { status: 500 }), /answered/],
    ['the commits are refused', '/clone/commits', () => new Response('no', { status: 500 }), /answered/],
    ['the refs are refused', '/clone/refs', () => new Response('no', { status: 500 }), /answered/],
  ])('says why and stops the instance when %s, with no ref moved', async (_what, at, answer, why) => {
    const h = await history();
    github();
    const box = await container(h.remote, { answer: (path) => (path === at ? answer() : null) });
    const { env, owner, repo, params } = await asked(`failed_${at.length}_${String(why).length}`, box.fake);

    await expect(cloneRepository(env, params, running)).rejects.toThrow(why);

    expect(await refsOf(repo, owner, env)).toEqual({});
    expect(box.calls.at(-1)).toBe('destroy');
  });

  it('says so when someone pushed to the repository while it imported, and moves nothing', async () => {
    const h = await history();
    github();
    const box = await container(h.remote);
    const { env, owner, repo, params } = await asked('raced', box.fake);
    const step = {
      do: async <T>(name: string, config: unknown, work: () => Promise<T>) => {
        if (name.startsWith('refs')) {
          const call = caller(env, params.repo, { _system: 'import' });
          await call({ op: 'repo_import', ref: 'main', commit: h.second.id });
        }
        return running.do(name, config, work);
      },
    };

    await expect(cloneRepository(env, params, step)).rejects.toThrow(/changed while it was importing/);

    expect(await refsOf(repo, owner, env)).toEqual({ 'refs/heads/main': h.second.id });
    expect(box.calls.at(-1)).toBe('destroy');
  });

  it('starts no container for a remote that is private or gone', async () => {
    const h = await history();
    github(() => new Response('sign in', { status: 401 }));
    const box = await container(h.remote);
    const { env, params } = await asked('private', box.fake);

    await expect(cloneRepository(env, params, running)).rejects.toThrow(/^REMOTE_AUTH_REQUIRED: /);

    expect(box.calls).toEqual([]);
  });

  it('reports that no instance could start', async () => {
    const h = await history();
    github();
    const box = await container(h.remote, { start: new Error('Maximum number of running container instances exceeded.') });
    const { env, params } = await asked('nostart', box.fake);

    await expect(cloneRepository(env, params, running)).rejects.toThrow(/Maximum number/);

    expect(box.calls).toEqual(['start', 'destroy']);
  });
});

describe('what reaches a clone', () => {
  it('is an https GitHub address alone, refused before anything starts', async () => {
    const box = await container(new Remote());
    const owner = { cookie: await signup('clone_urls') };
    const env = { ...scoped, IMPORT_RUNNERS: { idFromName: () => 'x', get: () => box.fake } } as unknown as Env;
    for (const url of [
      'http://github.com/acme/src.git',
      'git@github.com:acme/src.git',
      'ssh://git@github.com/acme/src.git',
      'file:///etc/passwd',
      'https://user:secret@github.com/acme/src.git',
      'https://github.com:8443/acme/src.git',
      'https://github.com/acme/src.git?x=1',
      'https://github.com/acme/src/tree/main',
      'https://localhost/acme/src.git',
      'https://10.0.0.1/acme/src.git',
      'https://192.168.1.1/acme/src.git',
      'https://169.254.169.254/latest/meta-data',
      'https://[fe80::1]/acme/src.git',
      'https://[::1]/acme/src.git',
      'https://gitlab.com/acme/src.git',
    ]) {
      const refused = await api('/repos/import', owner, { body: { name: 'x', url } }, env);
      expect([url, refused.status]).toEqual([url, 400]);
    }
    expect(box.calls).toEqual([]);
  });

  it('a credential goes by the instance’s environment alone, and only when given', async () => {
    const h = await history();
    github();
    const box = await container(h.remote);
    const { env, params } = await asked('credential', box.fake);

    await cloneRepository(env, params, running, 's3cret');

    expect(box.starts[0].startOptions.envVars.CLONE_CREDENTIAL).toBe('s3cret');
    expect(JSON.stringify(box.asks)).not.toContain('s3cret');
    expect(JSON.stringify(params)).not.toContain('s3cret');
    const clean = await container(h.remote);
    const second = await asked('nocredential', clean.fake);
    await cloneRepository(second.env, second.params, running);
    expect(clean.starts[0].startOptions.envVars.CLONE_CREDENTIAL).toBeUndefined();
  });

  it('a check still starts with no internet', async () => {
    const box = await container(new Remote());
    await startCheck(box.fake);
    expect(box.starts[0].startOptions.enableInternet).toBe(false);
  });
});

describe('the import while it runs', () => {
  it('reads as running with no refs until the last step lands them', async () => {
    const h = await history();
    github();
    const box = await container(h.remote);
    const { env, owner, repo, params } = await asked('progress', box.fake);
    const seen: { refs: number; status: unknown }[] = [];
    const step = {
      do: async <T>(name: string, config: unknown, work: () => Promise<T>) => {
        if (name.startsWith('refs')) {
          const look = await api(`${repo}/import`, owner, {}, env);
          seen.push({ refs: Object.keys(await refsOf(repo, owner, env)).length, status: look.body.status });
        }
        return running.do(name, config, work);
      },
    };

    await cloneRepository(env, params, step);

    expect(seen).toEqual([{ refs: 0, status: 'running' }]);
    expect(Object.keys(await refsOf(repo, owner, env))).toHaveLength(5);
  });

  it('answers the request with no max_commits and no wait', async () => {
    const box = await container(new Remote());
    const { env, params } = await asked('answer', box.fake);
    expect(params).toEqual({ repo: params.repo, url: URL_OF, branch: undefined, asked_at: expect.any(Number) });
    expect(env).toBeDefined();
  });
});
