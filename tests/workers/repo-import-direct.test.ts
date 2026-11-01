// `DIRECT_IMPORT`: a public GitHub repository is fetched by the Worker itself, and main lands
// from that pack beside Artifacts' own fetch. GitHub is a fake serving a real pack of a
// synthetic history; Artifacts a fake that holds the same history once told it has finished.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withWaitUntil } from '../../cloudflare/worker/background';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { githubRemote, remoteHead } from '../../cloudflare/worker/repo-git-remote';
import { stillFilling } from '../../cloudflare/worker/repo-git-mirror';
import { type ImportStep, runImport, startImport } from '../../cloudflare/worker/repo-import';
import { directImport, PACK_BYTES } from '../../cloudflare/worker/repo-import-direct';
import type { Env } from '../../cloudflare/worker/types';
import { asGit } from './git-answer';
import { api, author, fakeArtifacts, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';
import { join, object, type Obj, pack, pkt, text, tree } from './synthetic-pack';

usePlatformFixture();
afterEach(() => {
  (scoped as any).ARTIFACTS = fakeArtifacts;
});

const URL_OF = 'https://github.com/acme/src.git';
const BLOB = '100644';
const WHO = 'A <a@example.com> 1700000000 +0000';

type History = {
  objects: Obj[];
  commits: { hash: string; treeHash: string; parents: string[]; message: string }[];
  trees: Map<string, { name: string; hash: string; type: string; mode: string }[]>;
  head: string;
};

/** `total` commits, each changing `f<n % 20>.txt` in `src/` (`shape` may add what a commit's
 * root tree holds, and how `src/` is spelled there). */
async function history(total: number, shape: (n: number) => { mode?: string; extra?: [string, string, string][] } = () => ({})) {
  const objects: Obj[] = [];
  const seen = new Set<string>();
  const add = (o: Obj) => {
    if (!seen.has(o.id)) objects.push(o);
    seen.add(o.id);
    return o;
  };
  const commits: History['commits'] = [];
  const trees: History['trees'] = new Map();
  const files = new Map<string, string>();
  let parent: string | null = null;
  for (let n = 1; n <= total; n++) {
    const blob = add(await object('blob', text.encode(`version ${n}\n`)));
    files.set(`f${n % 20}.txt`, blob.id);
    const entries = [...files].sort().map(([name, id]): [string, string, string] => [BLOB, name, id]);
    const src = add(await tree(entries));
    trees.set(src.id, entries.map(([mode, name, hash]) => ({ name, hash, type: 'blob', mode })));
    const { mode = '40000', extra = [] } = shape(n);
    const rootEntries = [...extra, [mode, 'src', src.id] as [string, string, string]];
    const root = add(await tree(rootEntries));
    trees.set(root.id, rootEntries.map(([m, name, hash]) => ({ name, hash, type: m.endsWith('40000') ? 'tree' : 'blob', mode: m })));
    const lines = [`tree ${root.id}`, ...(parent ? [`parent ${parent}`] : []), `author ${WHO}`, `committer ${WHO}`, '', `change ${n}`, ''];
    const commit = add(await object('commit', text.encode(lines.join('\n'))));
    commits.push({ hash: commit.id, treeHash: root.id, parents: parent ? [parent] : [], message: `change ${n}\n` });
    parent = commit.id;
  }
  return { objects, commits, trees, head: parent as string };
}

/** What GitHub answers: refs for `ls-refs`, the pack for `fetch` (`alter` may spoil it). */
function github(remote: { head: string; pack: Uint8Array; answer?: (kind: string) => Response | null }) {
  const asked: { url: string; init: RequestInit; kind: string }[] = [];
  const type = { 'content-type': 'application/x-git-upload-pack-result' };
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://github.com/')) return original(input, init);
    const body = String(init?.body ?? '');
    const kind = body.includes('command=ls-refs') ? 'refs' : body.includes('command=fetch') ? 'fetch' : 'other';
    asked.push({ url, init: init ?? {}, kind });
    const held = remote.answer?.(kind);
    if (held) return held;
    if (kind === 'refs') {
      const lines = body.includes('ref-prefix HEAD')
        ? `${remote.head} HEAD symref-target:refs/heads/main\n`
        : `${remote.head} refs/heads/main\n`;
      return new Response(`${pkt(lines)}0000`, { headers: type });
    }
    const packets: Uint8Array[] = [text.encode(pkt('packfile\n'))];
    for (let at = 0; at < remote.pack.length; at += 65515) {
      const piece = remote.pack.subarray(at, at + 65515);
      packets.push(text.encode((piece.length + 5).toString(16).padStart(4, '0')), Uint8Array.of(1), piece);
    }
    packets.push(text.encode('0000'));
    return new Response(join(packets), { headers: type });
  });
  return asked;
}

/** Artifacts: fetching until `done`, then holding `history`. */
function artifacts(history: History, tip = history.head) {
  const at = new Map(history.commits.map((c, i) => [c.hash, i]));
  const counts = { trees: 0, imports: 0 };
  const state = { done: false, refusal: null as Error | null };
  return {
    state,
    counts,
    create: async () => ({}),
    import: async () => {
      counts.imports++;
      if (state.refusal) throw state.refusal;
      return {};
    },
    get: async (name: string) => {
      if (!state.done) throw Object.assign(new Error('importing'), { code: 'IMPORT_IN_PROGRESS' });
      return {
        [Symbol.dispose]() {},
        info: async () => ({ remote: `https://artifacts.test/${name}`, defaultBranch: 'main' }),
        createToken: async () => ({ id: 't', plaintext: 'artifact-token' }),
        readCommit: async (id: string) => history.commits[at.get(id) ?? -1] ?? null,
        readTree: async (id: string) => {
          counts.trees++;
          return history.trees.get(id) ?? null;
        },
        readBlob: async () => null,
        log: async ({ ref, limit = 50, offset = 0 }: any) => {
          const top = at.get(ref) ?? at.get(tip) ?? 0;
          return history.commits.slice(0, top + 1).reverse().slice(offset, offset + limit);
        },
      };
    },
  };
}

const running: ImportStep = {
  async do(_name, _config, callback) {
    return callback();
  },
};

/** An import asked of the platform, nothing of it started yet. */
async function asked(remote: unknown, name: string, max = 5000, extra: object = {}) {
  const owner = { cookie: await signup(`direct_${name}`) };
  (scoped as any).ARTIFACTS = remote;
  let started: any;
  const workflows = { create: async (o: any) => ((started = o), { id: o.id }), get: async () => ({ status: async () => ({ status: 'running' }) }) };
  const env = { ...scoped, ARTIFACTS: remote, PLATFORM_IMPORT: workflows, FAST_IMPORT: 'on', DIRECT_IMPORT: 'on', PACK_CACHE: 'on', PUSH_BUNDLES: 'on', ...extra } as unknown as Env;
  const created = await api('/repos/import', owner, { body: { name, url: URL_OF, branch: 'main', max_commits: max, policy: { required_checks: [], approvals: 0 } } }, env);
  expect(created.status).toBe(200);
  const repo = `/repos/${created.body.id}`;
  const token = (await api(`${repo}/tokens`, owner, { body: { name: 'reader', scopes: ['read'] } }, env)).body.token as string;
  return { env, owner, params: started.params, repo, id: created.body.id as string, token };
}

async function gitFetch(env: Env, id: string, token: string, lines: string[]) {
  const body = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${lines.map((l) => pkt(`${l}\n`)).join('')}0000`;
  const response = await platformFetch(
    new Request(`https://yoneda/git/${id}.git/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token}`)}`, 'git-protocol': 'version=2' },
      body,
    }),
    env,
  );
  const answer = new Uint8Array(await response.arrayBuffer());
  const opening = new TextDecoder('latin1').decode(answer).split('packfile\n')[0];
  return { status: response.status, shallow: [...opening.matchAll(/shallow ([0-9a-f]{40})/g)].map((m) => m[1]), ...asGit(answer, true) };
}

const whole = (head: string) => [`want ${head}`, 'ofs-delta', 'no-progress', 'done'];

async function everything(repo: string, owner: object, env: Env) {
  const ids: string[] = [];
  for (;;) {
    const from = ids.length ? `&from=${ids.at(-1)}` : '';
    const page = await api(`${repo}/log?ref=main&limit=200${from}`, owner, {}, env);
    const commits = (page.body.commits as { commit: string }[]).map((c) => c.commit).slice(ids.length ? 1 : 0);
    if (commits.length === 0) return ids;
    ids.push(...commits);
  }
}

describe('a repository fetched directly', () => {
  it('lands main from the request while Artifacts is still fetching, with a whole clone working', async () => {
    const past = await history(60);
    const bytes = await pack(past.objects);
    const asked_of = github({ head: past.head, pack: bytes });
    const mirror = artifacts(past);
    const { env, owner, params, repo, id, token } = await asked(mirror, 'landed');

    await directImport(env, params);

    const status = await api(repo, owner, {}, env);
    expect(status.body.refs.map((r: any) => r.commit_id)).toEqual([past.head]);
    expect(status.body.history_import).toEqual({ recorded: 1, total: 60 });
    const root = await api(`${repo}/tree?ref=main`, owner, {}, env);
    expect(root.status).toBe(200);
    const inside = await api(`${repo}/tree?ref=main&path=src`, owner, {}, env);
    expect(inside.body.entries.map((e: any) => e.name)).toContain('f0.txt');
    const read = await api(`${repo}/blob?ref=main&path=src/f0.txt`, owner, {}, env);
    expect(read.status).toBe(200);
    expect(mirror.counts.trees).toBe(0);

    // Every commit, whatever is recorded so far, in the pack GitHub sent.
    expect(await gitFetch(env, id, token, whole(past.head))).toMatchObject({ status: 200, error: null, pack: bytes.length });
    // Nothing that needs Artifacts is answered with part of it.
    const land = await api(`${repo}/commits/${past.commits[10].hash}`, owner, {}, env);
    expect([land.status, land.body.error?.message]).toEqual([404, expect.stringMatching(/still importing/)]);

    // No credential travelled, and no redirect would be followed.
    expect(asked_of.map((a) => a.kind)).toEqual(['refs', 'fetch']);
    for (const { url, init } of asked_of) {
      expect(url).toBe(`${URL_OF}/git-upload-pack`);
      expect(init.redirect).toBe('manual');
      const headers = Object.keys(init.headers ?? {}).map((h) => h.toLowerCase());
      expect(headers).not.toContain('authorization');
      expect(headers).not.toContain('cookie');
    }

    mirror.state.done = true;
    const steps: string[] = [];
    const result: any = await runImport(env, params, {
      do: (name, config, work) => (steps.push(name), running.do(name, config, work)),
    });
    expect(steps).toEqual(['import into the object store', 'land the head', 'record history from the pack', 'finish']);
    expect(result).toMatchObject({ commit: past.head, commits: 60 });
    expect(result.stopped).toBeUndefined();
    // Trees came from the pack: Artifacts was asked only for the head's own changes.
    expect(mirror.counts.trees).toBeLessThanOrEqual(4);

    expect(await everything(repo, owner, env)).toEqual(past.commits.map((c) => c.hash).reverse());
    const third = await api(`${repo}/commits/${past.commits[2].hash}`, owner, {}, env);
    expect(third.body.paths.map((p: any) => `${p.op}:${p.path}`)).toEqual(['add:src/f3.txt']);
    const first = await api(`${repo}/commits/${past.commits[0].hash}`, owner, {}, env);
    expect(first.body.paths.map((p: any) => `${p.op}:${p.path}`)).toEqual(['add:src/f1.txt']);
    const after = await api(repo, owner, {}, env);
    expect(after.body.projections[0]).toMatchObject({ status: 'ok' });
    // After history, the same pack answers a clone.
    expect(await gitFetch(env, id, token, whole(past.head))).toMatchObject({ error: null, pack: bytes.length });
  });

  it('serves a clone of any depth or filter from the stored pack, with Artifacts still fetching', async () => {
    const past = await history(5);
    const bytes = await pack(past.objects);
    github({ head: past.head, pack: bytes });
    const mirror = artifacts(past);
    const { env, params, id, token } = await asked(mirror, 'shaped');
    await directImport(env, params);
    // Depth 1 reads as a shallow clone of the head, with the rest of the pack lying unused in
    // it; a deeper one reads as whole, which it is. Neither can be missing anything.
    const shallow = await gitFetch(env, id, token, [`want ${past.head}`, 'deepen 1', 'ofs-delta', 'done']);
    expect(shallow).toMatchObject({ status: 200, error: null, pack: bytes.length, shallow: [past.head] });
    const deeper = await gitFetch(env, id, token, [`want ${past.head}`, 'deepen 3', 'ofs-delta', 'done']);
    expect(deeper).toMatchObject({ status: 200, error: null, pack: bytes.length, shallow: [] });
    const partial = await gitFetch(env, id, token, [`want ${past.head}`, 'filter blob:none', 'ofs-delta', 'done']);
    expect(partial).toMatchObject({ status: 200, error: null, pack: bytes.length });
  });

  it('serves a depth from the stored pack after history too, where the walk cannot', async () => {
    const past = await history(5);
    const bytes = await pack(past.objects);
    github({ head: past.head, pack: bytes });
    const mirror = artifacts(past);
    const { env, params, id, token } = await asked(mirror, 'shapedafter');
    await directImport(env, params);
    mirror.state.done = true;
    await runImport(env, params, running);
    const shallow = await gitFetch(env, id, token, [`want ${past.head}`, 'deepen 1', 'ofs-delta', 'done']);
    expect(shallow).toMatchObject({ status: 200, error: null, pack: bytes.length, shallow: [past.head] });
  });

  it('makes a fetch only Artifacts can serve wait for it, sending nothing before', async () => {
    const past = await history(5);
    github({ head: past.head, pack: await pack(past.objects) });
    const mirror = artifacts(past);
    const { env, params, id, token } = await asked(mirror, 'relative');
    await directImport(env, params);
    const shallowPack = await pack(past.objects.slice(0, 3));
    const original = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.endsWith('/git-upload-pack') || !url.startsWith('https://artifacts.test/'))
        return original(input, init);
      const band = text.encode((shallowPack.length + 5).toString(16).padStart(4, '0'));
      return new Response(
        join([text.encode(`${pkt(`shallow ${past.head}\n`)}0000${pkt('NAK\n')}`), band, Uint8Array.of(1), shallowPack, text.encode('0000')]),
      );
    });
    setTimeout(() => {
      mirror.state.done = true;
    }, 300);
    const relative = await gitFetch(env, id, token, [`want ${past.head}`, 'deepen 1', 'deepen-relative', 'ofs-delta', 'done']);
    expect(relative).toMatchObject({ error: null, pack: shallowPack.length });
  });

  it('says why when a fetch cannot be served, what it waited and that nothing was sent', () => {
    const refused = new Error('still importing (1 of 2283 commits): it takes no changes');
    expect(stillFilling(refused, 40).message).not.toMatch(/waiting/);
    const { code, message } = stillFilling(refused, 20_009);
    expect(code).toBe('IMPORT_IN_PROGRESS');
    expect(message).toMatch(/still importing \(1 of 2283 commits\)/);
    expect(message).toMatch(/after waiting 20 s/);
    expect(message).toMatch(/nothing was sent/i);
    expect(message).toMatch(/try again/i);
  });

  it('stores and serves a pack larger than one multipart part', async () => {
    const past = await history(3);
    const noise = new Uint8Array(6 * 1024 * 1024);
    for (let at = 0; at < noise.length; at += 65536) crypto.getRandomValues(noise.subarray(at, at + 65536));
    past.objects.push(await object('blob', noise));
    const bytes = await pack(past.objects);
    expect(bytes.length).toBeGreaterThan(5 * 1024 * 1024);
    github({ head: past.head, pack: bytes });
    const { env, params, id, token } = await asked(artifacts(past), 'parts');
    await directImport(env, params);
    expect(await gitFetch(env, id, token, whole(past.head))).toMatchObject({ error: null, pack: bytes.length });
  });

  it('keeps the limit the import asked for, and clones still get the whole history', async () => {
    const past = await history(5);
    const bytes = await pack(past.objects);
    github({ head: past.head, pack: bytes });
    const mirror = artifacts(past);
    mirror.state.done = false;
    const { env, owner, params, repo, id, token } = await asked(mirror, 'capped', 2);
    await directImport(env, params);
    expect((await api(repo, owner, {}, env)).body.history_import).toEqual({ recorded: 1, total: 2 });
    mirror.state.done = true;
    await runImport(env, params, running);
    expect(await everything(repo, owner, env)).toEqual([past.commits[4].hash, past.commits[3].hash]);
    const oldest = await api(`${repo}/commits/${past.commits[3].hash}`, owner, {}, env);
    expect(oldest.body.paths.map((p: any) => `${p.op}:${p.path}`)).toEqual(['add:src/f4.txt']);
    expect(await gitFetch(env, id, token, whole(past.head))).toMatchObject({ error: null, pack: bytes.length });
  });

  it('reads old trees as Git does, in history; a head it could not serve takes the other path', async () => {
    // pallets/flask holds five trees with `040000`, which no new tree may have.
    const past = await history(6, (n) => ({ mode: n === 3 ? '040000' : '40000' }));
    github({ head: past.head, pack: await pack(past.objects) });
    const mirror = artifacts(past);
    const { env, owner, params, repo } = await asked(mirror, 'loose');
    await directImport(env, params);
    mirror.state.done = true;
    const steps: string[] = [];
    await runImport(env, params, {
      do: (name, config, work) => (steps.push(name), running.do(name, config, work)),
    });
    expect(steps).toContain('record history from the pack');
    expect(steps.some((name) => name.startsWith('record commits'))).toBe(false);
    expect(await everything(repo, owner, env)).toHaveLength(6);

    const old = await history(3, () => ({ mode: '040000' }));
    github({ head: old.head, pack: await pack(old.objects) });
    const other = artifacts(old);
    const second = await asked(other, 'loosehead');
    expect(await directImport(second.env, second.params)).toBeNull();
    expect((await api(second.repo, second.owner, {}, second.env)).body.refs).toEqual([]);
  });

  it('ends history at a commit too large to record, saying so, as the other path does', async () => {
    const wide: [string, string, string][] = [];
    const blob = await object('blob', text.encode('wide\n'));
    for (let i = 0; i < 10_001; i++) wide.push([BLOB, `w${String(i).padStart(6, '0')}`, blob.id]);
    const dir = await tree(wide);
    const past = await history(6, (n) => ({ extra: n >= 3 ? [['40000', 'many', dir.id]] : [] }));
    past.objects.push(blob, dir);
    past.trees.set(dir.id, wide.map(([mode, name, hash]) => ({ name, hash, type: 'blob', mode })));
    github({ head: past.head, pack: await pack(past.objects) });
    const mirror = artifacts(past);
    const { env, owner, params, repo } = await asked(mirror, 'wide');
    await directImport(env, params);
    mirror.state.done = true;
    const result: any = await runImport(env, params, running);
    expect(result.stopped).toEqual({ recorded: 3, total: 6, reason: 'One commit changes more than 10,000 files.' });
    expect(await everything(repo, owner, env)).toHaveLength(3);
    const land = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('x.txt', 'x\n')], message: 'x', author } }, env);
    expect(land.status).toBe(200);
  });

  it('survives a step repeated after its answer was lost', async () => {
    const past = await history(300);
    github({ head: past.head, pack: await pack(past.objects) });
    const mirror = artifacts(past);
    const { env, owner, params, repo } = await asked(mirror, 'repeat');
    await directImport(env, params);
    mirror.state.done = true;
    await runImport(env, params, {
      async do(_name, _config, work) {
        await work();
        return work();
      },
    });
    expect(await everything(repo, owner, env)).toHaveLength(300);
  });

  it('moves the mirror back to what landed when the remote moved past it', async () => {
    const past = await history(7);
    const landed = past.commits[4].hash;
    const older = await history(5);
    expect(older.head).toBe(landed);
    github({ head: landed, pack: await pack(older.objects) });
    const mirror = artifacts(past);
    const { env, owner, params, repo } = await asked(mirror, 'moved');
    await directImport(env, params);
    mirror.state.done = true;
    const pushed: string[] = [];
    const original = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.endsWith('/git-receive-pack')) return original(input, init);
      const body = new Uint8Array(await new Response(init?.body as ReadableStream).arrayBuffer());
      pushed.push(new TextDecoder('latin1').decode(body.subarray(0, 120)));
      expect(new TextDecoder('latin1').decode(body)).toContain('PACK');
      return new Response(`${pkt(`unpack ok\n`)}${pkt('ok refs/heads/main\n')}0000`, {
        headers: { 'content-type': 'application/x-git-receive-pack-result' },
      });
    });
    const result: any = await runImport(env, params, running);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain(`${past.head} ${landed} refs/heads/main`);
    expect(result).toMatchObject({ commit: landed, commits: 5 });
    const status = await api(repo, owner, {}, env);
    expect(status.body.refs.map((r: any) => r.commit_id)).toEqual([landed]);
    expect(status.body.projections[0]).toMatchObject({ status: 'ok' });
    expect(await everything(repo, owner, env)).toHaveLength(5);
  });

  it('ends history at the head when the mirror will not go back, leaving the repository usable', async () => {
    const past = await history(7);
    const landed = past.commits[4].hash;
    github({ head: landed, pack: await pack((await history(5)).objects) });
    const mirror = artifacts(past);
    const { env, owner, params, repo } = await asked(mirror, 'stuck');
    await directImport(env, params);
    mirror.state.done = true;
    const original = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.endsWith('/git-receive-pack')) return original(input, init);
      await new Response(init?.body as ReadableStream).arrayBuffer();
      return new Response(`${pkt('unpack ok\n')}${pkt('ng refs/heads/main non-fast-forward\n')}0000`);
    });
    await expect(runImport(env, params, running)).rejects.toThrow(/refused main/);
    const status = await api(repo, owner, {}, env);
    expect(status.body.refs.map((r: any) => r.commit_id)).toEqual([landed]);
    expect(status.body.history_import).toBeNull();
    expect(status.body.history_stopped).toMatchObject({ recorded: 1, total: 5 });
  });

  it('ends history at the head when Artifacts refuses for good, leaving the repository usable', async () => {
    const past = await history(9);
    github({ head: past.head, pack: await pack(past.objects) });
    const mirror = artifacts(past);
    const { env, owner, params, repo } = await asked(mirror, 'refused');
    await directImport(env, params);
    mirror.state.refusal = Object.assign(new Error('too big'), { code: 'MEMORY_LIMIT' });
    await expect(runImport(env, params, running)).rejects.toThrow(/MEMORY_LIMIT/);
    const status = await api(repo, owner, {}, env);
    expect(status.body.history_import).toBeNull();
    expect(status.body.history_stopped).toMatchObject({ recorded: 1, total: 9 });
  });
});

describe('from the request', () => {
  it('races Artifacts to main, and keeps the timing of whichever landed', async () => {
    const past = await history(8);
    github({ head: past.head, pack: await pack(past.objects) });
    const mirror = artifacts(past);
    const { env, owner, params, repo, id } = await asked(mirror, 'raced');
    const running = startImport(env, params);
    for (;;) {
      if ((await api(repo, owner, {}, env)).body.refs.length > 0) break;
    }
    mirror.state.done = true;
    await running;
    const noted = await (await env.OBJECTS.get(`platform/v1/${id}/import-head.json`))?.json<any>();
    expect(noted.landed_by).toBe('direct');
    expect((await api(repo, owner, {}, env)).body.projections[0]).toMatchObject({ status: 'ok' });
  });

  it('lands from Artifacts when the fetch is declined', async () => {
    const past = await history(8);
    github({ head: past.head, pack: new Uint8Array(), answer: () => new Response('no', { status: 401 }) });
    const mirror = artifacts(past);
    mirror.state.done = true;
    const { env, owner, params, repo, id } = await asked(mirror, 'declined');
    await startImport(env, params);
    const noted = await (await env.OBJECTS.get(`platform/v1/${id}/import-head.json`))?.json<any>();
    expect(noted.landed_by).toBe('request');
    expect((await api(repo, owner, {}, env)).body.refs.map((r: any) => r.commit_id)).toEqual([past.head]);
  });
});

describe('the stored pack beside landing', () => {
  /** `env` whose list of recent packs is written only once `released`. */
  function heldList(env: Env, released: Promise<unknown>) {
    const held = env.OBJECTS;
    const OBJECTS = new Proxy(held, {
      get(target, key) {
        if (key === 'put')
          return async (name: string, ...rest: [never, never]) => {
            if (name.endsWith('/recent')) await released;
            return target.put(name, ...rest);
          };
        const value = (target as any)[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { ...env, OBJECTS } as Env;
  }

  it('lands without waiting to list the pack, which a clone can already read', async () => {
    const past = await history(4);
    const bytes = await pack(past.objects);
    github({ head: past.head, pack: bytes });
    const { env, owner, params, repo, id, token } = await asked(artifacts(past), 'listed');
    let release = () => {};
    const held = heldList(env, new Promise<void>((done) => (release = done)));
    const landing = directImport(held, params);
    while ((await api(repo, owner, {}, env)).body.refs.length === 0);
    expect(await gitFetch(env, id, token, whole(past.head))).toMatchObject({ error: null, pack: bytes.length });
    release();
    expect(await landing).toMatchObject({ landed_by: 'direct' });
    expect(await env.OBJECTS.get(`derived/v1/${id}/packs/v2/recent`)).not.toBeNull();
  });

  it('keeps main when the list cannot be written', async () => {
    const past = await history(4);
    github({ head: past.head, pack: await pack(past.objects) });
    const { env, owner, params, repo } = await asked(artifacts(past), 'unlisted');
    const refusal = Promise.reject(new Error('no'));
    refusal.catch(() => {});
    const failing = heldList(env, refusal);
    expect(await directImport(failing, params)).toMatchObject({ landed_by: 'direct' });
    expect((await api(repo, owner, {}, env)).body.refs.map((r: any) => r.commit_id)).toEqual([past.head]);
  });
});

describe('the answer to an import', () => {
  const body = { name: 'answered', url: URL_OF, branch: 'main', max_commits: 50 };
  const unknown = () => {
    throw new Error('instance.not_found');
  };
  async function answered(workflows: object, name: string, extra: object = {}) {
    const past = await history(3);
    github({ head: past.head, pack: await pack(past.objects) });
    const mirror = artifacts(past);
    mirror.state.done = true;
    const owner = { cookie: await signup(`answer_${name}`) };
    (scoped as any).ARTIFACTS = mirror;
    const env = { ...scoped, ARTIFACTS: mirror, PLATFORM_IMPORT: workflows, FAST_IMPORT: 'on', DIRECT_IMPORT: 'on', PACK_CACHE: 'on', PUSH_BUNDLES: 'on', ...extra } as unknown as Env;
    const work: Promise<unknown>[] = [];
    const created = await withWaitUntil(
      (w) => work.push(w),
      () => api('/repos/import', owner, { body: { ...body, name } }, env),
    );
    expect(created.status).toBe(200);
    return { env, owner, past, work, repo: `/repos/${created.body.id}`, id: created.body.id as string };
  }

  it('does not wait for the Workflow, and meanwhile an import reads as on its way', async () => {
    const asked_for: any[] = [];
    let release = (_: unknown) => {};
    const held = new Promise((done) => (release = done));
    const workflows = { create: (o: any) => (asked_for.push(o), held), get: unknown };
    const { env, owner, repo, work } = await answered(workflows, 'waiting');
    expect(asked_for).toHaveLength(1);
    const look = await api(`${repo}/import`, owner, {}, env);
    expect([look.status, look.body.status]).toEqual([200, 'queued']);
    release({ id: 'x' });
    await Promise.all(work);
  });

  it('starts the Workflow from a look at the import when the request could not', async () => {
    const asked_for: any[] = [];
    const workflows = {
      create: async (o: any) => {
        asked_for.push(o);
        if (asked_for.length === 1) throw new Error('workflows are down');
        return { id: o.id };
      },
      get: unknown,
    };
    const { env, owner, repo, id, work } = await answered(workflows, 'restarted');
    await Promise.all(work);
    // Within the time the request's own create has, a look leaves that to finish.
    expect((await api(`${repo}/import`, owner, {}, env)).body.status).toBe('queued');
    expect(asked_for).toHaveLength(1);
    const kept = await (await env.OBJECTS.get(`platform/v1/${id}/import-asked.json`))?.json<any>();
    await env.OBJECTS.put(`platform/v1/${id}/import-asked.json`, JSON.stringify({ ...kept, asked_at: Date.now() - 60_000 }));
    expect((await api(`${repo}/import`, owner, {}, env)).body.status).toBe('queued');
    expect(asked_for).toHaveLength(2);
    expect(asked_for[1].id).toBe(asked_for[0].id);
    expect(asked_for[1].params.url).toBe(asked_for[0].params.url);
  });

  it('takes a Workflow that already exists as started', async () => {
    const workflows = {
      create: async () => {
        throw new Error('instance.already_exists');
      },
      get: unknown,
    };
    const { env, owner, repo, work } = await answered(workflows, 'existing');
    await Promise.all(work);
    expect((await api(`${repo}/import`, owner, {}, env)).status).toBe(200);
  });

  it('waits for the Workflow when what would start it later cannot be kept', async () => {
    const created: any[] = [];
    const workflows = { create: async (o: any) => (created.push(o), { id: o.id }), get: unknown };
    const lost = new Proxy(scoped.OBJECTS, {
      get(target, key) {
        if (key === 'put')
          return async (name: string, ...rest: [never, never]) => {
            if (name.endsWith('/import-asked.json')) throw new Error('R2 is down');
            return target.put(name, ...rest);
          };
        const value = (target as any)[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { work } = await answered(workflows, 'nonote', { OBJECTS: lost });
    expect(created).toHaveLength(1);
    await Promise.all(work);
  });

  it('never makes a page wait on a slow Workflow, and a repository never imported still has no import', async () => {
    const workflows = { create: async (o: any) => ({ id: o.id }), get: async () => ({ status: () => new Promise(() => {}) }) };
    const { env, owner, repo, work } = await answered(workflows, 'slowstatus');
    await Promise.all(work);
    const look = await api(`${repo}/import`, owner, {}, env);
    expect([look.status, look.body.status]).toEqual([200, 'running']);

    const plain = await api('/repos', owner, { body: { name: 'plain', files: [file('a.txt', 'a\n')], message: 'a', author } }, env);
    const empty = { ...env, PLATFORM_IMPORT: { get: unknown } } as unknown as Env;
    expect((await api(`/repos/${plain.body.id}/import`, owner, {}, empty)).status).toBe(404);
  });
});

describe('falling back', () => {
  const type = { 'content-type': 'application/x-git-upload-pack-result' };
  const spoiled: [string, (head: string, bytes: Uint8Array) => { head?: string; pack?: Uint8Array; answer?: (kind: string) => Response | null }][] = [
    ['a redirect', () => ({ answer: () => new Response(null, { status: 301, headers: { location: 'https://evil.example/x.git' } }) })],
    ['a sign-in', () => ({ answer: () => new Response('no', { status: 401 }) })],
    ['a body that is no Git answer', () => ({ answer: () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) })],
    ['an outage', () => ({ answer: () => { throw new Error('down'); } })],
    ['a pack cut short', (_h, bytes) => ({ pack: bytes.subarray(0, bytes.length - 40) })],
    ['a corrupt pack', (_h, bytes) => { const bad = bytes.slice(); bad[bad.length - 30] ^= 1; return { pack: bad }; }],
    ['a pack of the wrong history', (_h, bytes) => ({ head: 'a'.repeat(40), pack: bytes })],
    ['a remote with no such ref', () => ({ answer: (kind) => (kind === 'refs' ? new Response('0000', { headers: type }) : null) })],
    ['too many objects', (_h, bytes) => { const many = bytes.slice(); many.set([0, 1, 0, 0], 8); return { pack: many }; }],
  ];

  it.each(spoiled)('imports through Artifacts after %s, with all of history', async (name, spoil) => {
    const past = await history(30);
    const bytes = await pack(past.objects);
    github({ head: past.head, pack: bytes, ...spoil(past.head, bytes) });
    const mirror = artifacts(past);
    const { env, owner, params, repo, id } = await asked(mirror, name.replace(/\W/g, '').slice(0, 20));
    expect(await directImport(env, params)).toBeNull();
    expect((await api(repo, owner, {}, env)).body.refs).toEqual([]);
    const held = await env.OBJECTS.list({ prefix: `derived/v1/${id}/packs/` });
    expect(held.objects).toHaveLength(0);
    mirror.state.done = true;
    const result: any = await runImport(env, params, running);
    expect(result).toMatchObject({ commit: past.head, commits: 30, timing: { landed_by: 'workflow' } });
    expect(await everything(repo, owner, env)).toHaveLength(30);
  });

  it('stops reading a pack over the limit', async () => {
    const past = await history(3);
    const large = await object('blob', crypto.getRandomValues(new Uint8Array(65536)));
    const filler = new Uint8Array(PACK_BYTES + 1024);
    for (let at = 0; at < filler.length; at += 65536) filler.set(large.data.subarray(0, filler.length - at), at);
    past.objects.push(await object('blob', filler));
    github({ head: past.head, pack: await pack(past.objects) });
    const { env, owner, params, repo } = await asked(artifacts(past), 'overlimit');
    expect(await directImport(env, params)).toBeNull();
    expect((await api(repo, owner, {}, env)).body.refs).toEqual([]);
  });

  it('leaves main alone when the other path landed first', async () => {
    const past = await history(4);
    github({ head: past.head, pack: await pack(past.objects) });
    const mirror = artifacts(past);
    mirror.state.done = true;
    const { env, owner, params, repo } = await asked(mirror, 'lost');
    await runImport(env, params, running);
    expect(await directImport(env, params)).toBeNull();
    expect((await api(repo, owner, {}, env)).body.refs.map((r: any) => r.commit_id)).toEqual([past.head]);
  });

  it('touches nothing of GitHub with the switch off, or for any other host', async () => {
    const past = await history(3);
    const mirror = artifacts(past);
    mirror.state.done = true;
    const asked_of = github({ head: past.head, pack: await pack(past.objects) });
    const off = await asked(mirror, 'off', 5000, { DIRECT_IMPORT: 'off' });
    await startImport(off.env, off.params);
    expect(asked_of).toHaveLength(0);
    const other = await asked(artifacts(past), 'host');
    expect(await directImport(other.env, { ...other.params, url: 'https://gitlab.com/acme/src.git' })).toBeNull();
    expect(asked_of).toHaveLength(0);
  });
});

describe('the remote address', () => {
  it.each([
    ['https://github.com/acme/src', URL_OF],
    ['https://github.com/acme/src.git', URL_OF],
    ['https://github.com/acme/src/', URL_OF],
    ['https://github.com/a-b/c.d_e', 'https://github.com/a-b/c.d_e.git'],
  ])('takes %s', (url, remote) => {
    expect(githubRemote(url)).toBe(remote);
  });

  it.each([
    'http://github.com/acme/src',
    'https://github.com.evil.example/acme/src',
    'https://evil.example/github.com/acme/src',
    'https://user:secret@github.com/acme/src',
    'https://github.com:8443/acme/src',
    'https://github.com/acme/src?x=1',
    'https://github.com/acme/src#x',
    'https://github.com/acme/src/extra',
    'https://github.com/acme/..',
    'https://github.com/acme/.git',
    'https://github.com/../src',
    'https://GITHUB.com/acme/src',
    'https://github.com/acme/src\n',
  ])('refuses %s', (url) => {
    expect(githubRemote(url)).toBeNull();
  });

  it('never puts an unusual branch name on the wire', async () => {
    const asked_of = github({ head: 'a'.repeat(40), pack: new Uint8Array() });
    const signal = AbortSignal.timeout(1000);
    await expect(remoteHead(URL_OF, 'main\n0000command=fetch', signal)).rejects.toThrow(/Unusual/);
    expect(asked_of).toHaveLength(0);
  });
});
