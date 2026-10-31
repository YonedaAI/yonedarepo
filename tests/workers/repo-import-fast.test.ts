// `FAST_IMPORT`: main lands at the remote's head as soon as Artifacts has it, and history
// fills in behind it, newest first. Artifacts is a fake with a synthetic first-parent chain
// (no real Git objects: the chain's ids and trees are made up), so counts are exact.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { type ImportStep, runImport } from '../../cloudflare/worker/repo-import';
import { gitObjectId } from '../../cloudflare/worker/repo-objects';
import type { Env } from '../../cloudflare/worker/types';
import { asGit } from './git-answer';
import { api, author, bindings, fakeArtifacts, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
// The published head's holder reads through `scoped`.
afterEach(() => {
  (scoped as any).ARTIFACTS = fakeArtifacts;
});

const hex = (kind: string, n: number) => kind + n.toString(16).padStart(39, '0');
const FILE = (commit: number, name: string) => hex('b', commit * 7919 + name.length);

type Entry = { name: string; hash: string; type: string; mode: string };
const entry = (name: string, hash: string, type: string): Entry => ({ name, hash, type, mode: type === 'tree' ? '40000' : '100644' });

/** A tree's id, as compute checks every tree it is given. */
async function treeId(entries: Entry[]) {
  const parts: number[] = [];
  const sorted = [...entries].sort((a, b) => (a.name + (a.type === 'tree' ? '/' : '') < b.name + (b.type === 'tree' ? '/' : '') ? -1 : 1));
  for (const e of sorted) {
    parts.push(...new TextEncoder().encode(`${e.mode} ${e.name}\0`));
    for (let i = 0; i < 40; i += 2) parts.push(Number.parseInt(e.hash.slice(i, i + 2), 16));
  }
  return gitObjectId('tree', new Uint8Array(parts));
}

/** Commit `n` (1 is the oldest) of a chain where each changes `src/lib/mod<n % 40>.txt`
 * plus `extra(n)` files of a directory of its own. */
async function chain(total: number, extra: (n: number) => number = () => 0, truncatedAt = 0) {
  const trees = new Map<string, Entry[]>();
  const put = async (entries: Entry[]) => {
    const id = await treeId(entries);
    trees.set(id, entries);
    return id;
  };
  let mods = new Map<string, string>();
  const commits: any[] = [];
  for (let n = 1; n <= total; n++) {
    mods = new Map(mods).set(`mod${n % 40}.txt`, FILE(n, 'mod'));
    const lib = await put([...mods].sort().map(([name, id]) => entry(name, id, 'blob')));
    const src = await put([entry('lib', lib, 'tree')]);
    const files = Array.from({ length: extra(n) }, (_, i) => entry(`f${i}.txt`, FILE(n, `f${i}`), 'blob'));
    const own = files.length ? [entry(`own${n}`, await put(files), 'tree')] : [];
    const root = await put([...own, entry('readme.md', hex('b', 0), 'blob'), entry('src', src, 'tree')]);
    commits.push({
      hash: hex('c', n),
      treeHash: root,
      parents: n > 1 ? [hex('c', n - 1)] : truncatedAt ? [hex('c', 99_999)] : [],
      message: `change ${n}`,
      author,
      committer: author,
      authoredAt: 0,
      committedAt: 0,
    });
  }
  return { commits, trees, head: hex('c', total) };
}

function remoteOf({ commits, trees }: Awaited<ReturnType<typeof chain>>, delayMs = 0) {
  const counts = { get: 0, log: 0, tree: 0, commit: 0 };
  const byHash = new Map(commits.map((c, i) => [c.hash, i]));
  const wait = () => (delayMs ? new Promise((done) => setTimeout(done, delayMs)) : Promise.resolve());
  let busy = 1;
  return {
    counts,
    create: async () => ({}),
    import: async () => ({}),
    get: async (name: string) => {
      counts.get++;
      if (busy-- > 0) throw Object.assign(new Error('importing'), { code: 'IMPORT_IN_PROGRESS' });
      return {
        [Symbol.dispose]() {},
        info: async () => ({ remote: `https://artifacts.test/${name}`, defaultBranch: 'main' }),
        createToken: async () => ({ id: 't', plaintext: 'artifact-read-token' }),
        readCommit: async (id: string) => {
          counts.commit++;
          const at = byHash.get(id);
          return at === undefined ? null : commits[at];
        },
        readTree: async (id: string) => {
          counts.tree++;
          await wait();
          return trees.get(id) ?? null;
        },
        log: async ({ ref, limit = 50, offset = 0 }: any) => {
          counts.log++;
          await wait();
          const top = byHash.get(ref) ?? commits.length - 1;
          return commits.slice(0, top + 1).reverse().slice(offset, offset + limit);
        },
      };
    },
  };
}

/** Runs steps directly and lets a test look between them. */
function stepper(after?: (name: string) => Promise<void>) {
  const steps: string[] = [];
  const step: ImportStep = {
    async do(name, _config, callback) {
      steps.push(name);
      const value = await callback();
      await after?.(name);
      return value;
    },
  };
  return { steps, step };
}

async function imported(remote: unknown, name: string, max = 5000, branch = 'main') {
  const owner = { cookie: await signup(`fast_${name}`) };
  (scoped as any).ARTIFACTS = remote;
  let started: any;
  const workflows = {
    create: async (options: any) => ((started = options), { id: options.id }),
    get: async () => ({ status: async () => ({ status: 'running' }) }),
  };
  const env = { ...scoped, ARTIFACTS: remote, PLATFORM_IMPORT: workflows, FAST_IMPORT: 'on' } as unknown as Env;
  const created = await api('/repos/import', owner, { body: { name, url: 'https://git.example/src.git', branch, max_commits: max } }, env);
  expect(created.status).toBe(200);
  return { env, owner, params: started.params, repo: `/repos/${created.body.id}`, id: created.body.id };
}

it('lands the head at once, then fills history in behind it, reading as partial until it ends', async () => {
  const history = await chain(600);
  const remote = remoteOf(history);
  const { env, owner, params, repo } = await imported(remote, 'partial');
  queued.length = 0;
  const looks: any[] = [];
  const { steps, step } = stepper(async (name) => {
    if (name === 'import into the object store') return;
    const status = await api(repo, owner, {}, env);
    const log = await api(`${repo}/log?ref=main&limit=5`, owner, {}, env);
    looks.push({ name, fill: status.body.history_import, refs: status.body.refs, log: log.body });
    if (name !== 'land the head') return;
    // The moment the head has landed: main is there, its projection asked for, and what
    // needs all of history waits, saying why.
    // Imported as main, the store already has it (any other branch: see below).
    const main = (await api(repo, owner, {}, env)).body.projections[0];
    expect(main.status).toBe('ok');
    expect(queued.filter((m) => m.kind === 'platform_project')).toHaveLength(0);
    // A commit may record beside the head; it lands only once history is whole.
    const commit = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('x.txt', 'x\n')], message: 'x', author } }, env);
    expect(commit.status).toBe(200);
    const land = await api(`${repo}/land`, owner, { body: { ref: 'main', commit: commit.body.commit } }, env);
    expect([land.status, land.body.error?.code]).toEqual([409, 'IMPORT_IN_PROGRESS']);
    expect(land.body.error.message).toMatch(/still importing \(1 of 600 commits\)/);
    const fork = await api(`${repo}/fork`, owner, { body: { name: 'copy' } }, env);
    expect(fork.body.error?.code).toBe('IMPORT_IN_PROGRESS');
    const old = await api(`${repo}/commits/${hex('c', 2)}`, owner, {}, env);
    expect([old.status, old.body.error?.message]).toEqual([404, expect.stringMatching(/still importing/)]);
  });
  const result = await runImport(env, params, step);

  expect(result).toMatchObject({ commit: history.head, commits: 600, version: 1 });
  expect(steps).toEqual(['import into the object store', 'land the head', 'record commits below 600', 'record commits below 350', 'record commits below 100', 'finish']);
  const [head, ...waves] = looks;
  expect(head.refs.map((r: any) => r.commit_id)).toEqual([history.head]);
  expect(head.fill).toEqual({ recorded: 1, total: 600 });
  expect(head.log.history_import).toEqual({ recorded: 1, total: 600 });
  expect(head.log.commits.map((c: any) => c.commit)).toEqual([history.head]);
  expect(waves.map((w) => w.fill)).toEqual([{ recorded: 251, total: 600 }, { recorded: 501, total: 600 }, null, null]);
  expect(waves[0].log.commits.map((c: any) => c.commit)).toEqual([600, 599, 598, 597, 596].map((n) => hex('c', n)));

  const done = await api(`${repo}/log?ref=main&limit=200`, owner, {}, env);
  expect(done.body.history_import).toBeUndefined();
  const touched = await api(`${repo}/commits/${hex('c', 3)}`, owner, {}, env);
  expect(touched.body.paths.map((p: any) => `${p.op}:${p.path}`)).toEqual(['add:src/lib/mod3.txt']);
  const first = await api(`${repo}/commits/${hex('c', 1)}`, owner, {}, env);
  expect(first.body.paths.map((p: any) => `${p.op}:${p.path}`)).toEqual(['add:readme.md', 'add:src/lib/mod1.txt']);
  const paths = await api(`${repo}/log?ref=main&path=src/lib/mod3.txt&limit=100`, owner, {}, env);
  expect(paths.body.commits).toHaveLength(15);
  const after = await api(`${repo}/import`, owner, {}, env);
  expect(after.body.history ?? null).toBeNull();
});

it('asks for main to be projected at once when the remote calls it something else', async () => {
  const { env, params } = await imported(remoteOf(await chain(3)), 'named', 5000, 'master');
  queued.length = 0;
  const { step } = stepper(async (name) => {
    if (name === 'land the head') expect(queued.filter((m) => m.kind === 'platform_project')).toHaveLength(1);
  });
  await runImport(env, params, step);
});

it('reads each new tree once, from the store alone, and writes no copies of them', async () => {
  const history = await chain(300);
  const remote = remoteOf(history);
  const { env, params, id } = await imported(remote, 'counts');
  const { step } = stepper();
  await runImport(env, params, step);
  const puts = await bindings.OBJECTS.list({ prefix: `platform/v1/${id}/objects/` });
  expect(puts.objects).toHaveLength(0);
  // Two trees change per commit (the root, src, lib: three), each read once, and a wave's
  // last commit's parent's are read again by the next: 900 plus what waves share.
  expect(remote.counts.tree).toBeLessThanOrEqual(300 * 3 + 2 * 3);
  // One log per wave and one for the head, and one store handle for each.
  expect(remote.counts.log).toBeLessThanOrEqual(4);
  expect(remote.counts.get).toBeLessThanOrEqual(6);
  expect(remote.counts.commit).toBe(0);
});

it('survives a crash after a wave committed, and again before it did', async () => {
  const history = await chain(300);
  const remote = remoteOf(history);
  const { env, owner, params, repo } = await imported(remote, 'crash');
  let crashes = 0;
  const step: ImportStep = {
    async do(name, _config, callback) {
      for (;;)
        try {
          const value = await callback();
          // The step's answer lost after the transaction committed.
          if (name.startsWith('record') && crashes++ % 2 === 0) throw new Error('lost');
          return value;
        } catch (e: any) {
          if (e.message !== 'lost') throw e;
        }
    },
  };
  await runImport(env, params, step);
  const log = await api(`${repo}/log?ref=main&limit=200`, owner, {}, env);
  expect(log.body.commits).toHaveLength(200);
  expect(log.body.history_import).toBeUndefined();
  const commits = await api(`${repo}/commits/${hex('c', 1)}`, owner, {}, env);
  expect(commits.status).toBe(200);
});

it('keeps a commit of 9,000 changed paths, past what one SQL parameter holds', async () => {
  const history = await chain(4, (n) => (n === 2 ? 9000 : 0));
  const remote = remoteOf(history);
  const { env, owner, params, repo } = await imported(remote, 'wide');
  const { step } = stepper();
  await runImport(env, params, step);
  const shown = await api(`${repo}/commits/${hex('c', 2)}`, owner, {}, env);
  expect(shown.status).toBe(200);
  expect(shown.body.paths.length).toBe(9001);
});

it('stops a truncated import at its boundary, complete', async () => {
  const history = await chain(5, undefined, 1);
  const remote = remoteOf(history);
  const { env, owner, params, repo } = await imported(remote, 'truncated', 3);
  const { step } = stepper();
  const result = await runImport(env, params, step);
  expect(result).toMatchObject({ commits: 3 });
  const log = await api(`${repo}/log?ref=main`, owner, {}, env);
  expect(log.body.commits.map((c: any) => c.commit)).toEqual([5, 4, 3].map((n) => hex('c', n)));
  expect(log.body.history_import).toBeUndefined();
  // The oldest kept commit's changes are against its real parent, as in the slow path.
  const oldest = await api(`${repo}/commits/${hex('c', 3)}`, owner, {}, env);
  expect(oldest.body.paths.map((p: any) => p.path)).toEqual(['src/lib/mod3.txt']);
});

it('fails a commit no retry can record at once', async () => {
  const history = await chain(3, (n) => (n === 2 ? 10_001 : 0));
  const remote = remoteOf(history);
  const { env, params } = await imported(remote, 'huge');
  const { step } = stepper();
  await expect(runImport(env, params, step)).rejects.toMatchObject({ name: 'NonRetryableError', message: expect.stringMatching(/^TOO_LARGE: /) });
});

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
const PACK = new TextEncoder().encode(`PACK${'x'.repeat(5000)}`);

/** The fake mirror's Git: `refs` advertised, and `PACK` for any fetch, in pieces. */
function serveMirror(refs: Record<string, string>) {
  const asked: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/info/refs')) {
      const lines = Object.entries(refs).map(([ref, id], i) => pkt(`${id} ${ref}${i ? '' : '\0side-band-64k ofs-delta'}\n`));
      return new Response(`${pkt('# service=git-upload-pack\n')}0000${lines.join('')}0000`);
    }
    asked.push(new TextDecoder().decode(new Uint8Array(await new Response(init?.body).arrayBuffer())));
    const parts: Uint8Array[] = [new TextEncoder().encode(pkt('NAK\n'))];
    for (let i = 0; i < PACK.length; i += 1000) {
      const piece = PACK.subarray(i, i + 1000);
      parts.push(new TextEncoder().encode((piece.length + 5).toString(16).padStart(4, '0')), Uint8Array.of(1), piece);
    }
    parts.push(new TextEncoder().encode('0000'));
    return new Response(new Blob(parts));
  });
  return { asked, restore: () => spy.mockRestore() };
}

async function gitFetch(env: Env, id: string, token: string, lines: string[], v2 = true) {
  const body = v2
    ? `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${lines.map((l) => pkt(`${l}\n`)).join('')}0000`
    : `${lines.map((l, i) => pkt(`${l}${i ? '' : ' side-band-64k ofs-delta'}\n`)).join('')}0000${pkt('done\n')}`;
  const response = await platformFetch(
    new Request(`https://yoneda/git/${id}.git/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token}`)}`, ...(v2 ? { 'git-protocol': 'version=2' } : {}) },
      body,
    }),
    env,
  );
  expect(response.status).toBe(200);
  return asGit(new Uint8Array(await response.arrayBuffer()), v2);
}

describe('a clone as soon as main lands', () => {
  /** An import stopped the moment its head landed (`whole`: run to its end). */
  async function landed(name: string, whole = false) {
    const history = await chain(30);
    const { env, owner, params, id, repo } = await imported(remoteOf(history), name);
    const token = (await api(`${repo}/tokens`, owner, { body: { name: 'reader', scopes: ['read'] } }, env)).body.token as string;
    const stop = new Error('stop');
    const { step } = stepper(async (done) => {
      if (done === 'land the head' && !whole) throw stop;
    });
    await runImport(env, params, step).catch((e) => {
      if (e !== stop) throw e;
    });
    return { env, id, repo, owner, token, head: history.head };
  }

  it('sends the mirror\'s pack, over either protocol, while history is still arriving', async () => {
    const { env, id, head, token } = await landed('mirror_clone');
    const mirror = serveMirror({ 'refs/heads/master': head, [`refs/yoneda/c/${hex('c', 7)}`]: hex('c', 7) });
    const v2 = await gitFetch(env, id, token, [`want ${head}`, 'thin-pack', 'ofs-delta', 'done']);
    expect(v2).toMatchObject({ error: null, badBand: null, pack: PACK.length });
    const v0 = await gitFetch(env, id, token, [`want ${head}`], false);
    expect(v0).toMatchObject({ error: null, badBand: null, pack: PACK.length });
    expect(mirror.asked).toHaveLength(2);
    expect(mirror.asked[0]).toContain(`want ${head}`);
    mirror.restore();
  });

  it('sends it after the history is in as well, in place of refusing', async () => {
    const { env, id, head, token } = await landed('mirror_after', true);
    const mirror = serveMirror({ 'refs/heads/main': head });
    expect(await gitFetch(env, id, token, [`want ${head}`, 'done'])).toMatchObject({ error: null, pack: PACK.length });
    mirror.restore();
  });

  it('never takes the mirror\'s word for what a reader may fetch', async () => {
    const { env, id, head, repo, owner, token } = await landed('mirror_refused');
    const hidden = hex('c', 7);
    const mirror = serveMirror({ 'refs/heads/main': head, [`refs/yoneda/c/${hidden}`]: hidden });
    // A commit the mirror holds and no branch or tag reaches.
    expect((await gitFetch(env, id, token, [`want ${hidden}`, 'done'])).error).toMatch(/^IMPORT_IN_PROGRESS/);
    // A depth is not sent on, and an incremental fetch is not a clone.
    expect((await gitFetch(env, id, token, [`want ${head}`, 'deepen 1', 'done'])).error).toMatch(/^IMPORT_IN_PROGRESS/);
    expect((await gitFetch(env, id, token, [`want ${head}`, `have ${hidden}`, 'done'])).error).toMatch(/^IMPORT_IN_PROGRESS/);
    // Off, nothing goes to the mirror.
    const off = { ...env, FAST_IMPORT: 'off' } as Env;
    expect((await gitFetch(off, id, token, [`want ${head}`, 'done'])).error).toMatch(/^IMPORT_IN_PROGRESS/);
    expect(mirror.asked).toHaveLength(0);
    // A mirror still holds a withheld blob.
    const made = await api(`${repo}/quarantine`, owner, { body: { blob: hex('b', 0), path: 'readme.md', reason: 'a leaked password' } }, env);
    expect(made.status).toBe(200);
    expect((await gitFetch(env, id, token, [`want ${head}`, 'done'])).error).toMatch(/^IMPORT_IN_PROGRESS/);
    expect(mirror.asked).toHaveLength(0);
    mirror.restore();
  });

  it('answers as before when the mirror has not got main, or cannot answer', async () => {
    const { env, id, head, token } = await landed('mirror_behind', true);
    const behind = serveMirror({ 'refs/heads/main': hex('c', 3) });
    expect((await gitFetch(env, id, token, [`want ${head}`, 'done'])).error).toMatch(/held only as imported history/);
    behind.restore();
    const down = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('busy', { status: 503 }));
    expect((await gitFetch(env, id, token, [`want ${head}`, 'done'])).error).toMatch(/held only as imported history/);
    down.mockRestore();
  });
});
