// An operator setting one corrupt audit event aside, through the API `cargo xtask admin
// audit-set-aside` calls: it refuses a healthy event, says nothing of what the row held, leaves
// a trail in the org's log and the operators' audit, and the log and a blocked erase move on.
import { env as bindings, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import { caller } from '../../cloudflare/worker/repo-ops';
import type { Env, Json } from '../../cloudflare/worker/types';
import { auditLog } from '../../cloudflare/worker/workspace';
import { api, author, delayed, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const on = { ...scoped, ADMIN_ACCOUNTS: 'audit_operator', REPO_ERASE: 'on', AUDIT_LOG: 'on' } as unknown as Env;
const holds = { ...on, LEGAL_HOLD: 'on' } as unknown as Env;
const logOff = { ...on, AUDIT_LOG: 'off' } as unknown as Env;
const policy = { required_checks: [], approvals: 0 };
const SECRET = 'hunter2-not-for-any-answer';
const GOOD = JSON.stringify({ visibility: 'public', name: 'app', actor: 'user:x', at: 5 });
type Auth = { cookie: string };

const authority = (repo: string) => bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(repo));
const waiting = (repo: string) =>
  runInDurableObject(authority(repo), (_, state) =>
    state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM hook_outbox').one().n,
  );
/** Adds rows to the outbox, answering their seqs. */
const planted = (repo: string, ...payloads: string[]) =>
  runInDurableObject(authority(repo), (_, state) =>
    payloads.map((payload) =>
      state.storage.sql
        .exec<{ seq: number }>("INSERT INTO hook_outbox(hook_id,event,payload) VALUES(0,'repo.visibility_changed',?) RETURNING seq", payload)
        .one().seq,
    ),
  );
const CORRUPT = `{"token":"${SECRET}"`;

async function setup(target = on) {
  const who = { cookie: await signup('audit_owner') };
  await api('/orgs', who, { body: { name: 'acme' } }, target);
  const made = await api('/repos', who, { body: { name: 'app', policy, files: [file('a.md', 'a\n')], author, owner: 'acme' } }, target);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return { who, id: made.body.id as string, ops: { cookie: await signup('audit_operator') } };
}
const path = (id: string) => `/admin/repos/${id}/audit-set-aside`;
const dryRun = (id: string, ops: Auth, seq: number, target = on) => api(path(id), ops, { body: { seq, dry_run: true } }, target);
const setAside = (id: string, ops: Auth, seq: number, bytes: unknown, target = on) => api(path(id), ops, { body: { seq, bytes } }, target);
const repoRows = async (org: string) => {
  const { items } = await auditLog(on, org, { op: 'audit_read' });
  return (items as Json[]).filter((row) => row.source.startsWith('repo:')).reverse();
};
const kinds = (rows: Json[]) => rows.map((row) => row.kind);
const trail = async (id: string) => {
  const rows = await bindings.INDEX.prepare("SELECT actor,target,detail FROM admin_audit WHERE action='repo.audit_row_set_aside' AND target=? ORDER BY id").bind(id).all<any>();
  return rows.results.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
};
const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

async function deliver(repo: string, target: Env) {
  for (let turn = 0; turn < 50; turn++) {
    const jobs = queued.filter((m) => ['platform_purge', 'platform_erase'].includes(m.kind) && m.repo_id === repo);
    if (jobs.length === 0) return;
    queued.splice(0, queued.length, ...queued.filter((m) => !jobs.includes(m)));
    for (const body of jobs) await platformJob(target, { body, attempts: 1, ack() {}, retry() {} } as unknown as Message<any>);
  }
  throw new Error('the jobs never finished');
}
function due(repo: string) {
  const later = delayed.filter((m) => m.repo_id === repo);
  delayed.splice(0, delayed.length, ...delayed.filter((m) => !later.includes(m)));
  queued.push(...later);
  return later;
}
const erased = async (repo: string) =>
  (await caller(on, repo, { _system: 'erase' })({ op: 'repo_erase_plan' })).erased === true;

it('only an operator gets in, and what it says is shaped', async () => {
  const { who, id, ops } = await setup();
  const [seq] = await planted(id, CORRUPT);
  expect((await dryRun(id, who, seq)).status).toBe(403);
  expect((await setAside(id, who, seq, CORRUPT.length)).status).toBe(403);
  for (const body of [{ seq: 0, dry_run: true }, { seq: -1, dry_run: true }, { seq: 'x', dry_run: true }, { seq: 1.5, dry_run: true }, { dry_run: true }]) {
    const bad = await api(path(id), ops, { body }, on);
    expect([bad.status, bad.body.error.code], JSON.stringify(body)).toEqual([400, 'INVALID_INPUT']);
  }
  const badSize = await setAside(id, ops, seq, 'not a size');
  expect([badSize.status, badSize.body.error.code]).toEqual([400, 'INVALID_INPUT']);
  expect((await api('/admin/repos/nope/audit-set-aside', ops, { body: { seq, dry_run: true } }, on)).status).toBe(404);
  expect(await trail(id)).toEqual([]);
});

it('a dry run names the row and writes nothing, and no answer quotes it', async () => {
  const { id, ops } = await setup();
  const [seq] = await planted(id, CORRUPT);
  const asked = await dryRun(id, ops, seq);
  expect(asked.status, JSON.stringify(asked.body)).toBe(200);
  expect(asked.body).toMatchObject({ state: 'corrupt', seq, kind: 'repo.visibility_changed', bytes: CORRUPT.length });
  expect(JSON.stringify(asked.body)).not.toContain('hunter2');
  expect(await waiting(id)).toBe(1);
  expect(await trail(id)).toEqual([]);
});

it('a healthy event is refused, the refusal is on record, and the event still reaches the log', async () => {
  const { who, id, ops } = await setup();
  const [seq] = await planted(id, GOOD);
  const asked = await dryRun(id, ops, seq);
  expect([asked.status, asked.body.error.code]).toEqual([409, 'CONFLICT']);
  const refused = await setAside(id, ops, seq, GOOD.length);
  expect([refused.status, refused.body.error.code]).toEqual([409, 'CONFLICT']);
  expect(await waiting(id)).toBe(1);
  expect((await trail(id)).map((r) => r.detail)).toEqual([{ seq, bytes: GOOD.length, failed: 'CONFLICT' }]);
  await api(`/repos/${id}/visibility`, who, { method: 'PUT', body: { visibility: 'public' } }, on);
  expect(kinds(await repoRows('acme'))).toEqual(['repo.created', 'repo.visibility_changed', 'repo.visibility_changed']);
});

it('set aside, the repair is in the org log in the row\'s place, and on the operators\' record', async () => {
  const { who, id, ops } = await setup();
  const [, seq] = await planted(id, GOOD, CORRUPT, GOOD);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await api(`/repos/${id}/visibility`, who, { method: 'PUT', body: { visibility: 'public' } }, on);
  expect(kinds(await repoRows('acme'))).toEqual(['repo.created', 'repo.visibility_changed']);
  const { bytes } = (await dryRun(id, ops, seq)).body;
  const done = await setAside(id, ops, seq, bytes);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body).toMatchObject({ state: 'set_aside', seq, kind: 'repo.visibility_changed', bytes: CORRUPT.length });

  // The copy went at once, the row's place kept, and what was stuck behind it came along.
  const rows = await repoRows('acme');
  expect(kinds(rows)).toEqual(['repo.created', 'repo.visibility_changed', 'audit.row_set_aside', 'repo.visibility_changed', 'repo.visibility_changed']);
  const marker = rows[2];
  expect(marker.actor).toBe('operator:audit_operator');
  expect(marker.details).toEqual({ repo: id, name: 'app', row: seq, of_kind: 'repo.visibility_changed', bytes: CORRUPT.length });
  expect(marker.source_seq).toBe(seq);
  expect(await waiting(id)).toBe(0);
  expect((await auditLog(on, 'acme', { op: 'audit_verify' })).ok).toBe(true);
  expect((await trail(id)).map((r) => [r.actor, r.detail])).toEqual([
    ['audit_operator', { seq, bytes: CORRUPT.length, state: 'set_aside', kind: 'repo.visibility_changed' }],
  ]);
  expect(JSON.stringify([rows, await trail(id), done.body])).not.toContain('hunter2');
});

it('a repeat run changes nothing, whatever has happened since', async () => {
  const { who, id, ops } = await setup();
  const [seq] = await planted(id, CORRUPT);
  const { bytes } = (await dryRun(id, ops, seq)).body;
  expect((await setAside(id, ops, seq, bytes)).body.state).toBe('set_aside');
  // Copied and settled.
  expect((await setAside(id, ops, seq, bytes)).body.state).toBe('absent');
  expect((await dryRun(id, ops, seq)).body.state).toBe('absent');
  expect(kinds(await repoRows('acme')).filter((k) => k === 'audit.row_set_aside')).toHaveLength(1);
  // Erased, it says so instead of failing.
  await api(`/repos/${id}?confirm=app`, who, { method: 'DELETE' }, on);
  await deliver(id, on);
  expect(await erased(id)).toBe(true);
  expect((await setAside(id, ops, seq, bytes)).body.state).toBe('erased');
  expect((await dryRun(id, ops, seq)).body.state).toBe('erased');
});

it('a blocked erase moves on after a repair', async () => {
  const { who, id, ops } = await setup();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  quiet();
  const [seq] = await planted(id, CORRUPT, GOOD);
  await api(`/repos/${id}?confirm=app`, who, { method: 'DELETE' }, on);
  await deliver(id, on);
  expect(await erased(id)).toBe(false);
  expect(await waiting(id)).toBe(3);
  const { bytes } = (await dryRun(id, ops, seq)).body;
  expect((await setAside(id, ops, seq, bytes)).body.state).toBe('set_aside');
  expect(due(id)).toHaveLength(1);
  await deliver(id, on);
  expect(await erased(id)).toBe(true);
  expect(kinds(await repoRows('acme'))).toEqual(['repo.created', 'audit.row_set_aside', 'repo.visibility_changed', 'repo.deleted']);
  expect(delayed.filter((m) => m.repo_id === id)).toEqual([]);
});

it('a second corrupt row needs its own run, and names itself once the first is done', async () => {
  const { id, ops } = await setup();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const [first, second] = await planted(id, CORRUPT, CORRUPT);
  const { bytes } = (await dryRun(id, ops, first)).body;
  await setAside(id, ops, first, bytes);
  const lines = error.mock.calls.map(([line]) => JSON.parse(String(line))).filter((l) => l.event === 'audit.event_corrupt');
  expect(lines.at(-1)).toMatchObject({ repo: id, seq: second });
  expect(await waiting(id)).toBe(1);
});

it("a person's repository has no log, so the operators' record is the trail", async () => {
  const who = { cookie: await signup('audit_person') };
  const ops = { cookie: await signup('audit_operator') };
  const made = await api('/repos', who, { body: { name: 'mine', policy, files: [file('a.md', 'a\n')], author } }, on);
  const id = made.body.id as string;
  const [seq] = await planted(id, CORRUPT);
  const { bytes } = (await dryRun(id, ops, seq)).body;
  expect((await setAside(id, ops, seq, bytes)).body.state).toBe('set_aside');
  expect(await waiting(id)).toBe(0);
  expect(await trail(id)).toHaveLength(1);
});

it('a size other than the dry run\'s touches nothing, and off there is nothing to repair', async () => {
  const { id, ops } = await setup();
  const [seq] = await planted(id, CORRUPT);
  const stale = await setAside(id, ops, seq, 1);
  expect([stale.status, stale.body.error.code]).toEqual([409, 'CONFLICT']);
  expect((await dryRun(id, ops, seq, logOff)).status).toBe(409);
  expect((await setAside(id, ops, seq, CORRUPT.length, logOff)).status).toBe(409);
  expect(await waiting(id)).toBe(1);
  expect((await trail(id)).map((r) => r.detail.failed)).toEqual(['CONFLICT', 'CONFLICT']);
});

it('a legal hold keeps the corrupt row, dry run included', async () => {
  const { who, id, ops } = await setup(holds);
  const [seq] = await planted(id, CORRUPT);
  const { bytes } = (await dryRun(id, ops, seq, holds)).body;
  const held = await api(`/orgs/acme/hold`, who, { body: { reason: 'matter 12' } }, holds);
  expect(held.status, JSON.stringify(held.body)).toBe(200);
  const refused = await setAside(id, ops, seq, bytes, holds);
  expect([refused.status, refused.body.error.code]).toEqual([423, 'LEGAL_HOLD']);
  expect((await dryRun(id, ops, seq, holds)).status).toBe(423);
  expect(await waiting(id)).toBe(1);
});
