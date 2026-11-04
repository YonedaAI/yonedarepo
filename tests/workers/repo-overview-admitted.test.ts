import { expect, it } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
import { projectChangesets } from '../../cloudflare/worker/repo-changesets';
import { api, author, countingOps, drainObjects, fakeCombiners, file, runCombinersUnder, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const on = { ...scoped, OVERVIEW_BOOTSTRAP: 'on', OVERVIEW_DEFER_ACTIVITY: 'on', OVERVIEW_ADMITTED_SNAPSHOT: 'on' } as Env;
const mode = 'summary=true&overview=true';
async function fixture(name: string, files = [file('README.md', '# Selected\n'), file('src/a.txt', 'a\n')]) {
  const owner = { cookie: await signup(name) };
  const made = await api('/repos', owner, { body: { name: 'project', files, author, policy: { approvals: 0, required_checks: [] } } }, on);
  expect(made.status).toBe(200);
  await drainObjects(on);
  return { owner, id: made.body.id as string, commit: made.body.commit as string, version: made.body.version as number };
}

function observe(target = on) {
  const commands: Record<string, unknown>[] = [];
  let heads = 0;
  const source = target.SOURCE_REPOS;
  const combiners = target.LAND_COMBINERS!;
  const seen = countingOps({ ...target,
    SOURCE_REPOS: { idFromName: (name: string) => source.idFromName(name), get: (id: DurableObjectId) => ({ fetch: (url: string, init: RequestInit) => {
      const command = JSON.parse(String(init.body));
      if (command.op === 'repo_status') commands.push(command);
      return source.get(id).fetch(url, init);
    } }) },
    LAND_COMBINERS: { idFromName: (name: string) => combiners.idFromName(name), get: (id: DurableObjectId) => {
      const stub = combiners.get(id) as unknown as { head: (...args: unknown[]) => Promise<unknown> };
      return { ...stub, head: (...args: unknown[]) => { heads++; return stub.head(...args); } };
    } },
  } as unknown as Env);
  return { ...seen, commands, heads: () => heads };
}

it.each(['main', 'refs/heads/main'])('selects %s in one status RPC without a separate head selection', async (ref) => {
  const r = await fixture('admitted_one');
  const seen = observe();
  const result = await api(`/repos/${r.id}?${mode}&ref=${ref}`, r.owner, {}, seen.env);
  expect(result.status).toBe(200);
  expect(result.body.overview).toMatchObject({ tree: { commit: r.commit }, latest: { commit: r.commit }, readme: { content: '# Selected\n' }, activity_request: { from: r.commit, at: r.version } });
  expect(result.body.snapshot).toBeUndefined();
  expect(seen.commands[0].snapshot).toEqual({ ref, min_version: 0 });
  expect(seen.heads()).toBe(0);
  expect(seen.take()).toMatchObject({ repo_status: 1, repo_commit: 1 });
});

it('never serves the old projected tree while an admitted changeset is pending', async () => {
  const r = await fixture('admitted_pending');
  const parked = { ...on, LAND_MODE: 'batch', LAND_COMBINERS: {
    idFromName: fakeCombiners.idFromName,
    get: (name: string) => name.endsWith('#projector')
      ? { catchUp: async () => 0, kick: async () => {} }
      : fakeCombiners.get(name),
  } } as unknown as Env;
  runCombinersUnder(parked);
  const next = await api(`/repos/${r.id}/commits`, r.owner, { body: { ref: 'main', changes: [file('README.md', '# Pending\n')], message: 'Pending', author } }, parked);
  const landed = await api(`/repos/${r.id}/land`, r.owner, { body: { ref: 'main', commit: next.body.commit } }, parked);
  expect(landed.status).toBe(200);
  expect(landed.body.git_commit).toBeNull();
  const seen = observe(parked);
  const result = await api(`/repos/${r.id}?${mode}`, r.owner, {}, seen.env);
  expect(result.body.overview.tree).toBeNull();
  expect(result.body.overview.errors.tree.code).toBe('PROJECTION_PENDING');
  expect(JSON.stringify(result.body)).not.toContain('# Selected');
  expect(seen.heads()).toBeGreaterThan(0);
  expect(await projectChangesets(on, r.id)).toBeGreaterThan(0);
  const ready = observe();
  expect((await api(`/repos/${r.id}?${mode}`, r.owner, {}, ready.env)).body.overview.readme.content).toBe('# Pending\n');
  expect(ready.heads()).toBe(0);
});

it('retains archived historical selection while current admission needs no replay', async () => {
  const r = await fixture('admitted_archive');
  // Local workerd-only history fixture; no live load or remote compaction.
  for (let batch = 0; batch < 11; batch++) {
    const updates = Array.from({ length: 100 }, (_, i) => ({ ref: `history_${batch}_${i}`, commit: r.commit, expected: null }));
    expect((await api(`/repos/${r.id}/refs/batch`, r.owner, { body: { updates } }, on)).status).toBe(200);
  }
  expect((await api(`/repos/${r.id}/retention`, r.owner, { method: 'PUT', body: { keep_versions: 64 } }, on)).status).toBe(200);
  expect((await api(`/repos/${r.id}/compact`, r.owner, { body: {} }, on)).body.floor).toBe(1024);
  const seen = observe();
  expect((await api(`/repos/${r.id}?${mode}`, r.owner, {}, seen.env)).body.overview.tree.commit).toBe(r.commit);
  expect(seen.heads()).toBe(0);
  const historical = observe();
  const old = await api(`/repos/${r.id}?${mode}&at=${r.version}`, r.owner, {}, historical.env);
  expect(old.body.overview.readme.content).toBe('# Selected\n');
  expect(historical.heads()).toBeGreaterThan(0);
  expect(historical.commands[0].snapshot).toBeUndefined();
});

it('uses the named resolver admission and never publishes the internal hint', async () => {
  const r = await fixture('admitted_named');
  const seen = observe();
  const result = await api(`/resolve/admitted_named/project?${mode}&snapshot=forged`, r.owner, {}, seen.env);
  expect(result.status).toBe(200);
  expect(result.body.summary.overview.tree.commit).toBe(r.commit);
  expect(result.body.summary.snapshot).toBeUndefined();
  expect(seen.heads()).toBe(0);
  expect(seen.take().repo_status).toBe(1);
});

it('falls back for a wrong-branch hint even at the admitted version', async () => {
  const r = await fixture('admitted_wrong_branch');
  const source = on.SOURCE_REPOS;
  const env = { ...on, SOURCE_REPOS: { idFromName: (name: string) => source.idFromName(name), get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
    const response = await source.get(id).fetch(url, init);
    if (JSON.parse(String(init.body)).op !== 'repo_status') return response;
    const value = await response.json<Record<string, any>>();
    expect(value.snapshot.version).toBe(value.version);
    value.snapshot.ref = 'refs/heads/another';
    return Response.json(value);
  } }) } } as unknown as Env;
  const seen = observe(env);
  const result = await api(`/repos/${r.id}?${mode}`, r.owner, {}, seen.env);
  expect(result.body.overview.tree.commit).toBe(r.commit);
  expect(seen.heads()).toBeGreaterThan(0);
});

it('preserves commit selection for a bare SHA even if a same-named branch differs', async () => {
  const r = await fixture('admitted_sha_branch');
  const next = await api(`/repos/${r.id}/commits`, r.owner, { body: { ref: 'main', changes: [file('README.md', '# Branch\n')], message: 'Branch', author } }, on);
  expect((await api(`/repos/${r.id}/refs/batch`, r.owner, { body: { updates: [{ ref: r.commit, commit: next.body.commit, expected: null }] } }, on)).status).toBe(200);
  const off = await api(`/repos/${r.id}?${mode}&ref=${r.commit}`, r.owner, {}, { ...on, OVERVIEW_ADMITTED_SNAPSHOT: 'off' });
  const seen = observe();
  const result = await api(`/repos/${r.id}?${mode}&ref=${r.commit}`, r.owner, {}, seen.env);
  expect(result.body.overview.tree.commit).toBe(off.body.overview.tree.commit);
  expect(result.body.overview.readme.content).toBe('# Selected\n');
  expect(seen.commands[0].snapshot).toBeUndefined();
  // The OFF comparison warmed the old head cache; fallback need not make another RPC.
  const branch = observe();
  const qualified = await api(`/repos/${r.id}?${mode}&ref=refs/heads/${r.commit}`, r.owner, {}, branch.env);
  expect(qualified.body.overview.tree.commit).toBe(next.body.commit);
  expect(qualified.body.overview.readme.content).toBe('# Branch\n');
  expect(branch.heads()).toBe(0);
});

it('keeps a moving main pinned to the status transaction', async () => {
  const r = await fixture('admitted_race');
  const next = await api(`/repos/${r.id}/commits`, r.owner, { body: { ref: 'main', changes: [file('README.md', '# Newer\n')], message: 'Newer', author } }, on);
  const source = on.SOURCE_REPOS;
  let moved = false;
  const env = { ...on, SOURCE_REPOS: { idFromName: (name: string) => source.idFromName(name), get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
    const response = await source.get(id).fetch(url, init);
    if (!moved && JSON.parse(String(init.body)).op === 'repo_status') {
      moved = true;
      expect((await api(`/repos/${r.id}/land`, r.owner, { body: { ref: 'main', commit: next.body.commit } }, on)).status).toBe(200);
      await drainObjects(on);
    }
    return response;
  } }) } } as unknown as Env;
  const seen = observe(env);
  const result = await api(`/repos/${r.id}?${mode}`, r.owner, {}, seen.env);
  expect(moved).toBe(true);
  expect(result.body.overview).toMatchObject({ tree: { commit: r.commit }, latest: { commit: r.commit }, readme: { content: '# Selected\n' }, activity_request: { from: r.commit, at: r.version } });
  expect(seen.heads()).toBe(0);
});

it.each(['off', 'historical', 'commit', 'higher-minimum', 'deferral-off'])('keeps the existing selection path for %s', async (kind) => {
  const r = await fixture(`admitted_${kind.replaceAll('-', '_')}`);
  const env = { ...on, ...(kind === 'off' && { OVERVIEW_ADMITTED_SNAPSHOT: 'off' }), ...(kind === 'deferral-off' && { OVERVIEW_DEFER_ACTIVITY: 'off' }) };
  const seen = observe(env);
  const suffix = kind === 'historical' ? `&at=${r.version}` : kind === 'commit' ? `&commit=${r.commit}` : kind === 'higher-minimum' ? `&min_version=${r.version + 10}` : '';
  const result = await api(`/repos/${r.id}?${mode}${suffix}`, r.owner, {}, seen.env);
  expect(result.status).toBe(200);
  expect(seen.heads()).toBeGreaterThan(0);
  if (kind !== 'higher-minimum') {
    expect(seen.commands[0].snapshot).toBeUndefined();
    expect(result.body.overview.tree.commit).toBe(r.commit);
  } else expect(result.body.overview.errors.tree.code).toBe('STALE_READ');
  expect(result.body.snapshot).toBeUndefined();
});

it('keeps empty heads and forks on their existing path', async () => {
  const empty = await fixture('admitted_empty', []);
  const seen = observe();
  const result = await api(`/repos/${empty.id}?${mode}`, empty.owner, {}, seen.env);
  expect(result.body.overview).toMatchObject({ empty: true, tree: null });
  expect(seen.heads()).toBeGreaterThan(0);
  const parent = await fixture('admitted_parent');
  const fork = await api(`/repos/${parent.id}/fork`, parent.owner, { body: { name: 'fork' } }, on);
  const forkSeen = observe();
  const shown = await api(`/repos/${fork.body.id}?${mode}`, parent.owner, {}, forkSeen.env);
  expect(shown.body.overview.tree.commit).toBe(parent.commit);
  expect(forkSeen.heads()).toBeGreaterThan(0);
});

it('keeps fresh access, path restrictions, revocation and withholding ahead of content', async () => {
  const r = await fixture('admitted_access');
  const stranger = { cookie: await signup('admitted_stranger') };
  expect((await api(`/repos/${r.id}?${mode}`, stranger, {}, on)).status).toBe(404);
  const token = await api(`/repos/${r.id}/tokens`, r.owner, { body: { name: 'limited', scopes: ['read'], paths: ['src/'] } }, on);
  const reader = { token: token.body.token };
  const seen = observe();
  const limited = await api(`/repos/${r.id}?${mode}`, reader, {}, seen.env);
  expect(limited.body.overview.tree.entries.map((e: { name: string }) => e.name)).toEqual(['src']);
  expect(limited.body.overview.readme).toBeNull();
  expect(seen.heads()).toBeGreaterThan(0);
  expect((await api(`/repos/${r.id}/tokens/limited`, r.owner, { method: 'DELETE' }, on)).status).toBe(200);
  expect((await api(`/repos/${r.id}?${mode}`, reader, {}, on)).status).toBe(401);
  expect((await api(`/repos/${r.id}/quarantine`, r.owner, { body: { path: 'README.md', reason: 'fixture' } }, on)).status).toBe(200);
  const withheld = observe();
  const shown = await api(`/repos/${r.id}?${mode}`, r.owner, {}, withheld.env);
  expect(shown.body.overview).toMatchObject({ tree: { commit: r.commit }, readme: null, errors: { readme: { code: 'QUARANTINED' } } });
  expect(JSON.stringify(shown.body)).not.toContain('# Selected');
  expect(withheld.heads()).toBe(0);
});
