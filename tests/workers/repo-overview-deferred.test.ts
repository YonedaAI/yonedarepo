import { expect, it } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, countingOps, drainObjects, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const enabled = { ...scoped, OVERVIEW_BOOTSTRAP: 'on', OVERVIEW_DEFER_ACTIVITY: 'on' } as Env;
const mode = 'summary=true&overview=true';
async function fixture(name: string, files = [file('README.md', '# Selected content\n')]) {
  const owner = { cookie: await signup(name) };
  const made = await api('/repos', owner, { body: { name: 'project', files, author, policy: { approvals: 0, required_checks: [] } } }, enabled);
  expect(made.status).toBe(200);
  await drainObjects(enabled);
  return { owner, id: made.body.id as string, commit: made.body.commit as string, version: made.body.version as number };
}

it('returns admitted core content without a history read and names its exact deferred window', async () => {
  const r = await fixture('deferred_core');
  const seen = countingOps(enabled);
  const response = await api(`/repos/${r.id}?${mode}`, r.owner, {}, seen.env);
  expect(response.status).toBe(200);
  expect(response.body.overview).toMatchObject({
    tree: { commit: r.commit }, latest: { commit: r.commit },
    readme: { content: '# Selected content\n' }, activity: null,
    activity_request: { ref: 'main', from: r.commit, at: r.version },
  });
  const calls = seen.take();
  expect(calls.repo_status).toBe(1);
  expect(calls.repo_log ?? 0).toBe(0);
});

it('uses the captured commit and version for activity even after main changes', async () => {
  const r = await fixture('deferred_anchor');
  const core = await api(`/repos/${r.id}?${mode}`, r.owner, {}, enabled);
  const next = await api(`/repos/${r.id}/commits`, r.owner, { body: {
    ref: 'main', changes: [file('README.md', '# A newer revision\n')], message: 'A newer revision', author,
  } }, enabled);
  expect(next.status).toBe(200);
  expect((await api(`/repos/${r.id}/land`, r.owner, { body: { ref: 'main', commit: next.body.commit } }, enabled)).status).toBe(200);
  expect(core.body.overview.activity_request).toBeDefined();
  const query = new URLSearchParams({ ...core.body.overview.activity_request, limit: '200', view: 'overview' });
  const old = await api(`/repos/${r.id}/log?${query}`, r.owner, {}, enabled);
  expect(old.status).toBe(200);
  expect(old.body).toMatchObject({ version: r.version, ref: 'refs/heads/main' });
  expect(old.body.commits[0]).toMatchObject({ commit: r.commit, author_name: author.name });
  expect(Object.keys(old.body.commits[0]).sort()).toEqual(['author_name', 'authored_at', 'commit', 'landed', 'principal']);
  const fullQuery = new URLSearchParams(query);
  fullQuery.delete('view');
  const full = await api(`/repos/${r.id}/log?${fullQuery}`, r.owner, {}, enabled);
  expect(full.body.commits[0]).toHaveProperty('message');
  expect(full.body.commits[0]).toHaveProperty('files_changed');
  expect(old.body.commits.some((c: { commit: string }) => c.commit === next.body.commit)).toBe(false);
  const stranger = { cookie: await signup('deferred_stranger') };
  expect((await api(`/repos/${r.id}/log?${query}`, stranger, {}, enabled)).status).toBe(404);
  expect((await api(`/repos/${r.id}/members`, r.owner, { body: { account: 'deferred_stranger', role: 'read' } }, enabled)).status).toBe(200);
  expect((await api(`/repos/${r.id}/log?${query}`, stranger, {}, enabled)).body.commits[0].commit).toBe(r.commit);
  expect((await api(`/repos/${r.id}/members/deferred_stranger`, r.owner, { method: 'DELETE' }, enabled)).status).toBe(200);
  expect((await api(`/repos/${r.id}/log?${query}`, stranger, {}, enabled)).status).toBe(404);
});

it('retains the existing complete response when deferral is off', async () => {
  const r = await fixture('deferred_off');
  const result = await api(`/repos/${r.id}?${mode}`, r.owner, {}, { ...enabled, OVERVIEW_DEFER_ACTIVITY: 'off' } as Env);
  expect(result.body.overview.activity.commits[0].commit).toBe(r.commit);
  expect(result.body.overview.activity_request).toBeUndefined();
  const oldServer = await api(`/repos/${r.id}/log?view=overview&from=${r.commit}&at=${r.version}&limit=200`, r.owner, {}, { ...enabled, OVERVIEW_DEFER_ACTIVITY: 'off' } as Env);
  expect(oldServer.body.commits[0]).toHaveProperty('message');
});

it('keeps empty repositories explicit without scheduling an activity request', async () => {
  const r = await fixture('deferred_empty', []);
  const result = await api(`/repos/${r.id}?${mode}`, r.owner, {}, enabled);
  expect(result.body.overview).toMatchObject({ empty: true, tree: null, activity: { commits: [] } });
  expect(result.body.overview.activity_request).toBeUndefined();
});

it('keeps fork history on the existing inherited-object path', async () => {
  const r = await fixture('deferred_fork');
  const fork = await api(`/repos/${r.id}/fork`, r.owner, { body: { name: 'fork' } }, enabled);
  expect(fork.status).toBe(200);
  const result = await api(`/repos/${fork.body.id}?${mode}`, r.owner, {}, enabled);
  expect(result.body.overview.activity.commits[0].commit).toBe(r.commit);
  expect(result.body.overview.activity_request).toBeUndefined();
});

it('preserves an explicitly selected historical activity version', async () => {
  const r = await fixture('deferred_historic');
  const next = await api(`/repos/${r.id}/commits`, r.owner, { body: {
    ref: 'main', changes: [file('README.md', '# New\n')], message: 'New', author,
  } }, enabled);
  expect((await api(`/repos/${r.id}/land`, r.owner, { body: { ref: 'main', commit: next.body.commit } }, enabled)).status).toBe(200);
  const result = await api(`/repos/${r.id}?${mode}&at=${r.version}`, r.owner, {}, enabled);
  expect(result.body.overview.activity_request).toEqual({ ref: 'main', from: r.commit, at: r.version });
});

it('keeps core and deferred history on the same version when a landing races admission', async () => {
  const r = await fixture('deferred_admission_race');
  const initial = await api(`/repos/${r.id}/commits`, r.owner, { body: {
    ref: 'main', changes: [file('README.md', '# Admitted content\n')], message: 'Admitted landing', author,
  } }, enabled);
  const accepted = await api(`/repos/${r.id}/land`, r.owner, { body: { ref: 'main', commit: initial.body.commit } }, enabled);
  expect(accepted.status).toBe(200);
  r.commit = initial.body.commit;
  r.version = accepted.body.version;
  await drainObjects(enabled);
  const ns = enabled.SOURCE_REPOS;
  let raced = false;
  let newer = '';
  const env = { ...enabled, SOURCE_REPOS: {
    idFromName: (name: string) => ns.idFromName(name),
    get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
      const result = await ns.get(id).fetch(url, init);
      if (!raced && JSON.parse(String(init.body)).op === 'repo_status') {
        raced = true;
        const next = await api(`/repos/${r.id}/commits`, r.owner, { body: {
          ref: 'main', changes: [file('README.md', '# Raced content\n')], message: 'Raced landing', author,
        } }, enabled);
        newer = next.body.commit;
        expect((await api(`/repos/${r.id}/land`, r.owner, { body: { ref: 'main', commit: newer } }, enabled)).status).toBe(200);
        await drainObjects(enabled);
      }
      return result;
    } }),
  } } as unknown as Env;
  const core = await api(`/repos/${r.id}?${mode}`, r.owner, {}, env);
  expect(raced).toBe(true);
  expect(newer).not.toBe(r.commit);
  expect(core.body.overview.tree.commit).toBe(r.commit);
  expect(core.body.overview.readme.content).toBe('# Admitted content\n');
  const hint = core.body.overview.activity_request;
  expect(hint).toEqual({ ref: 'main', from: r.commit, at: r.version });
  const history = await api(`/repos/${r.id}/log?${new URLSearchParams({ ...hint, limit: '200' })}`, r.owner, {}, enabled);
  expect(history.body.commits[0].commit).toBe(r.commit);
  expect(history.body.commits[0].landed).toMatchObject({ version: r.version });
  expect(history.body.commits[0].landed.landed_at).toBeGreaterThan(0);
});
