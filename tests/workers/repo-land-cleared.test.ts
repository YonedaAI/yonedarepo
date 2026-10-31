// Land when cleared through the real authority (workerd): what can clear a Landing queues a
// clearance job, the job lands the exact head that cleared, and a Landing it can't land stays
// open with its reason. Off, by the platform's switch or the repository's, nothing moves.
import { expect, it } from 'vitest';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import type { Env, Envelope, Json } from '../../cloudflare/worker/types';
import { api, author, drainObjects, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, LAND_WHEN_CLEARED: 'on' } as unknown as Env;
const JOB = 'platform_land_check';

async function setUp(name: string, env: Env = on) {
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, { body: { name, policy: { approvals: 1, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, env);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const repo = created.body.id as string;
  const mint = async (who: string, scopes: string[]) => (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: who, scopes } }, env)).body.token as string;
  const main = (await api(`/repos/${repo}/refs`, { cookie }, {}, env)).body.refs['refs/heads/main'] as string;
  return { cookie, repo, main, env, agent: await mint('agent', ['read', 'write', 'check']) };
}
type Setup = Awaited<ReturnType<typeof setUp>>;

/** A server-side commit on `branch`, moving it there. */
async function commit(s: Setup, parent: string, expected: string | null, branch: string, files: unknown[]) {
  const made = await api(`/repos/${s.repo}/commits`, { token: s.agent }, { body: { parent, base_version: 1, message: 'work', author, changes: files } }, s.env);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const id = made.body.commit as string;
  const moved = await api(`/repos/${s.repo}/refs/batch`, { token: s.agent }, { body: { updates: [{ ref: branch, commit: id, expected }] } }, s.env);
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  return id;
}

const turnOn = (s: Setup, body: object = { land_when_cleared: true }) => api(`/repos/${s.repo}/auto-landings`, { cookie: s.cookie }, { method: 'PUT', body }, s.env);
const landing = (s: Setup, branch: string) => api(`/repos/${s.repo}/changes`, { token: s.agent }, { body: { branch, title: 'Retry' } }, s.env);
const approve = (s: Setup, id: string) => api(`/repos/${s.repo}/commits/${id}/reviews`, { cookie: s.cookie }, { body: { decision: 'approve' } }, s.env);
const change = async (s: Setup, n = 1) => (await api(`/repos/${s.repo}/changes/${n}`, { cookie: s.cookie }, {}, s.env)).body;
const mainHead = async (s: Setup) => (await api(`/repos/${s.repo}/refs`, { cookie: s.cookie }, {}, s.env)).body.refs['refs/heads/main'] as string;

/** The clearance jobs queued for `s`, taken off the queue. */
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

it('lands the head that cleared, once, as the platform, with its reasons on the record', async () => {
  const s = await setUp('lwc_lands');
  expect((await turnOn(s)).body).toMatchObject({ land_when_cleared: true, findings_block: false });
  const id = await commit(s, s.main, null, 'fix', [file('src/retry.ts', 'export const tries = 2;\n')]);
  expect((await landing(s, 'fix')).status).toBe(200);
  const opened = jobs(s);
  expect(opened.map((j) => j.number)).toEqual([1]);

  // Nothing has cleared it: the job looks and leaves it, and the page says what it waits for.
  expect((await deliver(s.env, opened[0])).acked).toBe(true);
  expect(await mainHead(s)).toBe(s.main);
  const gates = await api(`/repos/${s.repo}/changes/1/gates`, { cookie: s.cookie }, {}, s.env);
  expect(gates.body.land_when_cleared.waiting[0].code).toBe('GATES');

  const reviewed = await approve(s, id);
  expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
  expect(reviewed.body.land_checks, 'clients never see it').toBeUndefined();
  const cleared = jobs(s);
  expect(cleared).toHaveLength(1);
  expect((await deliver(s.env, cleared[0])).acked).toBe(true);
  expect(await mainHead(s)).toBe(id);
  const landed = await change(s);
  expect(landed.status).toBe('landed');
  expect(landed.clearance).toMatchObject({ outcome: 'landed', by: 'platform:land-when-cleared', head: id, approved_by: [`user:lwc_lands`] });
  expect(queued.some((m) => m.kind === 'platform_derive' && m.repo_id === s.repo), 'webhooks fan out from it').toBe(true);

  // A duplicate delivery finds nothing to do.
  expect((await deliver(s.env, cleared[0])).acked).toBe(true);
  expect((await change(s)).clearance.version).toBe(landed.clearance.version);
});

it('merges a Landing whose base moved, on the queue, and the ticket records why', async () => {
  const s = await setUp('lwc_merges');
  await turnOn(s);
  const id = await commit(s, s.main, null, 'fix', [file('src/retry.ts', 'export const tries = 2;\n')]);
  await landing(s, 'fix');
  const other = await commit(s, s.main, null, 'other', [file('src/other.ts', 'export const o = 1;\n')]);
  await approve(s, other);
  const direct = await api(`/repos/${s.repo}/land`, { cookie: s.cookie }, { body: { ref: 'main', commit: other } }, s.env);
  expect(direct.status, JSON.stringify(direct.body)).toBe(200);
  jobs(s);
  await approve(s, id);
  await deliver(s.env, jobs(s)[0]);
  const landed = await change(s);
  expect(landed.status).toBe('landed');
  expect(landed.clearance).toMatchObject({ outcome: 'landed', head: id, by: 'platform:land-when-cleared' });
  expect(await mainHead(s)).not.toBe(other);
});

it('leaves a conflicted Landing open with its reason and never comes back on its own', async () => {
  const s = await setUp('lwc_conflict');
  await turnOn(s);
  const id = await commit(s, s.main, null, 'fix', [file('a.md', 'mine\n')]);
  await landing(s, 'fix');
  const other = await commit(s, s.main, null, 'other', [file('a.md', 'theirs\n')]);
  await approve(s, other);
  await api(`/repos/${s.repo}/land`, { cookie: s.cookie }, { body: { ref: 'main', commit: other } }, s.env);
  jobs(s);
  await approve(s, id);
  const message = await deliver(s.env, jobs(s)[0]);
  expect(message.acked).toBe(true);
  expect(message.retried).toBeUndefined();
  expect(jobs(s), 'a refusal asks for no job').toEqual([]);
  const shown = await change(s);
  expect(shown.status).toBe('open');
  expect(shown.clearance).toMatchObject({ outcome: 'refused', head: id, code: 'CONFLICT' });
  const gates = await api(`/repos/${s.repo}/changes/1/gates`, { cookie: s.cookie }, {}, s.env);
  expect(gates.body.land_when_cleared.refused.reason).toMatch(/a\.md/);
});

it('holds a High Risk head and says why', async () => {
  const s = await setUp('lwc_risk');
  await turnOn(s);
  // Unclassified (30), a workflow and a migration (35) and a lockfile (10).
  const id = await commit(s, s.main, null, 'fix', [
    file('.github/workflows/ci.yml', 'on: push\n'),
    file('migrations/0001.sql', 'select 1;\n'),
    file('pnpm-lock.yaml', 'x\n'),
  ]);
  await landing(s, 'fix');
  jobs(s);
  await approve(s, id);
  await deliver(s.env, jobs(s)[0]);
  const shown = await change(s);
  expect(shown.status).toBe('open');
  expect(shown.clearance).toMatchObject({ outcome: 'refused', code: 'RISK_HIGH', head: id });
  expect(shown.clearance.reason).toMatch(/Risk is High/);
  expect(await mainHead(s)).toBe(s.main);
});

it('with the switch off a repository queues nothing and lands nothing', async () => {
  const s = await setUp('lwc_off');
  const id = await commit(s, s.main, null, 'fix', [file('src/retry.ts', 'export const tries = 2;\n')]);
  await landing(s, 'fix');
  await approve(s, id);
  expect(jobs(s)).toEqual([]);
  // A job from before the switch went off finds nothing to do.
  const stale = { v: 1, kind: JOB, repo_id: s.repo, job_id: '1', number: 1 } as Envelope;
  expect((await deliver(s.env, stale)).acked).toBe(true);
  expect(await mainHead(s)).toBe(s.main);
  expect((await change(s)).status).toBe('open');
});

it('with the platform switch off the repository switch is refused and no job runs', async () => {
  const s = await setUp('lwc_platform_off', scoped);
  const refused = await turnOn(s);
  expect(refused.status).toBe(400);
  expect(refused.body.error.code).toBe('NOT_SUPPORTED');
  // Findings need no job, so that option stands alone.
  expect((await turnOn(s, { findings_block: true })).body).toMatchObject({ findings_block: true, land_when_cleared: false });
  const stale = { v: 1, kind: JOB, repo_id: s.repo, job_id: '1', number: 1 } as Envelope;
  expect((await deliver(scoped, stale)).acked).toBe(true);
});

it('lands a fork\'s newest head only with its own approval', async () => {
  const local = { ...on, PLATFORM_OBJECT_STORE: 'r2', ARTIFACTS: undefined } as unknown as Env;
  const alice = { cookie: await signup('lwc_alice') };
  const bob = { cookie: await signup('lwc_bob') };
  const created = await api('/repos', alice, { body: { name: 'upstream_lwc', policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, local);
  const parent = created.body.id as string;
  await drainObjects(local);
  await api(`/repos/${parent}/members`, alice, { body: { account: 'lwc_bob', role: 'read' } }, local);
  await api(`/repos/${parent}/auto-landings`, alice, { method: 'PUT', body: { land_when_cleared: true } }, local);
  const fork = (await api(`/repos/${parent}/fork`, bob, { body: { name: 'mine_lwc' } }, local)).body.id as string;
  const onFork = async (from: string, expected: string | null) => {
    const made = await api(`/repos/${fork}/commits`, bob, { body: { parent: from, changes: [file('src/fork.ts', `${from}\n`)], message: 'Fork work', author } }, local);
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const moved = await api(`/repos/${fork}/refs/batch`, bob, { body: { updates: [{ ref: 'feature', commit: made.body.commit, expected }] } }, local);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    return made.body.commit as string;
  };
  const first = await onFork(created.body.commit, null);
  const opened = await api(`/repos/${parent}/changes`, bob, { body: { fork, branch: 'feature', title: 'Fork work' } }, local);
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  const mainOf = async () => (await api(`/repos/${parent}/refs`, alice, {}, local)).body.refs['refs/heads/main'] as string;
  const main = await mainOf();
  const wanted = () => {
    const mine = queued.filter((m) => m.kind === JOB && m.repo_id === parent);
    queued.splice(0, queued.length, ...queued.filter((m) => !mine.includes(m)));
    return mine as Envelope[];
  };

  // The rules ask for nothing, and a fork's work is anyone's: it waits for an approval.
  await deliver(local, wanted()[0]);
  expect(await mainOf()).toBe(main);
  const gates = await api(`/repos/${parent}/changes/1/gates`, alice, {}, local);
  expect(gates.body.land_when_cleared.waiting.map((w: Json) => w.code)).toEqual(['FORK_NEEDS_APPROVAL']);

  // Approved, but the fork pushed since: the mirror moves and the approval doesn't follow.
  expect((await api(`/repos/${parent}/commits/${first}/reviews`, alice, { body: { decision: 'approve' } }, local)).status).toBe(200);
  const second = await onFork(first, first);
  await deliver(local, wanted()[0]);
  expect(await mainOf()).toBe(main);
  expect((await api(`/repos/${parent}/changes/1`, alice, {}, local)).body.head).toBe(second);

  expect((await api(`/repos/${parent}/commits/${second}/reviews`, alice, { body: { decision: 'approve' } }, local)).status).toBe(200);
  await deliver(local, wanted().at(-1) as Envelope);
  expect(await mainOf()).not.toBe(main);
  expect((await api(`/repos/${parent}/changes/1`, alice, {}, local)).body.status).toBe('landed');
});

it('asks again for an answer that says nothing about the Landing, a few times', async () => {
  const s = await setUp('lwc_retry');
  await turnOn(s);
  const id = await commit(s, s.main, null, 'fix', [file('src/retry.ts', 'export const tries = 2;\n')]);
  await landing(s, 'fix');
  jobs(s);
  await approve(s, id);
  const job = jobs(s)[0];
  const broken = { ...on, SOURCE_REPOS: { idFromName: () => { throw new Error('authority down'); } } } as unknown as Env;
  const first = await deliver(broken, job, 1);
  expect(first.retried).toEqual({ delaySeconds: 30 });
  const last = await deliver(broken, job, 3);
  expect(last.acked).toBe(true);
  expect(last.retried).toBeUndefined();
  // Gone from the queue, the Landing waits for its next trigger.
  expect((await change(s)).status).toBe('open');
});
