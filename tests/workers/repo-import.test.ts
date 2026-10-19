// Importing an external Git repository: Artifacts (faked over a real platform-built
// source repository's objects) fetches it; first-parent history is recorded with file
// changes from verified trees and the branch lands. Steps retry like a Workflow.
import { expect, it } from 'vitest';
import { type ImportStep, runImport } from '../../cloudflare/worker/repo-import';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

/** Runs steps directly, retrying failures a few times like Workflows would. */
const step: ImportStep = {
  async do(_name, _config, callback) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await callback();
      } catch (e) {
        if (attempt >= 4) throw e;
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
    head = made.body.commit;
  }
  const remote = fakeRemote(`yr-${source.body.id}`, head);
  let started: any;
  const workflows = { create: async (options: any) => ((started = options), { id: options.id }), get: async () => ({ status: async () => ({ status: 'running' }) }) };
  const env = { ...scoped, ARTIFACTS: remote, PLATFORM_IMPORT: workflows } as unknown as Env;

  const created = await api('/repos/import', owner, { body: { name: 'imported', url: 'https://git.example/src.git', max_commits: 2 } }, env);
  expect(created.status).toBe(200);
  expect(started).toMatchObject({ id: `import-${created.body.id}`, params: { repo: created.body.id, branch: 'main', max: 2 } });
  expect((await api(`/repos/${created.body.id}/import`, owner, {}, env)).body.status).toBe('running');

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
