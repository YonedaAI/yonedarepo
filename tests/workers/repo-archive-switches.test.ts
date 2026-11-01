// The archive switches that change what a repository stores, through the real authority:
// each reaches it from the deployment's variable alone, what it stores reads back as ever,
// and a client that names one changes nothing.
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { caller } from '../../cloudflare/worker/repo-ops';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, CHECK_EVIDENCE_ONCE: 'on', REF_CHAIN_SHARED: 'on' } as unknown as Env;
const FILES = 'a'.repeat(64);

const rows = (id: string, statement: string) =>
  runInDurableObject(bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(id)), async (_instance, state) => state.storage.sql.exec(statement).toArray());

/** A repository whose main has landed `landed` commits, with its owner. */
async function repoWith(name: string, policy: object, landed = 0) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, { body: { name, policy, files: [file('a.txt', '0\n')], author } });
  const id = created.body.id as string;
  for (let i = 0; i < landed; i++) {
    const made = await api(`/repos/${id}/commits`, owner, { body: { ref: 'main', changes: [file(`w/${i}.txt`, 'x\n')], message: 'm', author } });
    expect((await api(`/repos/${id}/land`, owner, { body: { ref: 'main', commit: made.body.commit } })).status).toBe(200);
  }
  return { id, owner, head: (await api(`/repos/${id}/refs`, owner)).body.refs['refs/heads/main'] as string };
}

const chainRows = async (id: string, refname: string) => (await rows(id, `SELECT COUNT(*) AS n FROM ref_chain WHERE ref='${refname}'`))[0].n;

it('shares main from the switch alone, never from a command', async () => {
  const { id, head } = await repoWith('chains', { required_checks: [], approvals: 0 }, 4);
  const branch = (ref: string, env: Env, extra: object = {}) =>
    caller(env, id, { _system: 'merge' })({ op: 'repo_branch_set', ref, commit: head, expected: null, ...extra });
  await branch('refs/heads/off', scoped, { _ref_chain: 'shared' });
  await branch('refs/heads/on', on);
  expect(await chainRows(id, 'refs/heads/off')).toBe(await chainRows(id, 'refs/heads/main'));
  expect(await chainRows(id, 'refs/heads/on')).toBe(1);
  // The path's history is the same from either branch.
  const history = async (ref: string) => (await caller(scoped, id, { _system: 'derive' })({ op: 'repo_path_history', ref, path: 'w' })).commits;
  expect((await history('refs/heads/on')).length).toBe(4);
  expect(await history('refs/heads/on')).toEqual(await history('refs/heads/off'));
});

it('stores a verdict once from the switch alone, and the run and its log still read', async () => {
  const policy = { required_checks: ['unit'], approvals: 0, runners: { unit: { command: ['true'] } } };
  const finish = async (name: string, env: Env, extra: object = {}) => {
    const { id, owner } = await repoWith(name, policy);
    const made = await api(`/repos/${id}/commits`, owner, { body: { ref: 'main', changes: [file('b.txt', 'b\n')], message: 'm', author } });
    const run = made.body.check_runs[0].id as string;
    const call = caller(env, id, { _system: 'checks' });
    const claim = await call({ op: 'repo_check_claim', run_id: run });
    const log = `platform/v1/${id}/checks/${run}/log.txt`;
    await bindings.OBJECTS.put(log, 'all passed\n');
    const evidence = { commit: claim.commit, tree: claim.tree, files_sha256: FILES, log };
    await call({ op: 'repo_check_complete', run_id: run, epoch: claim.epoch, outcome: 'pass', evidence, ...extra });
    return { id, owner, run, stored: (await rows(id, `SELECT result FROM check_runs WHERE id='${run}'`))[0].result };
  };
  const off = await finish('verdict_twice', scoped, { _check_evidence: 'once' });
  expect(off.stored).toEqual(expect.any(String));
  const once = await finish('verdict_once', on);
  expect(once.stored).toBeNull();
  const run = await api(`/repos/${once.id}/check-runs/${once.run}`, once.owner);
  expect(run.body).toMatchObject({ status: 'passed', result: { files_sha256: FILES } });
  expect((await api(`/repos/${once.id}/check-runs/${once.run}/log`, once.owner)).body.log).toBe('all passed\n');
});
