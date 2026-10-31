// Importing an external Git repository: Artifacts (faked over a real platform-built
// source repository's objects) fetches it; first-parent history is recorded with file
// changes from verified trees and the branch lands. Steps retry like a Workflow.
import { expect, it, vi } from 'vitest';
import { type ImportStep, runImport } from '../../cloudflare/worker/repo-import';
import type { Env } from '../../cloudflare/worker/types';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { projectRefs } from '../../cloudflare/worker/repo-projection';
import { asGit } from './git-answer';
import { api, author, bindings, drainObjects, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

/** Runs steps directly, retrying failures a few times like Workflows would (never a
 * NonRetryableError); `attempts` counts every run of a step. */
const attempts: string[] = [];
const step: ImportStep = {
  async do(name, _config, callback) {
    for (let attempt = 1; ; attempt++) {
      attempts.push(name);
      try {
        return await callback();
      } catch (e: any) {
        if (attempt >= 4 || e?.name === 'NonRetryableError') throw e;
      }
    }
  },
};

function fakeRemote(sourceStore: string, head: string, busyReads = 1) {
  const imported = new Set<string>();
  let busy = busyReads;
  // Imported objects come from the source; later pushes land in the platform's cache copy.
  let target = '';
  const object = async (id: string) =>
    (await bindings.OBJECTS.get(`store/v1/${sourceStore}/objects/${id}`)) ??
    (await bindings.OBJECTS.get(`platform/v1/${target}/objects/${id}`));
  const commit = async (id: string) => {
    const found = await object(id);
    if (!found) return null;
    const c = await found.json<{ tree: string; parents: string[] }>();
    return { hash: id, treeHash: c.tree, parents: c.parents, message: `message ${id.slice(0, 6)}`, author, committer: author, authoredAt: 0, committedAt: 0 };
  };
  return {
    imported,
    create: async () => ({}),
    import: async ({ target }: any) => {
      if (imported.has(target.name)) throw Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
      imported.add(target.name);
      return {};
    },
    get: async (name: string) => {
      if (!imported.has(name)) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
      if (busy-- > 0) throw Object.assign(new Error('importing'), { code: 'IMPORT_IN_PROGRESS' });
      target = name.slice(3);
      return {
        [Symbol.dispose]() {},
        info: async () => ({ remote: `https://artifacts.test/${name}` }),
        createToken: async () => ({ id: 't', plaintext: 'artifact-write-token' }),
        revokeToken: async () => true,
        readCommit: commit,
        readTree: async (id: string) => {
          const found = await object(id);
          return found ? (await found.json<{ entries: any[] }>()).entries.map((e) => ({ name: e.name, mode: '', hash: e.id, type: e.type })) : null;
        },
        readBlob: async (id: string) => {
          const found = await object(id);
          return found ? new Blob([await found.arrayBuffer()]) : null;
        },
        log: async ({ limit = 50, offset = 0 }: any) => {
          const chain = [];
          for (let id: string | undefined = head; id; id = (await commit(id))?.parents[0]) chain.push(await commit(id));
          return chain.slice(offset, offset + limit);
        },
      };
    },
  };
}

it('imports first-parent history from a remote and lands it', async () => {
  const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
  const owner = { cookie: await signup('importer') };
  // A "remote" built by the platform itself on the R2 store: three commits.
  const source = await api('/repos', owner, { body: { name: 'src', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '1\n')], author } }, local);
  let head = source.body.commit as string;
  for (const text of ['2\n', '3\n']) {
    const made = await api(`/repos/${source.body.id}/commits`, owner, { body: { ref: 'main', changes: [file('a.txt', text), file(`n${text.trim()}.txt`, text)], message: text, author } }, local);
    await api(`/repos/${source.body.id}/land`, owner, { body: { ref: 'main', commit: made.body.commit } }, local);
  }
  // The remote mirrors main: its Git head, the commit built for the last landed batch.
  head = (await api(`/repos/${source.body.id}/refs`, owner, {}, local)).body.refs['refs/heads/main'];
  // The remote must hold the landed history: objects into R2, then main into the R2 store.
  await drainObjects(local);
  for (const message of queued.splice(0).filter((m) => m.kind === 'platform_project')) await projectRefs(local, message);
  const remote = fakeRemote(`yr-${source.body.id}`, head);
  let started: any;
  const workflows = { create: async (options: any) => ((started = options), { id: options.id }), get: async () => ({ status: async () => ({ status: 'running' }) }) };
  const env = { ...scoped, ARTIFACTS: remote, PLATFORM_IMPORT: workflows } as unknown as Env;

  const created = await api('/repos/import', owner, { body: { name: 'imported', url: 'https://git.example/src.git', max_commits: 2 } }, env);
  expect(created.status).toBe(200);
  expect(started).toMatchObject({ id: `import-${created.body.id}`, params: { repo: created.body.id, branch: undefined, max: 2 } });
  expect((await api(`/repos/${created.body.id}/import`, owner, {}, env)).body.status).toBe('running');
  // A repository that was never imported has no import, and that is not a server error.
  const never = await api('/repos', owner, { body: { name: 'never', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n')], author } }, env);
  const noWorkflow = {
    ...env,
    PLATFORM_IMPORT: { get: async () => Promise.reject(new Error('(instance.not_found) Instance not found')) },
  } as unknown as Env;
  const none = await api(`/repos/${never.body.id}/import`, owner, {}, noWorkflow);
  expect([none.status, none.body.error?.code]).toEqual([404, 'NOT_FOUND']);

  const result = await runImport(env, started.params, step);
  expect(result).toMatchObject({ commit: head, version: 1, commits: 2 });
  // Re-running the whole import is a no-op (every step is idempotent).
  expect(await runImport(env, started.params, step)).toMatchObject({ commit: head, version: 1 });

  const repo = `/repos/${created.body.id}`;
  const log = await api(`${repo}/log?ref=main`, owner, {}, env);
  expect(log.body.commits.map((c: any) => c.commit)[0]).toBe(head);
  expect(log.body.commits).toHaveLength(2); // truncated at max_commits
  const top = await api(`${repo}/commits/${head}`, owner, {}, env);
  expect(top.body.paths.map((p: any) => `${p.op}:${p.path}`)).toEqual(['modify:a.txt', 'add:n3.txt']);
  expect((await api(`${repo}/blob?path=n2.txt`, owner, {}, env)).body.content).toBe('2\n');
  // Imported history is live: the platform can commit on top of it.
  const next = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('b.txt', 'b\n')], message: 'after import', author } }, env);
  expect(next.status).toBe(200);
  expect(next.body.parents).toEqual([head]);

  expect((await api('/repos/import', owner, { body: { url: 'http://insecure' } }, env)).status).toBe(400);
});

it('refuses a clone of history only the mirror holds at once, reading none of its trees', async () => {
  const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
  const owner = { cookie: await signup('import_clone') };
  const source = await api('/repos', owner, { body: { name: 'src', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '1\n')], author } }, local);
  for (const text of ['2\n', '3\n']) {
    const made = await api(`/repos/${source.body.id}/commits`, owner, { body: { ref: 'main', changes: [file(`d${text.trim()}/n.txt`, text)], message: text, author } }, local);
    await api(`/repos/${source.body.id}/land`, owner, { body: { ref: 'main', commit: made.body.commit } }, local);
  }
  const head = (await api(`/repos/${source.body.id}/refs`, owner, {}, local)).body.refs['refs/heads/main'];
  await drainObjects(local);
  for (const message of queued.splice(0).filter((m) => m.kind === 'platform_project')) await projectRefs(local, message);
  const remote = fakeRemote(`yr-${source.body.id}`, head, 0);
  // Every tree read from the mirror, counted.
  let treeReads = 0;
  const counted = {
    ...remote,
    get: async (name: string) => {
      const repo = await remote.get(name);
      return { ...repo, readTree: (id: string) => (treeReads++, repo.readTree(id)) };
    },
  };
  let started: any;
  const workflows = { create: async (options: any) => ((started = options), { id: options.id }), get: async () => ({ status: async () => ({ status: 'running' }) }) };
  const env = { ...scoped, ARTIFACTS: counted, PLATFORM_IMPORT: workflows } as unknown as Env;
  const created = await api('/repos/import', owner, { body: { name: 'imported', url: 'https://git.example/src.git' } }, env);
  await runImport(env, started.params, step);
  const token = await api(`/repos/${created.body.id}/tokens`, owner, { body: { name: 'reader', scopes: ['read'] } }, env);
  const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
  for (const args of [[`want ${head}`, 'thin-pack', 'ofs-delta', 'done'], [`want ${head}`, 'deepen 1', 'done']]) {
    treeReads = 0;
    const body = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${args.map((a) => pkt(`${a}\n`)).join('')}0000`;
    const response = await platformFetch(
      new Request(`https://yoneda/git/${created.body.id}.git/git-upload-pack`, {
        method: 'POST',
        headers: { authorization: `Basic ${btoa(`git:${token.body.token}`)}`, 'git-protocol': 'version=2' },
        body,
      }),
      env,
    );
    // Refused before the pack starts (Git prints `remote error: …`), not after a walk of
    // the imported trees through the mirror.
    expect(response.status, args.join(' ')).toBe(200);
    const answer = asGit(new Uint8Array(await response.arrayBuffer()), true);
    expect(answer, args.join(' ')).toMatchObject({ badBand: null, pack: 0 });
    expect(answer.error, args.join(' ')).toMatch(/^NOT_FOUND: Commit [0-9a-f]{40} is held only as imported history/);
    expect(treeReads, args.join(' ')).toBe(0);
  }
});

/** A remote whose default branch is `master` (Artifacts: a branch it lacks is NOT_FOUND). */
function masterRemote(sourceStore: string, head: string) {
  const remote = fakeRemote(sourceStore, head, 0);
  const asked: (string | undefined)[] = [];
  return {
    asked,
    ...remote,
    import: async (params: any) => {
      asked.push(params.source.branch);
      if (params.source.branch && params.source.branch !== 'master')
        throw Object.assign(new Error(`Branch not found: "${params.source.branch}"`), { code: 'NOT_FOUND' });
      return remote.import(params);
    },
    // As live Artifacts answers: info() says main for an imported master, and main has no log.
    get: async (name: string) => {
      const repo = await remote.get(name);
      return {
        ...repo,
        info: async () => ({ remote: `https://artifacts.test/${name}`, defaultBranch: 'main' }),
        // Only a branch named at import has a log; HEAD resolves to nothing.
        log: async (options: any) => (options?.ref === 'master' ? repo.log(options) : []),
      };
    },
  };
}

it("imports the remote's default branch as main when none is named, and fails a missing branch at once", async () => {
  const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
  const owner = { cookie: await signup('import_master') };
  const source = await api('/repos', owner, { body: { name: 'src', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'master\n')], author } }, local);
  const head = source.body.commit as string;
  await drainObjects(local);
  for (const message of queued.splice(0).filter((m) => m.kind === 'platform_project')) await projectRefs(local, message);
  const remote = masterRemote(`yr-${source.body.id}`, head);
  let started: any;
  const workflows = { create: async (options: any) => ((started = options), { id: options.id }), get: async () => ({ status: async () => ({ status: 'running' }) }) };
  const env = { ...scoped, ARTIFACTS: remote, PLATFORM_IMPORT: workflows } as unknown as Env;

  const created = await api('/repos/import', owner, { body: { name: 'hello', url: 'https://git.example/hello.git' } }, env);
  expect([created.status, created.body.branch]).toEqual([200, null]);
  expect(started.params.branch).toBeUndefined();
  // The remote names its default branch in its Git advertisement; nothing else does.
  const advertised = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(`001e# service=git-upload-pack\n0000${'0'.repeat(4)}${head} HEAD\0multi_ack symref=HEAD:refs/heads/master agent=git/2\n0000`),
  );
  expect(await runImport(env, started.params, step)).toMatchObject({ commit: head, version: 1 });
  expect(String(advertised.mock.calls[0]?.[0])).toBe('https://git.example/hello.git/info/refs?service=git-upload-pack');
  advertised.mockRestore();
  expect(remote.asked).toEqual(['master']);
  // The default branch's history is this repository's main.
  expect((await api(`/repos/${created.body.id}/refs`, owner, {}, env)).body.refs).toEqual({ 'refs/heads/main': head });
  expect((await api(`/repos/${created.body.id}/blob?path=a.txt`, owner, {}, env)).body.content).toBe('master\n');

  // A branch the remote does not have fails the import in one attempt, saying why.
  const named = await api('/repos/import', owner, { body: { name: 'named', url: 'https://git.example/hello.git', branch: 'main' } }, env);
  expect(named.body.branch).toBe('main');
  attempts.length = 0;
  await expect(runImport(env, started.params, step)).rejects.toThrow(/Branch not found: "main"/);
  expect(attempts).toEqual(['import into the object store']);
});
