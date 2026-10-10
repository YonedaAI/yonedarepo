import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { brokerHandler } from '../../cloudflare/worker/broker';
import { sitePolicy } from '../../cloudflare/worker/site-policy';
import { ledger, object, sha } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { api, bindings, containerBindings, signup } from './reviewer-fixture';

afterEach(reset);
const repo = 'compact-diff';
const revision = { repository: 'yoneda-test/trusted-capture-fork', commit: 'b'.repeat(40) };
const tree = 'c'.repeat(40);
const supervisor = 'synthetic-trusted-supervisor';
async function fixture() {
  const cookie = await signup('diff_owner');
  await ledger(bindings, repo, { op: 'init', id: repo, workspace: 'diff_owner', name: 'Diff transport fixture',
    remote: { namespace: 'yoneda-test', name: repo }, commit: 'a'.repeat(40), policy: sitePolicy });
  await ledger(bindings, repo, { op: 'start_run', id: 'diff-run', intent: 'Synthetic capture',
    agents: [{ provider: 'codex', model: 'gpt-5.6-luna', strategy: 'Test capture' }] });
  const agent = await ledger(bindings, repo, { op: 'claim', job_id: 'job:diff-run:agent-1' });
  await ledger(bindings, repo, { op: 'finish', job_id: agent.id, epoch: agent.epoch, result: { workspace: 'd'.repeat(64) } });
  const capture = await ledger(bindings, repo, { op: 'claim', job_id: 'capture:diff-run:agent-1' });
  const scope: Scope = { repo_id: repo, job: capture, supervisor, fork: revision.repository, model_calls: 0, created_at: Date.now() };
  const readCommit = vi.fn(async () => ({ treeHash: tree, parents: ['a'.repeat(40)] }));
  // Artifacts commit verification and Container RPC are fake; the broker,
  // attempt fencing, R2 digest storage and ledger transition are real workerd.
  const scoped = { ...bindings, ARTIFACTS: { get: async () => ({ [Symbol.dispose]() {}, readCommit }) } } as unknown as Env;
  const container = containerBindings(scoped, scope);
  const complete = (body: Json, token = supervisor, target = container.scoped) => brokerHandler(new Request('http://yoneda.internal/complete', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }), target, { containerId: 'synthetic-capture' } as Parameters<typeof brokerHandler>[2]);
  const result = (diff: string) => ({ id: 'diff-candidate', revision, tree, paths: ['public/index.html'], diff, summary: 'Synthetic captured diff' });
  return { cookie, capture, scope, readCommit, container, complete, result };
}

it('stores a >1 MiB trusted diff in R2, keeps candidate/evaluator compact and hydrates authorized owner routes', async () => {
  const f = await fixture();
  const diff = 'diff --git a/public/index.html b/public/index.html\n' + '+Synthetic source line\n'.repeat(60_000);
  expect(new TextEncoder().encode(diff).length).toBeGreaterThan(1024 * 1024);
  const forged = (await object(bindings, 'Unrelated private evidence')).digest;
  const completed = await f.complete({ ...f.result(diff), diff_digest: forged, job_id: 'forged-job', epoch: 999 });
  expect(completed.status).toBe(200);
  expect(f.container.stop).toHaveBeenCalledOnce();
  expect(f.readCommit).toHaveBeenCalledWith(revision.commit);
  const snapshot = await ledger(bindings, repo, { op: 'snapshot' });
  const candidate = snapshot.candidates[0];
  const digest = await sha(diff);
  expect(candidate).toMatchObject({ id: 'diff-candidate', diff_digest: digest, revision });
  expect(candidate.diff).toBeUndefined();
  expect(candidate.diff_digest).not.toBe(forged);
  const evaluator = await ledger(bindings, repo, { op: 'claim', job_id: 'evaluate:diff-candidate' });
  expect(evaluator.payload.candidate.diff).toBeUndefined();
  expect(evaluator.payload.candidate.diff_digest).toBe(digest);
  expect(JSON.stringify(evaluator).length).toBeLessThan(32_000);
  expect(JSON.stringify(snapshot).length).toBeLessThan(100_000);
  const ownerSnapshot = await api(bindings, `/api/repos/${repo}/snapshot`, f.cookie);
  expect(ownerSnapshot.status).toBe(200);
  expect((await ownerSnapshot.json<Json>()).candidates[0].diff).toBe(diff);
  const detail = await api(bindings, `/api/repos/${repo}/candidate?id=diff-candidate&digest=${forged}`, f.cookie);
  expect(detail.status).toBe(200);
  expect((await detail.json<Json>()).diff).toBe(diff);
  const evidence = await api(bindings, `/api/repos/${repo}/evidence?digest=${digest}`, f.cookie);
  expect(evidence.status).toBe(200);
  expect(await evidence.json()).toEqual({ digest, content: diff });
  expect((await api(bindings, `/api/repos/${repo}/evidence?digest=${forged}`, f.cookie)).status).toBe(404);
  expect((await ledger(bindings, repo, { op: 'snapshot' })).candidates[0].diff).toBeUndefined();
});

it('rejects missing full diff, foreign captured revision and untrusted supervisor before storing or committing', async () => {
  const f = await fixture();
  const before = await ledger(bindings, repo, { op: 'snapshot' });
  const put = vi.fn(async () => { throw new Error('Unauthorized capture must not write objects'); });
  const target = { ...f.container.scoped, OBJECTS: { put } } as unknown as Env;
  const metadata = { ...f.result(''), diff: undefined, diff_digest: 'f'.repeat(64) };
  expect((await f.complete(metadata, supervisor, target)).status).toBe(409);
  expect((await f.complete({ ...f.result('foreign'), revision: { ...revision, repository: 'yoneda-test/foreign' } }, supervisor, target)).status).toBe(403);
  expect((await f.complete(f.result('untrusted'), 'forged-supervisor', target)).status).toBe(403);
  expect(put).not.toHaveBeenCalled();
  const after = await ledger(bindings, repo, { op: 'snapshot' });
  expect(after.seq).toBe(before.seq);
  expect(after.candidates).toEqual([]);
  expect(f.container.stop).not.toHaveBeenCalled();
});

it('rejects a forged commit parent and rolls back completion on simulated R2 upload failure', async () => {
  const f = await fixture();
  f.readCommit.mockResolvedValueOnce({ treeHash: tree, parents: ['e'.repeat(40)] });
  const invalid = await f.complete(f.result('Rejected parent'));
  expect(invalid.status).toBe(409);
  expect((await invalid.json<Json>()).error.code).toBe('INVALID_CAPTURE');
  const put = vi.fn(async () => { throw new Error('Simulated R2 unavailable'); });
  const target = { ...f.container.scoped, OBJECTS: { put } } as unknown as Env;
  const failed = await f.complete(f.result('Retryable capture diff'), supervisor, target);
  expect(failed.status).toBe(409);
  expect((await ledger(bindings, repo, { op: 'snapshot' })).candidates).toEqual([]);
  expect(f.container.stop).not.toHaveBeenCalled();
  expect((await f.complete(f.result('Retryable capture diff'))).status).toBe(200);
  expect((await ledger(bindings, repo, { op: 'snapshot' })).candidates).toHaveLength(1);
});

it('keeps foreign, anonymous and unattached evidence reads outside R2 and denies fenced captures', async () => {
  const f = await fixture();
  expect((await f.complete(f.result('Private source'))).status).toBe(200);
  const digest = (await ledger(bindings, repo, { op: 'snapshot' })).candidates[0].diff_digest;
  const cookie = await signup('foreign_owner');
  const get = vi.fn(async () => { throw new Error('Unauthorized read must not reach R2'); });
  const scoped = { ...bindings, OBJECTS: { get } } as unknown as Env;
  for (const path of [`/api/repos/${repo}/snapshot`, `/api/repos/${repo}/candidate?id=diff-candidate`, `/api/repos/${repo}/evidence?digest=${digest}`]) {
    expect((await api(scoped, path, cookie)).status).toBe(403);
    expect((await api(scoped, path)).status).toBe(401);
  }
  expect((await api(scoped, `/api/repos/${repo}/candidate?id=foreign-candidate`, f.cookie)).status).toBe(404);
  expect((await api(scoped, `/api/repos/${repo}/evidence?digest=${'0'.repeat(64)}`, f.cookie)).status).toBe(404);
  expect(get).not.toHaveBeenCalled();
  const replay = await f.complete(f.result('late forged source'));
  expect(replay.status).toBe(409);
  expect(f.container.stop).toHaveBeenCalledOnce();
});

it('fails closed on missing or corrupt attached R2 content while retaining the compact ledger binding', async () => {
  const f = await fixture();
  expect((await f.complete(f.result('Recorded immutable diff'))).status).toBe(200);
  const digest = (await ledger(bindings, repo, { op: 'snapshot' })).candidates[0].diff_digest;
  await bindings.OBJECTS.delete(`sha256/${digest}`);
  for (const action of ['snapshot', 'candidate?id=diff-candidate', `evidence?digest=${digest}`]) {
    const response = await api(bindings, `/api/repos/${repo}/${action}`, f.cookie);
    expect(response.status).toBe(409);
    expect((await response.json<Json>()).error.message).toContain('missing');
  }
  await bindings.OBJECTS.put(`sha256/${digest}`, 'Tampered content');
  const response = await api(bindings, `/api/repos/${repo}/snapshot`, f.cookie);
  expect(response.status).toBe(409);
  expect((await response.json<Json>()).error.message).toContain('digest mismatch');
  expect((await ledger(bindings, repo, { op: 'snapshot' })).candidates[0]).toMatchObject({ diff_digest: digest });
});

it('preserves pre-migration inline diffs for authorized owners without widening evidence access', async () => {
  const f = await fixture();
  expect((await f.complete(f.result('Initial modern diff'))).status).toBe(200);
  // Simulate a pre-migration stored candidate, not a new untrusted completion.
  const stub = bindings.REPOSITORIES.get(bindings.REPOSITORIES.idFromName(repo));
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE candidates SET payload=json_set(json_remove(payload,'$.diff_digest'),'$.diff','Legacy inline diff') WHERE id='diff-candidate'");
  });
  for (const action of ['snapshot', 'candidate?id=diff-candidate']) {
    const response = await api(bindings, `/api/repos/${repo}/${action}`, f.cookie);
    expect(response.status).toBe(200);
    const result = await response.json<Json>();
    expect((result.candidates?.[0] ?? result).diff).toBe('Legacy inline diff');
  }
  const foreign = await signup('legacy_foreign');
  expect((await api(bindings, `/api/repos/${repo}/candidate?id=diff-candidate`, foreign)).status).toBe(403);
  const digest = await sha('Initial modern diff');
  expect((await api(bindings, `/api/repos/${repo}/evidence?digest=${digest}`, f.cookie)).status).toBe(404);
});

it('exposes workspace authority in the real lightweight repository_status preflight', async () => {
  await fixture();
  const status = await ledger(bindings, repo, { op: 'repository_status', _workspace: 'diff_owner' });
  expect(status).toMatchObject({ workspace: 'diff_owner', capabilities: { workspace_authority: 1 } });
  expect(status.candidates).toBeUndefined();
  await expect(ledger(bindings, repo, { op: 'snapshot', _workspace: 'foreign_owner' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
