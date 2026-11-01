// The real-use simulation's request forms through the real platform routes, Durable Objects and
// Git endpoints (workerd), with the regional client's own step runner: each script's steps are
// real requests a real route answers, and a form that went stale fails here, not an hour into a
// live run. Artifacts and queues are the fixture's fakes; no latency here means anything.
import { afterEach, expect, it, vi } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { runArm } from '../../tools/fanout-bench/region-matrix.mjs';
import { DEFAULTS, seedBlobs, seedFiles } from '../../tools/fanout-bench/region-plan.mjs';
import { runSteps } from '../../tools/fanout-bench/region-steps.js';
import { Actor } from '../../tools/real-use/actor.mjs';
import { randomStream } from '../../tools/real-use/plan.mjs';
import { REPO_SCOPES } from '../../tools/real-use/population.mjs';
import { failed } from '../../tools/real-use/run.mjs';
import { SCRIPTS } from '../../tools/real-use/sessions.mjs';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, fakeCombiners, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
afterEach(() => vi.unstubAllGlobals());

const b64 = (text: string) => btoa(text);
const live = { ...scoped, ACCOUNT_SEARCH: 'on' } as unknown as Env;

async function world() {
  const [owner, reviewer] = [await signup('realuseowner'), await signup('realusereview')];
  const name = 'real-use-0-0';
  const seed = seedFiles(name, 6) as Record<string, string>;
  const made = await api('/repos', { cookie: owner }, { body: { name, policy: { approvals: 0, required_checks: [] }, files: Object.entries(seed).map(([path, text]) => ({ path, content_b64: b64(text) })), author, message: 'Seed' } });
  expect(made.status).toBe(200);
  const id = made.body.id as string;
  expect((await api(`/repos/${id}/members`, { cookie: owner }, { body: { account: 'realusereview', role: 'land' } })).status).toBe(200);
  const { token } = (await api(`/repos/${id}/tokens`, { cookie: owner }, { body: { name: 'sim', scopes: REPO_SCOPES } })).body;
  const pat = (await api('/tokens', { cookie: owner }, { body: { name: 'sim', scopes: ['repo:read', 'repo:write', 'repo:land', 'repo:review', 'repo:admin'], expires_days: 1 } })).body.token;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => platformFetch(new Request(url, init), live));
  const repo = { id, name, owner: 0, seed_commit: made.body.commit, files: 6, paths: Object.keys(seed), blobs: seedBlobs(name, 6) };
  return { repo, owner, reviewer, token, pat };
}

/** Plays `kind` `times`, as the runner would, with no think time: its rows. */
async function play(kind: keyof typeof SCRIPTS, who: object, repo: object, times = 12) {
  const rows: any[] = [];
  const run = {
    send: async (_region: string, target: string, steps: any[], parallel: boolean) => ({ results: await runSteps(target, steps, parallel) }),
    note: (row: any) => rows.push(row),
    wait: async () => {},
  };
  for (let i = 0; i < times; i++) {
    const actor = new Actor({ run, kind, region: 'na', who: 'x', repo, random: randomStream(i + 1), assets: [], target: 'https://yoneda', ...who });
    await SCRIPTS[kind](actor as never);
  }
  return rows;
}

// The fixture has no static assets, and `failed` is what the simulation itself counts.
const wrong = (rows: any[]) => [...new Set(rows.filter((r) => failed(r) && r.label !== 'page.html').map((r) => `${r.label} ${r.status} ${r.error} ${r.message ?? ''}`))];

it('an agent session goes from reading to an open Landing, and sometimes lands it', async () => {
  const { repo, token } = await world();
  const rows = await play('agent', { credential: token }, repo);
  expect(wrong(rows)).toEqual([]);
  const labels = new Set(rows.map((r) => r.label));
  for (const label of ['repo.refs', 'memories', 'context', 'repo.tree', 'blob', 'search.repo', 'branch', 'commit', 'session', 'check', 'change.open', 'land']) expect(labels).toContain(label);
});

it('a person browses, searches and reviews what agents opened', async () => {
  const { repo, owner, reviewer, token } = await world();
  await play('agent', { credential: token }, repo, 4);
  const person = { cookie: owner, reviewer };
  for (const kind of ['browse', 'search', 'review'] as const) expect(wrong(await play(kind, person, repo))).toEqual([]);
  await play('agent', { credential: token }, repo, 4);
  const reviewed = (await play('review', person, repo)).map((r) => r.label);
  for (const label of ['change.page', 'review', 'change.gates']) expect(reviewed).toContain(label);
});

it('an MCP session answers every call with a result', async () => {
  const { repo, pat } = await world();
  const rows = await play('mcp', { credential: pat }, repo);
  expect(wrong(rows)).toEqual([]);
  expect(rows.filter((r) => r.label === 'mcp.call').length).toBeGreaterThan(10);
});

it('the clone and push forms get a pack and a push report, as Git would', async () => {
  const { repo, token } = await world();
  const rows = await play('git', { credential: token }, repo);
  expect(wrong(rows)).toEqual([]);
  const labels = rows.map((r) => r.label);
  for (const label of ['clone.refs', 'clone.ls', 'clone.pack', 'push.refs', 'push.pack']) expect(labels).toContain(label);
  const refs = (await api(`/repos/${repo.id}/refs`, { token })).body.refs;
  expect(Object.keys(refs).some((ref) => ref.startsWith('refs/heads/ci/'))).toBe(true);
});

const armOptions = { ...DEFAULTS, reads: 3, clones: 2, lands: 2, pushes: 2, searches: 2, pages: 1, signIns: 1, files: 6 };

/** A client that runs each step in this workerd, as the regional client would. */
async function armWorld(target: Env, name: string) {
  const cookie = await signup(name);
  const pat = (await api('/tokens', { cookie }, { body: { name: 'matrix', scopes: ['repo:read', 'repo:write', 'repo:land', 'repo:admin'], expires_days: 1 } })).body.token;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => platformFetch(new Request(url, init), target));
  const call = async (_client: string, { steps }: { steps: any[] }) => ({ results: await runSteps('https://yoneda', steps) });
  const account = { signIn: async () => ({ row: { label: 'sign_in', ok: true, status: 200, ms: 1, server: null } }) };
  return { call, front: call, pat, account };
}

it('one arm of the same-region test runs its whole sequence and keeps no token', async () => {
  const where = { ...fakeCombiners, get: (name: string) => ({ ...fakeCombiners.get(name), where: async () => 'TST' }) };
  const hinted = { ...scoped, REGION_HINT_TEST: 'on', ACCOUNT_SEARCH: 'on', LAND_COMBINERS: where } as unknown as Env;
  const world = await armWorld(hinted, 'matrixowner');
  const repos: { id: string; name: string }[] = [];
  const ledger = { add: async (r: { id: string; name: string }) => void repos.push(r) };
  const arm = await runArm({ ...world, ledger, assets: [] }, { stamp: 'test', run: 1, client: 'eu', arm: { arm: 'region', data: 'weur', serve: 'weur' }, options: armOptions });
  expect(arm.failed).toBeUndefined();
  expect(arm.stop).toBeUndefined();
  expect(repos.map((r) => r.name)).toEqual(['region-hint-test-1-eu-region']);
  expect(arm.where).toMatchObject({ combiner: 'TST' });
  const failed = Object.values(arm.ops as Record<string, any[]>).flat().filter((r) => !r.ok);
  expect(failed.map((r) => `${r.label} ${r.status} ${r.error} ${r.message}`)).toEqual([]);
  expect(Object.keys(arm.ops).sort()).toEqual(['clone', 'commit', 'create', 'land', 'list', 'push', 'read_pat', 'read_token', 'search', 'sign_in']);
  expect(arm.ops.push).toHaveLength(2);
  // The create's answer carries a token; a sample never does.
  expect(JSON.stringify(arm)).not.toMatch(/yrp_|ypat_/);
});

it('a test stops rather than measure a platform that ignored the hint', async () => {
  const world = await armWorld(scoped, 'matrixoff');
  const arm = await runArm({ ...world, ledger: { add: async () => {} }, assets: [] }, { stamp: 'off', run: 1, client: 'na', arm: { arm: 'today', data: 'enam' }, options: { ...armOptions, pages: 0, files: 2 } });
  expect(arm.stop).toMatch(/REGION_HINT_TEST is off/);
});
