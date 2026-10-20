import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { fetchRequest } from '../../cloudflare/worker/routes';
import { ledger, sha } from '../../cloudflare/worker/storage';
import { workspace } from '../../cloudflare/worker/workspace';
import { sitePolicy } from '../../cloudflare/worker/site-policy';
import type { Env } from '../../cloudflare/worker/types';
import { platformCommit, platformProject } from './platform-fixture';

const bindings = env as unknown as Env;
const repo = 'candidate-inspection';
const html = '<!doctype html><title>Exact captured revision</title>';
afterEach(reset);
async function signup(username: string) {
  const response = await bindings.SELF.fetch('https://yoneda/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'long candidate test password' }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}
async function fixture() {
  const cookie = await signup('alice');
  const project = await platformProject(bindings, 'alice', repo, { 'public/index.html': 'starter' }, sitePolicy);
  // The capture is an actual commit of the project's platform repository.
  const made = await platformCommit(project.platform, project.base.commit, { 'public/index.html': html });
  const revision = { repository: project.base.repository, commit: made.commit };
  await ledger(bindings, repo, { op: 'start_run', id: 'run-source', intent: 'Candidate fixture', agents: [{ provider: 'codex', model: 'gpt-5.6-luna', strategy: 'minimal' }] });
  const job = await ledger(bindings, repo, { op: 'claim', job_id: 'job:run-source:agent-1' });
  await ledger(bindings, repo, { op: 'finish', job_id: job.id, epoch: job.epoch, result: { workspace: 'c'.repeat(64) } });
  const capture = await ledger(bindings, repo, { op: 'claim', job_id: 'capture:run-source:agent-1' });
  await ledger(bindings, repo, { op: 'finish', job_id: capture.id, epoch: capture.epoch, result: { id: 'captured-candidate', revision, tree: made.tree, paths: ['public/index.html'], diff: 'Synthetic captured source', summary: 'Synthetic capture fixture' } });
  // Every platform read is recorded: which repository, and which commits were requested.
  const reads: string[] = [];
  const scoped = { ...bindings, PLATFORM: { async fetch(input: RequestInfo, init?: RequestInit) {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    reads.push(`repo:${path.split('/')[4]}`);
    if (path.endsWith('/objects'))
      for (const o of (await request.clone().json<any>()).objects) if (o.kind === 'commit') reads.push(`commit:${o.id}`);
    return bindings.SELF.fetch(request);
  } } } as unknown as Env;
  const request = (query: string, headers: Record<string, string> = { cookie }) => fetchRequest(new Request(`https://yoneda/api/repos/${repo}/candidate_source?${query}`, { headers }), scoped);
  return { cookie, reads, request, revision, platformRepo: project.repo };
}

it('reads the attached candidate exact revision and ignores caller-supplied source identities', async () => {
  const { reads, request, revision, platformRepo } = await fixture();
  const result = await request('id=captured-candidate&commit=' + '0'.repeat(40) + '&repository=platform%2Fother-private&revision=forged');
  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toBe('no-store');
  const value = await result.json<any>();
  expect(value).toMatchObject({ candidate_id: 'captured-candidate', revision, files: { 'public/index.html': { content: html, executable: false } } });
  expect(new Set(reads.filter((read) => read.startsWith('repo:')))).toEqual(new Set([`repo:${platformRepo}`]));
  expect(reads.filter((read) => read.startsWith('commit:'))).toEqual([`commit:${revision.commit}`]);
  const repository = (await ledger(bindings, repo, { op: 'snapshot' })).repository;
  expect(repository.published_commit).not.toBe(revision.commit);
});

it('rejects absent and foreign candidate IDs before reading any platform source', async () => {
  const { reads, request } = await fixture();
  for (const query of ['', 'id=unrecorded-candidate', 'id=other-repository-candidate']) {
    const result = await request(query);
    expect(result.status).toBe(404);
  }
  expect(reads).toEqual([]);
});

it('enforces owner workspace and rejects anonymous or agent callers before source retrieval', async () => {
  const { reads, request } = await fixture();
  const bob = await signup('bob');
  expect((await request('id=captured-candidate', { cookie: bob })).status).toBe(403);
  expect((await request('id=captured-candidate', {})).status).toBe(401);
  expect((await request('id=captured-candidate', { authorization: 'Bearer local-test-owner' })).status).toBe(403);
  // The fixture project is already reserved and ready in alice's workspace.
  const secret = 'a'.repeat(64);
  await workspace(bindings, 'alice', { op: 'grant_issue', id: 'grant-source-12345678', repo, label: 'Agent source test', scope: 'read', expires: Date.now() + 60000, token_hash: await sha(secret) });
  expect((await request('id=captured-candidate', { authorization: `Bearer yoneda.alice.grant-source-12345678.${secret}` })).status).toBe(403);
  expect(reads).toEqual([]);
});
