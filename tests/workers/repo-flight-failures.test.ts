// The Flight Path's failure cases the live kit can't force (tools/staging/flight-failures-flow.mjs
// runs the rest): a repository at its storage limit, since no test fills 9 GB, and a clearance job
// delivered again and again, since a live queue redelivers only when it chooses to.
import { expect, it } from 'vitest';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { api, author, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, LAND_WHEN_CLEARED: 'on' } as unknown as Env;
/** A limit every database is over (repo-storage-guard.test.ts). */
const full = { ...on, REPO_STORAGE_GUARD: '1' } as unknown as Env;
const JOB = 'platform_land_check';

async function setUp(name: string) {
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, { body: { name, policy: { approvals: 1, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, on);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const repo = created.body.id as string;
  const minted = await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'agent', scopes: ['read', 'write'] } }, on);
  const main = (await api(`/repos/${repo}/refs`, { cookie }, {}, on)).body.refs['refs/heads/main'] as string;
  await api(`/repos/${repo}/auto-landings`, { cookie }, { method: 'PUT', body: { land_when_cleared: true } }, on);
  return { cookie, repo, main, agent: minted.body.token as string };
}
type Setup = Awaited<ReturnType<typeof setUp>>;

async function branch(s: Setup, name: string, path: string) {
  const made = await api(`/repos/${s.repo}/commits`, { token: s.agent }, { body: { parent: s.main, base_version: 1, message: name, author, changes: [file(path, `${name}\n`)] } }, on);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const id = made.body.commit as string;
  await api(`/repos/${s.repo}/refs/batch`, { token: s.agent }, { body: { updates: [{ ref: name, commit: id, expected: null }] } }, on);
  return id;
}
const open = (s: Setup, name: string) => api(`/repos/${s.repo}/changes`, { token: s.agent }, { body: { branch: name, title: name } }, on);
const approve = (s: Setup, id: string) => api(`/repos/${s.repo}/commits/${id}/reviews`, { cookie: s.cookie }, { body: { decision: 'approve' } }, on);
const change = async (s: Setup, n: number) => (await api(`/repos/${s.repo}/changes/${n}`, { cookie: s.cookie }, {}, on)).body;
const head = async (s: Setup) => (await api(`/repos/${s.repo}/refs`, { cookie: s.cookie }, {}, on)).body.refs['refs/heads/main'] as string;

function jobs(s: Setup) {
  const mine = queued.filter((m) => m.kind === JOB && m.repo_id === s.repo);
  queued.splice(0, queued.length, ...queued.filter((m) => !mine.includes(m)));
  return mine as Envelope[];
}

async function deliver(env: Env, body: Envelope, attempts = 1) {
  const message = { body, attempts, acked: false, retried: undefined as unknown, ack() { this.acked = true; }, retry(o: unknown) { this.retried = o ?? true; } };
  await platformJob(env, message as unknown as Message<Envelope>);
  return message;
}

it('holds a cleared Landing at the storage limit, and the next job lands it with room again', async () => {
  const s = await setUp('flight_full');
  const id = await branch(s, 'fix', 'src/fix.ts');
  const { number } = (await open(s, 'fix')).body;
  await approve(s, id);
  const [job] = jobs(s);
  expect((await deliver(full, job)).acked).toBe(true);
  const held = await change(s, number);
  expect(held.status).toBe('open');
  expect(held.clearances[0]).toMatchObject({ decision: 'hold', head: id });
  expect(held.clearances[0].reasons.map((r: { code: string }) => r.code)).toContain('REPO_FULL');
  expect(await head(s)).toBe(s.main);
  await deliver(on, job);
  expect((await change(s, number)).status).toBe('landed');
});

it('lands once however often its job comes, straight onto the head', async () => {
  const s = await setUp('flight_again');
  const id = await branch(s, 'fix', 'src/fix.ts');
  const { number } = (await open(s, 'fix')).body;
  await approve(s, id);
  const [job] = jobs(s);
  await Promise.all([1, 2, 3].map((attempts) => deliver(on, job, attempts)));
  await deliver(on, job, 4);
  const landed = await change(s, number);
  expect(landed.status).toBe('landed');
  expect(landed.clearances.filter((c: { landed_version: number | null }) => c.landed_version !== null)).toHaveLength(1);
  expect(await head(s)).toBe(id);
});

it('lands once however often its job comes, through the queue', async () => {
  const s = await setUp('flight_queue');
  const id = await branch(s, 'fix', 'src/fix.ts');
  const { number } = (await open(s, 'fix')).body;
  const other = await branch(s, 'other', 'src/other.ts');
  await approve(s, other);
  const direct = await api(`/repos/${s.repo}/land`, { cookie: s.cookie }, { body: { ref: 'main', commit: other } }, on);
  expect(direct.status, JSON.stringify(direct.body)).toBe(200);
  jobs(s);
  await approve(s, id);
  const [job] = jobs(s);
  await Promise.all([1, 2, 3].map((attempts) => deliver(on, job, attempts)));
  const landed = await change(s, number);
  expect(landed.status).toBe('landed');
  await deliver(on, job, 4);
  const after = await change(s, number);
  expect(after.clearances.filter((c: { landed_version: number | null }) => c.landed_version !== null)).toHaveLength(1);
  expect(after.landed_version).toBe(landed.landed_version);
});
