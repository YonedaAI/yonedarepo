import { expect, it, vi } from 'vitest';
import { encodeAccountIdentifier } from '../../shared/account';
import { edgeDelete } from '../../cloudflare/worker/repo-cache-tiers';
import { sha } from '../../cloudflare/worker/storage';
import { workspace } from '../../cloudflare/worker/workspace';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, countingOps, drainObjects, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const on = { ...scoped, OVERVIEW_BOOTSTRAP: 'on', OVERVIEW_AUTH_OVERLAP: 'on' } as Env;
const mode = 'summary=true&overview=true';
async function setup(name: string, files = [file('README.md', '# Before\n'), file('src/a.txt', 'a\n')]) {
  const owner = { cookie: await signup(name) };
  const made = await api('/repos', owner, { body: { name: 'project', files, author, policy: { approvals: 0, required_checks: [] } } }, on);
  expect(made.status).toBe(200);
  await drainObjects(on);
  return { owner, id: made.body.id as string, commit: made.body.commit as string, version: made.body.version as number };
}

it('bootstraps exact Overview content through one fresh status without shard diagnostics', async () => {
  const r = await setup('overview_one');
  const seen = countingOps(on);
  let shards = 0;
  const env = { ...seen.env, COMMIT_SHARDS: { idFromName: () => { shards++; throw new Error('No storage diagnostics'); } } } as unknown as Env;
  const response = await api(`/repos/${r.id}?${mode}`, r.owner, {}, env);
  expect(response.status).toBe(200);
  expect(response.body).not.toHaveProperty('objects');
  expect(response.body.overview).toMatchObject({ ref: 'main', empty: false, tree: { commit: r.commit }, latest: { commit: r.commit }, readme: { commit: r.commit, path: 'README.md', encoding: 'utf-8', content: '# Before\n' } });
  expect(response.body.overview.activity.commits[0].commit).toBe(r.commit);
  expect(response.body.overview.errors).toBeUndefined();
  expect(seen.take().repo_status).toBe(1);
  expect(shards).toBe(0);
});

it('reuses completed activity while admitting each request and refreshing mutable checks', async () => {
  const r = await setup('overview_cached');
  const seen = countingOps(on);
  const path = `/repos/${r.id}?${mode}`;
  const first = await api(path, r.owner, {}, seen.env);
  const second = await api(path, r.owner, {}, seen.env);
  expect(second.body.overview.activity).toEqual(first.body.overview.activity);
  expect(seen.take()).toMatchObject({ repo_status: 2, repo_log: 1, repo_commit: 2 });
  expect((await api(`/repos/${r.id}/commits/${r.commit}/checks`, r.owner, { body: { name: 'live', status: 'pass', evidence: 'current' } }, on)).status).toBe(200);
  const refreshed = await api(path, r.owner, {}, seen.env);
  expect(refreshed.body.overview.latest.checks).toContainEqual({ name: 'live', status: 'pass' });
  expect(seen.take().repo_commit).toBe(1);
});

it('reuses the named resolver status and handle and preserves aliases', async () => {
  const r = await setup('overview_named');
  const seen = countingOps(on);
  const first = await api(`/resolve/overview_named/project?${mode}`, r.owner, {}, seen.env);
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ id: r.id, handle: 'overview_named', path: '/overview_named/project', summary: { owner_handle: 'overview_named', overview: { tree: { commit: r.commit } } } });
  expect(seen.take().repo_status).toBe(1);
  expect((await api(`/repos/${r.id}/name`, r.owner, { method: 'PUT', body: { name: 'renamed' } }, on)).status).toBe(200);
  const old = await api(`/resolve/overview_named/project?${mode}`, r.owner, {}, on);
  expect(old.body).toMatchObject({ name: 'renamed', renamed_from: 'project', path: '/overview_named/renamed', summary: { name: 'renamed', path: '/overview_named/renamed' } });
});

it('old/off endpoints keep their existing cheap compatible responses', async () => {
  const r = await setup('overview_off');
  const off = { ...on, OVERVIEW_BOOTSTRAP: 'off' };
  const id = await api(`/repos/${r.id}?${mode}`, r.owner, {}, off);
  expect(id.status).toBe(200);
  expect(id.body).not.toHaveProperty('objects');
  expect(id.body).not.toHaveProperty('overview');
  const named = await api(`/resolve/overview_off/project?${mode}`, r.owner, {}, off);
  expect(named.body).toEqual({ id: r.id, handle: 'overview_off', name: 'project', path: '/overview_off/project' });
});

it('keeps empty repositories and missing README content explicit', async () => {
  const r = await setup('overview_empty', []);
  const empty = await api(`/repos/${r.id}?${mode}`, r.owner, {}, on);
  expect(empty.status).toBe(200);
  expect(empty.body.overview).toMatchObject({ ref: 'main', empty: true, tree: null, latest: null, readme: null });
  const plain = await setup('overview_no_readme', [file('a.txt', 'hello\n')]);
  const shown = await api(`/repos/${plain.id}?${mode}`, plain.owner, {}, on);
  expect(shown.body.overview).toMatchObject({ empty: false, readme: null, latest: { commit: plain.commit } });
});

it('pins README/latest/activity to the tree even when main lands while details read', async () => {
  const r = await setup('overview_race');
  const made = await api(`/repos/${r.id}/commits`, r.owner, { body: { ref: 'main', changes: [file('README.md', '# After\n')], message: 'after', author } }, on);
  expect(made.status).toBe(200);
  let moved = false;
  const ns = on.SOURCE_REPOS;
  const env = { ...on, SOURCE_REPOS: { idFromName: (name: string) => ns.idFromName(name), get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
    const c = JSON.parse(String(init.body));
    if (!moved && c.op === 'repo_commit' && c.commit === r.commit) {
      moved = true;
      expect((await api(`/repos/${r.id}/land`, r.owner, { body: { ref: 'main', commit: made.body.commit } }, on)).status).toBe(200);
    }
    return ns.get(id).fetch(url, init);
  } }) } } as unknown as Env;
  const response = await api(`/repos/${r.id}?${mode}`, r.owner, {}, env);
  expect(moved).toBe(true);
  expect(response.body.overview).toMatchObject({ tree: { commit: r.commit }, latest: { commit: r.commit }, readme: { commit: r.commit, content: '# Before\n' } });
  expect(response.body.overview.activity.commits[0].commit).toBe(r.commit);
  const current = await api(`/repos/${r.id}/blob?path=README.md`, r.owner, {}, on);
  expect(current.body.content).toBe('# After\n');
});


it('keeps selected branches and compact mutable latest/activity fields correct', async () => {
  const r = await setup('overview_branch');
  const made = await api(`/repos/${r.id}/commits`, r.owner, { body: { ref: 'main', changes: [file('README.md', '# Feature\n')], message: 'Feature title\n\nlarge detail', author } }, on);
  expect(made.status).toBe(200);
  expect((await api(`/repos/${r.id}/branches`, r.owner, { body: { ref: 'feature', commit: made.body.commit, expected: null } }, on)).status).toBe(200);
  const selected = await api(`/repos/${r.id}?${mode}&ref=feature`, r.owner, {}, on);
  expect(selected.body.overview).toMatchObject({ ref: 'feature', tree: { commit: made.body.commit }, latest: { message: 'Feature title' }, readme: { content: '# Feature\n' } });
  const activity = selected.body.overview.activity.commits[0];
  expect(activity.commit).toBe(made.body.commit);
  for (const key of ['message', 'tree', 'paths', 'parents']) expect(activity).not.toHaveProperty(key);
  for (const key of ['read_set', 'paths', 'reviews', 'check_runs']) expect(selected.body.overview.latest).not.toHaveProperty(key);
  const posted = await api(`/repos/${r.id}/commits/${made.body.commit}/checks`, r.owner, { body: { name: 'fresh', status: 'pass', evidence: 'large private check evidence' } }, on);
  expect(posted.status).toBe(200);
  const refreshed = await api(`/repos/${r.id}?${mode}&ref=feature`, r.owner, {}, on);
  expect(refreshed.body.overview.latest.checks).toContainEqual({ name: 'fresh', status: 'pass' });
  expect(JSON.stringify(refreshed.body.overview)).not.toContain('large private check evidence');
});

it('runs README, latest and activity independently after selecting one tree', async () => {
  const r = await setup('overview_parallel');
  const listed = await api(`/repos/${r.id}/tree`, r.owner, {}, on);
  const blob = listed.body.entries.find((e: any) => e.name === 'README.md').id;
  await edgeDelete(r.id, blob);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const arrived = new Set<string>();
  const ns = on.SOURCE_REPOS;
  const bucket = on.OBJECTS;
  const env = { ...on, SOURCE_REPOS: { idFromName: (name: string) => ns.idFromName(name), get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
    const c = JSON.parse(String(init.body));
    if (['repo_commit', 'repo_log'].includes(c.op)) { arrived.add(c.op); await gate; }
    return ns.get(id).fetch(url, init);
  } }) }, OBJECTS: new Proxy(bucket, { get: (t, key) => key === 'get' ? async (...args: unknown[]) => {
    if (args[0] === `platform/v1/${r.id}/objects/${blob}`) { arrived.add('readme'); await gate; }
    return Reflect.apply(t.get, t, args);
  } : typeof Reflect.get(t, key) === 'function' ? Reflect.get(t, key).bind(t) : Reflect.get(t, key) }) } as unknown as Env;
  const running = api(`/repos/${r.id}?${mode}`, r.owner, {}, env);
  try { await vi.waitFor(() => expect([...arrived].sort()).toEqual(['readme', 'repo_commit', 'repo_log'])); }
  finally { release(); }
  expect((await running).body.overview.readme.content).toBe('# Before\n');
});

it('keeps grants, revocation and private admission ahead of every bundled content read', async () => {
  const r = await setup('overview_private');
  await api(`/repos/${r.id}?${mode}`, r.owner, {}, on);
  const stranger = { cookie: await signup('overview_stranger') };
  for (const who of [{}, stranger]) {
    expect((await api(`/repos/${r.id}?${mode}`, who, {}, on)).status).toBe(404);
    const hidden = await api(`/resolve/overview_private/project?${mode}`, who, {}, on);
    const missing = await api(`/resolve/overview_private/none?${mode}`, who, {}, on);
    expect([hidden.status, hidden.body]).toEqual([missing.status, missing.body]);
  }
  const token = await api(`/repos/${r.id}/tokens`, r.owner, { body: { name: 'restricted', scopes: ['read'], paths: ['src/'] } }, on);
  const reader = { token: token.body.token };
  const limited = await api(`/repos/${r.id}?${mode}`, reader, {}, on);
  expect(limited.status).toBe(200);
  expect(limited.body.grant).toEqual(['src/']);
  expect(limited.body.overview.tree.entries.map((e: any) => e.name)).toEqual(['src']);
  expect(limited.body.overview.readme).toBeNull();
  expect(JSON.stringify(limited.body)).not.toContain('# Before');
  expect((await api(`/repos/${r.id}/tokens/restricted`, r.owner, { method: 'DELETE' }, on)).status).toBe(200);
  expect((await api(`/repos/${r.id}?${mode}`, reader, {}, on)).status).toBe(401);
});

it('a withheld README fails only that section, with current quarantine applied', async () => {
  const r = await setup('overview_quarantine');
  expect((await api(`/repos/${r.id}?${mode}`, r.owner, {}, on)).body.overview.readme.content).toBe('# Before\n');
  expect((await api(`/repos/${r.id}/quarantine`, r.owner, { body: { path: 'README.md', reason: 'sensitive fixture' } }, on)).status).toBe(200);
  const shown = await api(`/repos/${r.id}?${mode}`, r.owner, {}, on);
  expect(shown.status).toBe(200);
  expect(shown.body.overview).toMatchObject({ tree: { commit: r.commit }, latest: { commit: r.commit }, readme: null, errors: { readme: { code: 'QUARANTINED' } } });
  expect(shown.body.overview.activity.commits).not.toHaveLength(0);
  expect(JSON.stringify(shown.body)).not.toContain('# Before');
});

it('redacts legacy email principals throughout public nested responses', async () => {
  const email = 'overview.public@example.com';
  const token = 'f'.repeat(64);
  await workspace(scoped, email, { op: 'signup', username: email, password: 'long platform test password', salt: '01'.repeat(16), session_hash: await sha(token), recovery_hash: 'b'.repeat(64) });
  const owner = { cookie: `yoneda_account=${encodeAccountIdentifier(email)}.${token}` };
  const made = await api('/repos', owner, { body: { name: 'public', visibility: 'public', files: [file('README.md', '# Public\n')], author, policy: { approvals: 0, required_checks: [] } } }, on);
  expect(made.status).toBe(200);
  const picked = await platformFetch(new Request('https://yoneda/api/auth/handle', { method: 'PUT', headers: { cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'overview_alias' }) }), on);
  expect(picked.status).toBe(200);
  const member = await api(`/repos/${made.body.id}?${mode}`, owner, {}, on);
  expect(member.body.overview.activity.commits[0].principal).toContain(email);
  const byId = await api(`/repos/${made.body.id}?${mode}`, {}, {}, on);
  expect(byId.status).toBe(200);
  expect(byId.body.viewer.public).toBe(true);
  expect(JSON.stringify(byId.body)).not.toContain(email);
  expect(byId.body.overview.latest.principal).not.toContain('@');
  expect(byId.body.overview.activity.commits[0].principal).not.toContain('@');
  const named = await api(`/resolve/overview_alias/public?${mode}`, {}, {}, on);
  expect(named.status).toBe(200);
  expect(named.body.summary.overview.readme.content).toBe('# Public\n');
  expect(JSON.stringify(named.body)).not.toContain(email);
});


it('honors a landing floor while an explicitly selected older commit stays pinned', async () => {
  const r = await setup('overview_floor');
  const made = await api(`/repos/${r.id}/commits`, r.owner, { body: { ref: 'main', changes: [file('README.md', '# Landed\n')], message: 'landed', author } }, on);
  const landed = await api(`/repos/${r.id}/land`, r.owner, { body: { ref: 'main', commit: made.body.commit } }, on);
  expect(landed.status).toBe(200);
  const fresh = await api(`/repos/${r.id}?${mode}&min_version=${landed.body.version}`, r.owner, {}, on);
  expect(fresh.body.overview).toMatchObject({ tree: { commit: made.body.commit }, readme: { content: '# Landed\n' } });
  const old = await api(`/repos/${r.id}?${mode}&commit=${r.commit}&min_version=${landed.body.version}`, r.owner, {}, on);
  expect(old.body.overview).toMatchObject({ tree: { commit: r.commit }, latest: { commit: r.commit }, readme: { commit: r.commit, content: '# Before\n' } });
  const historic = await api(`/repos/${r.id}?${mode}&at=${r.version}&min_version=${landed.body.version}`, r.owner, {}, on);
  expect(historic.body.overview).toMatchObject({ tree: { commit: r.commit }, readme: { content: '# Before\n' } });
});

it('an abandoned first bootstrap does not hold a later request using the same session', async () => {
  const r = await setup('overview_cancel');
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ns = on.SOURCE_REPOS;
  const env = { ...on, SOURCE_REPOS: { idFromName: (name: string) => ns.idFromName(name), get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
    const c = JSON.parse(String(init.body));
    const answer = await ns.get(id).fetch(url, init);
    if (c.op === 'repo_status' && ++started === 1) await gate;
    return answer;
  } }) } } as unknown as Env;
  const controller = new AbortController();
  const first = platformFetch(new Request(`https://yoneda/api/v1/repos/${r.id}?${mode}`, { headers: { cookie: r.owner.cookie }, signal: controller.signal }), env);
  try {
    await vi.waitFor(() => expect(started).toBe(1));
    controller.abort();
    let answer: any;
    const second = api(`/repos/${r.id}?${mode}`, r.owner, {}, env).then((v) => { answer = v; });
    await vi.waitFor(() => expect(answer?.body.overview?.readme?.content).toBe('# Before\n'));
    await second;
  } finally { release(); await first; }
});


it('masks an unexpected section fault without hiding the other Overview content', async () => {
  const r = await setup('overview_failure');
  const ns = on.SOURCE_REPOS;
  const env = { ...on, SOURCE_REPOS: { idFromName: (name: string) => ns.idFromName(name), get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
    const command = JSON.parse(String(init.body));
    if (command.op === 'repo_commit' && !command.brief) throw new Error('simulated internal section detail');
    return ns.get(id).fetch(url, init);
  } }) } } as unknown as Env;
  const response = await api(`/repos/${r.id}?${mode}`, r.owner, {}, env);
  expect(response.status).toBe(200);
  expect(response.body.overview).toMatchObject({ latest: null, tree: { commit: r.commit }, readme: { content: '# Before\n' }, errors: { latest: { code: 'INTERNAL', message: 'Something went wrong on our side.' } } });
  expect(response.body.overview.activity.commits[0].commit).toBe(r.commit);
  expect(JSON.stringify(response.body)).not.toContain('simulated internal section detail');
});

it.each([['on', '', true], ['on', 'off', false], ['on', 'unknown', true], ['off', 'on', false], [undefined, 'on', false]] as const)('gates handle/auth overlap with %s/%s while keeping name/admission after both', async (flag, control, enabled) => {
  const handle = `overlap_${flag ?? 'unset'}_${control || 'plain'}`;
  const r = await setup(handle);
  expect((await api('/orgs', r.owner, { body: { name: `${handle}_org` } }, on)).status).toBe(200);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const orgStarted = new Promise<void>(resolve => { entered = resolve; });
  const calls: string[] = [];
  const namespace = on.WORKSPACES;
  const env = { ...on, OVERVIEW_AUTH_OVERLAP: flag, WORKSPACES: {
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
      const command = JSON.parse(String(init.body)); calls.push(command.op);
      if (command.op === 'org_access') { entered(); await held; }
      return namespace.get(id).fetch(url, init);
    } }),
  } } as unknown as Env;
  const pending = api(`/resolve/${handle}/project?${mode}&auth_overlap=${control}`, r.owner, {}, env);
  let answer: Awaited<typeof pending>;
  try {
    await orgStarted;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls.includes('handle_lookup')).toBe(enabled);
    expect(calls).not.toContain('owned_repo_resolve');
  } finally { release(); answer = await pending; }
  expect(answer.status).toBe(200);
  expect(answer.body.summary.overview.tree.commit).toBe(r.commit);
  expect(calls.filter(op => op === 'session')).toHaveLength(1);
  expect(calls.filter(op => op === 'handle_lookup')).toHaveLength(1);
  expect(calls.filter(op => op === 'owned_repo_resolve')).toHaveLength(1);
});


it('keeps organization refusal ahead of a failed overlapping lookup without resolving names or reading content', async () => {
  const r = await setup('overlap_denial');
  expect((await api('/orgs', r.owner, { body: { name: 'overlap_denial_org' } }, on)).status).toBe(200);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const orgStarted = new Promise<void>(resolve => { entered = resolve; });
  const calls: string[] = [];
  const ns = on.WORKSPACES;
  const env = { ...on, OVERVIEW_AUTH_OVERLAP: 'on', WORKSPACES: {
    idFromName: (name: string) => ns.idFromName(name),
    get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
      const command = JSON.parse(String(init.body)); calls.push(command.op);
      if (command.op === 'handle_lookup') throw new Error('Synthetic handle transport failure');
      if (command.op === 'org_access') { entered(); await held; throw Object.assign(new Error('Organization refused'), { code: 'FORBIDDEN' }); }
      return ns.get(id).fetch(url, init);
    } }),
  } } as unknown as Env;
  const pending = api(`/resolve/overlap_denial/project?${mode}`, r.owner, {}, env);
  await orgStarted;
  await new Promise(resolve => setTimeout(resolve, 0));
  release();
  const answer = await pending;
  expect(answer.status).toBe(403);
  expect(answer.body.error.message).toBe('Organization refused');
  expect(calls.filter(op => op === 'handle_lookup')).toHaveLength(1);
  expect(calls).not.toContain('owned_repo_resolve');
});
