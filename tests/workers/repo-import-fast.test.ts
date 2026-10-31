// `FAST_IMPORT`: main lands at the remote's head as soon as Artifacts has it, and history
// fills in behind it, newest first. Artifacts is a fake with a synthetic first-parent chain
// (no real Git objects: the chain's ids and trees are made up), so counts are exact.
import { afterEach, expect, it } from 'vitest';
import { type ImportStep, runImport } from '../../cloudflare/worker/repo-import';
import { gitObjectId } from '../../cloudflare/worker/repo-objects';
import type { Env } from '../../cloudflare/worker/types';
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

async function imported(remote: unknown, name: string, max = 5000) {
  const owner = { cookie: await signup(`fast_${name}`) };
  (scoped as any).ARTIFACTS = remote;
  let started: any;
  const workflows = {
    create: async (options: any) => ((started = options), { id: options.id }),
    get: async () => ({ status: async () => ({ status: 'running' }) }),
  };
  const env = { ...scoped, ARTIFACTS: remote, PLATFORM_IMPORT: workflows, FAST_IMPORT: 'on' } as unknown as Env;
  const created = await api('/repos/import', owner, { body: { name, url: 'https://git.example/src.git', branch: 'main', max_commits: max } }, env);
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
    expect(queued.filter((m) => m.kind === 'platform_project')).toHaveLength(1);
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
