// Global regions stage R1, through the real account and repository authorities and D1 (workerd):
// a new account's region, and where sampled writes come from. Nothing routes on either, and the
// switch off changes nothing. `request.cf` is set by hand here; the service binding itself is
// not simulated (docs/global-scale-plan.md has that spike). Simulated Analytics Engine binding.
import { expect, it, vi } from 'vitest';
import accountsTable from '../../cloudflare/migrations/0009_platform_accounts.sql?raw';
import region from '../../cloudflare/migrations/0012_platform_account_region.sql?raw';
import { accountRoute } from '../../cloudflare/worker/accounts';
import { noteSeen, recordAccount } from '../../cloudflare/worker/account-index';
import { accountCreated, backfillAccounts } from '../../cloudflare/worker/platform-accounts';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { trafficQueries } from '../../cloudflare/worker/platform-traffic-queries';
import { noteWriter, watchWrites } from '../../cloudflare/worker/platform-write-origin';
import { compute } from '../../cloudflare/worker/repo-compute';
import { fromBase64, toBase64 } from '../../cloudflare/worker/repo-objects';
import { sha } from '../../cloudflare/worker/storage';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { blob, commitObject, tree } from './pushed-history';
import { api, author, bindings, file, scoped, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

/** The front Worker's environment; the stand-in for its binding runs the platform's real
 * method, over RPC in production, so `details` is all it gets. */
function front(extra: Partial<Env> = {}): Env {
  const target = { ...scoped, REGION_SIGNALS: 'on', ...extra } as Env;
  target.PLATFORM = {
    accountCreated: (account: string, details: object) => accountCreated(target, account, details),
  } as unknown as Env['PLATFORM'];
  return target;
}
const signUp = async (name: string, target: Env, cf?: object) => {
  const answer = (await accountRoute(
    new Request('https://yoneda/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${name}@example.com`, password: 'long platform test password' }),
      cf,
    } as RequestInit),
    target,
  )) as Response;
  expect(answer.status).toBe(200);
  return (answer.headers.get('set-cookie') ?? '').split(';')[0];
};
const rowRegion = async (name: string) =>
  (await bindings.INDEX.prepare('SELECT region FROM platform_accounts WHERE account=?').bind(name).first<any>())
    ?.region;
const stored = async (name: string) => (await workspace(bindings, name, { op: 'account_summary' })).region;

it.each([
  ['AF', 'afr'],
  ['AS', 'apac'],
  ['EU', 'weur'],
  ['NA', 'enam'],
  ['OC', 'oc'],
  ['SA', 'sam'],
])('records a sign-up from %s as %s, on the authority and the index', async (continent, code) => {
  await signUp('someone', front(), { continent, city: 'Paris', country: 'FR' });
  expect(await stored('someone')).toBe(code);
  expect(await rowRegion('someone')).toBe(code);
  const row = await bindings.INDEX.prepare('SELECT * FROM platform_accounts WHERE account=?').bind('someone').first();
  expect(JSON.stringify(row)).not.toMatch(/Paris|FR/);
});

it.each([
  ['the switch off', { REGION_SIGNALS: 'off' }, { continent: 'EU' }],
  ['no switch', { REGION_SIGNALS: undefined }, { continent: 'EU' }],
  ['no request.cf', {}, undefined],
  ['Tor', {}, { continent: 'T1' }],
  ['Antarctica', {}, { continent: 'AN' }],
  ['an unknown continent', {}, { continent: 'XX' }],
  ['a continent that is no text', {}, { continent: 7 }],
  ['a code in the place of a continent', {}, { continent: 'weur' }],
  ['an inherited key', {}, { continent: 'constructor' }],
])('leaves an account signed up with %s as enam, storing nothing', async (_what, extra, cf) => {
  await signUp('someone', front(extra as Partial<Env>), cf);
  expect(await stored('someone')).toBeUndefined();
  expect(await rowRegion('someone')).toBe('enam');
});

it('takes a region only from a platform whose switch is on, and only a known one', async () => {
  const on = { ...scoped, REGION_SIGNALS: 'on' } as Env;
  await accountCreated({ ...scoped, REGION_SIGNALS: 'off' } as Env, 'off_platform', { region: 'weur' });
  await accountCreated(on, 'unknown_code', { region: 'mars' });
  await accountCreated(on, 'older_front');
  await accountCreated(on, 'known_code', { region: 'weur' });
  expect(await rowRegion('off_platform')).toBe('enam');
  expect(await rowRegion('unknown_code')).toBe('enam');
  expect(await rowRegion('older_front')).toBe('enam');
  expect(await rowRegion('known_code')).toBe('weur');
});

it("rebuilds an index row with the authority's region", async () => {
  const target = front();
  const cookie = await signUp('rebuilt', target, { continent: 'EU' });
  await api('/repos', { cookie }, { body: { name: 'r1', files: [file('a', 'a\n')], author } }, target);
  await bindings.INDEX.prepare('DELETE FROM platform_accounts').run();
  expect(await backfillAccounts(target)).toMatchObject({ added: 1 });
  expect(await rowRegion('rebuilt')).toBe('weur');

  await bindings.INDEX.prepare('DELETE FROM platform_accounts').run();
  // A later day: the session check above already noted today.
  noteSeen(target, 'rebuilt', Date.now() + 2 * 24 * 60 * 60 * 1000);
  await vi.waitFor(async () => expect(await rowRegion('rebuilt')).toBe('weur'));
});

it('gives a row from before the column enam, and a row writer without a region still works', async () => {
  const statements = (sql: string) =>
    sql
      .split(';')
      .map((s) => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  await bindings.INDEX.exec('DROP TABLE platform_accounts');
  for (const statement of statements(accountsTable)) await bindings.INDEX.exec(statement);
  await recordAccount(scoped, 'older', 'email', 1); // today's statement, on today's schema
  for (const statement of statements(region)) await bindings.INDEX.exec(statement);
  expect(await rowRegion('older')).toBe('enam');
  await recordAccount(scoped, 'newer', 'email', 2, 'apac');
  expect(await rowRegion('newer')).toBe('apac');
});

// Where writes come from.

function sampling(extra: Partial<Env> = {}) {
  const points: AnalyticsEngineDataPoint[] = [];
  const env = {
    ...scoped,
    REGION_SIGNALS: 'on',
    SITE_EVENTS: { writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p) },
    ...extra,
  } as unknown as Env;
  return { env, points };
}
const always = () => vi.spyOn(Math, 'random').mockReturnValue(0.05);
const write = (path: string, headers: Record<string, string>, body: unknown, cf?: object) =>
  new Request(`https://yoneda/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    cf,
  } as RequestInit);
const repoBody = (name: string) => ({ name, policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author });
const digest = async (id: string) => (await sha(id)).slice(0, 32);
const fields = ({ indexes, blobs, doubles }: AnalyticsEngineDataPoint) => ({
  index: indexes?.[0],
  event: blobs?.[0],
  client: blobs?.[10],
  operation: blobs?.[11],
  continent: blobs?.[12],
  kind: blobs?.[13],
  weight: doubles?.[2],
});
async function account(name: string) {
  const cookie = await signUp(name, front());
  const created = await api('/repos', { cookie }, { body: repoBody(`${name}_repo`) });
  expect(created.status).toBe(200);
  return { cookie, repo: created.body.id as string };
}

it("counts a browser session's write under a digest of its account, from its continent", async () => {
  const { cookie } = await account('writer_one');
  const { env, points } = sampling();
  always();
  const res = await platformFetch(write('/repos', { cookie }, repoBody('second'), { continent: 'EU', city: 'Paris', country: 'FR' }), env);
  expect(res.status).toBe(200);
  expect(points.map(fields)).toEqual([
    {
      index: await digest('writer_one'),
      event: 'write_origin',
      client: 'browser',
      operation: 'write',
      continent: 'EU',
      kind: 'account',
      weight: 10,
    },
  ]);
  const held = JSON.stringify(points);
  expect(held).not.toMatch(/writer_one|Paris|FR|yoneda_account/);
});

it('counts a personal token under its account, and a repository token under its repository', async () => {
  const { cookie, repo } = await account('writer_two');
  const pat = (await api('/tokens', { cookie }, { body: { name: 'cli', scopes: ['repo:read', 'repo:write'] } })).body.token;
  const scopedToken = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'bot', scopes: ['read', 'write', 'land'] } })).body.token;
  const { env, points } = sampling();
  always();
  const main = (await api(`/repos/${repo}/refs`, { cookie })).body.refs['refs/heads/main'];
  const branch = (token: string, ref: string) =>
    platformFetch(
      write(`/repos/${repo}/branches`, { authorization: `Bearer ${token}` }, { ref, commit: main, expected: null }, { continent: 'AS' }),
      env,
    );
  const first = await branch(pat, 'from_pat');
  const second = await branch(scopedToken, 'from_repo_token');
  expect([first.status, second.status]).toEqual([200, 200]);
  expect(points.map(fields)).toEqual([
    expect.objectContaining({ index: await digest('writer_two'), client: 'token', continent: 'AS', kind: 'account' }),
    expect.objectContaining({ index: await digest(repo), client: 'token', continent: 'AS', kind: 'repo' }),
  ]);
  expect(JSON.stringify(points)).not.toContain(repo);
});

it('counts a Git push, whose credentials are read from a rebuilt request', async () => {
  const { cookie, repo } = await account('writer_three');
  const { token } = (await api('/tokens', { cookie }, { body: { name: 'git', scopes: ['repo:read', 'repo:write'] } })).body;
  const main = (await api(`/repos/${repo}/refs`, { cookie })).body.refs['refs/heads/main'] as string;
  const b = await blob('pushed\n');
  const root = await tree([['100644', 'pushed.md', b.id]]);
  const commit = await commitObject(root.id, main, 1);
  const { push_b64 } = compute({
    op: 'branch_push',
    refname: 'refs/heads/pushed',
    old: null,
    new: commit.id,
    objects: [commit, root, b].map((o) => ({ id: o.id, kind: o.kind, data_b64: toBase64(o.data) })),
  });
  const { env, points } = sampling();
  always();
  const res = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/git-receive-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token}`)}` },
      body: fromBase64(push_b64),
      cf: { continent: 'OC' },
    } as RequestInit),
    env,
  );
  expect(new TextDecoder().decode(await res.arrayBuffer())).toContain('ok refs/heads/pushed');
  expect(points.map(fields)).toEqual([
    expect.objectContaining({ index: await digest('writer_three'), client: 'git', operation: 'push', continent: 'OC' }),
  ]);
});

it.each([
  ['no request.cf', undefined],
  ['Tor', { continent: 'T1' }],
  ['an unknown continent', { continent: 'XX' }],
  ['a continent that is no text', { continent: 7 }],
])('keeps a write with %s as an empty continent, which shows how often it happens', async (_what, cf) => {
  const { cookie } = await account('writer_four');
  const { env, points } = sampling();
  always();
  await platformFetch(write('/repos', { cookie }, repoBody('second'), cf), env);
  expect(points.map(fields)).toEqual([expect.objectContaining({ continent: '', kind: 'account' })]);
});

it('counts nothing with the switch off, unsampled, or for traffic it must not see', async () => {
  const { cookie } = await account('writer_five');
  const { env, points } = sampling();
  const random = always();
  const quiet: [Partial<Env>, Record<string, string>][] = [
    [{ REGION_SIGNALS: 'off' }, {}],
    [{ REGION_SIGNALS: undefined }, {}],
    [{}, { 'x-yoneda-own-traffic': '1' }],
  ];
  let n = 0;
  for (const [extra, headers] of quiet) {
    const res = await platformFetch(write('/repos', { cookie, ...headers }, repoBody(`quiet${n++}`), { continent: 'EU' }), { ...env, ...extra } as Env);
    expect(res.status).toBe(200);
  }
  random.mockReturnValue(0.1); // exactly one tenth is the first value left out
  await platformFetch(write('/repos', { cookie }, repoBody('unsampled'), { continent: 'EU' }), env);
  expect(points).toEqual([]);
});

it('leaves Git over SSH out: its requests carry the gateway, not the client', async () => {
  const { env, points } = sampling();
  const repo = 'r0123456789abcdef0123';
  const session = { workspace: 'ssh_user', principal: 'user:ssh_user' };
  const run = vi.fn(async () => {
    noteWriter({ _session: session }, repo); // a real push names its writer
    return new Response('{}');
  });
  const req = new Request(`https://platform.internal/git/${repo}.git/git-receive-pack`, {
    method: 'POST',
    headers: { authorization: 'Bearer ysh_session' },
    cf: { continent: 'NA' },
  } as RequestInit);
  await watchWrites(req, env, run, () => 0);
  expect(run).toHaveBeenCalledOnce();
  expect(points).toEqual([]);
});

it('does no sampling work on a read, and a read that is sampled by chance counts nothing', async () => {
  const { cookie, repo } = await account('reader');
  const { env, points } = sampling();
  const random = vi.fn(() => 0);
  const run = async () => new Response('{}');
  for (const method of ['GET', 'HEAD'])
    await watchWrites(new Request('https://yoneda/api/v1/repos', { method }), env, run, random);
  expect(random).not.toHaveBeenCalled();
  // A POST that only reads: the object page, whose commands keep refs.
  always();
  const res = await platformFetch(write(`/repos/${repo}/objects`, { cookie }, { ids: [] }, { continent: 'EU' }), env);
  expect(res.status).toBeLessThan(500);
  expect(points).toEqual([]);
});

it('counts no refused write', async () => {
  const { cookie, repo } = await account('owner_refused');
  const stranger = await signUp('stranger', front());
  const { env, points } = sampling();
  always();
  const main = (await api(`/repos/${repo}/refs`, { cookie })).body.refs['refs/heads/main'];
  const body = { ref: 'x', commit: main, expected: null };
  const path = `/repos/${repo}/branches`;
  const denied = await platformFetch(write(path, { cookie: stranger }, body, { continent: 'EU' }), env);
  const forged = await platformFetch(write(path, { authorization: 'Bearer yrp_forged' }, body, { continent: 'EU' }), env);
  expect(denied.status).toBeGreaterThanOrEqual(400);
  expect(forged.status).toBeGreaterThanOrEqual(400);
  expect(points).toEqual([]);
});

it('changes no response when the dataset fails or is missing', async () => {
  const { cookie } = await account('writer_six');
  always();
  const failing = { writeDataPoint: () => { throw new Error('dataset down'); } };
  const one = await platformFetch(write('/repos', { cookie }, repoBody('a1'), { continent: 'EU' }), sampling({ SITE_EVENTS: failing as unknown as Env['SITE_EVENTS'] }).env);
  const two = await platformFetch(write('/repos', { cookie }, repoBody('a2'), { continent: 'EU' }), sampling({ SITE_EVENTS: undefined }).env);
  expect([one.status, two.status]).toEqual([200, 200]);
});

it('adds nothing to the Traffic page: every report picks its events by name', () => {
  for (const window of [7, 30] as const)
    for (const who of ['humans', 'agents', 'bots'] as const)
      for (const sql of Object.values(trafficQueries('events', window, who))) {
        expect(sql).toMatch(/blob1 (=|IN)/);
        expect(sql).not.toContain('write_origin');
      }
});
