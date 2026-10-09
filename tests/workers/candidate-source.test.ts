import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { fetchRequest } from '../../cloudflare/worker/routes';
import { ledger, sha } from '../../cloudflare/worker/storage';
import { workspace } from '../../cloudflare/worker/workspace';
import { sitePolicy } from '../../cloudflare/worker/site-policy';
import type { Env } from '../../cloudflare/worker/types';

const bindings = env as unknown as Env;
const repo = 'candidate-inspection';
const revision = { repository: 'yoneda-test/captured-fork', commit: 'b'.repeat(40) };
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
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Private source', workspace: 'alice', remote: { namespace: 'yoneda-test', name: repo }, commit: 'a'.repeat(40), policy: sitePolicy });
  await ledger(bindings, repo, { op: 'start_run', id: 'run-source', intent: 'Candidate fixture', agents: [{ provider: 'codex', model: 'gpt-5.6-luna', strategy: 'minimal' }] });
  const job = await ledger(bindings, repo, { op: 'claim', job_id: 'job:run-source:agent-1' });
  await ledger(bindings, repo, { op: 'finish', job_id: job.id, epoch: job.epoch, result: { workspace: 'c'.repeat(64) } });
  const capture = await ledger(bindings, repo, { op: 'claim', job_id: 'capture:run-source:agent-1' });
  await ledger(bindings, repo, { op: 'finish', job_id: capture.id, epoch: capture.epoch, result: { id: 'captured-candidate', revision, tree: 'd'.repeat(40), paths: ['public/index.html'], diff: 'Synthetic captured source', summary: 'Synthetic capture fixture' } });
  const reads: string[] = [];
  const remote = {
    [Symbol.dispose]() {},
    readCommit: async (commit: string) => { reads.push(`commit:${commit}`); return { treeHash: 'd'.repeat(40) }; },
    readTree: async (tree: string) => tree === 'd'.repeat(40)
      ? [{ name: 'public', type: 'tree', hash: 'e'.repeat(40) }]
      : [{ name: 'index.html', type: 'blob', hash: 'f'.repeat(40) }],
    readBlob: async () => new Blob(['<!doctype html><title>Exact captured revision</title>']),
  };
  const scoped = { ...bindings, ARTIFACTS: { get: async (name: string) => { reads.push(`repo:${name}`); return remote; } } } as unknown as Env;
  const request = (query: string, headers: Record<string, string> = { cookie }) => fetchRequest(new Request(`https://yoneda/api/repos/${repo}/candidate_source?${query}`, { headers }), scoped);
  return { cookie, reads, request };
}

it('reads the attached candidate exact revision and ignores caller-supplied source identities', async () => {
  const { reads, request } = await fixture();
  const result = await request('id=captured-candidate&commit=' + '0'.repeat(40) + '&repository=yoneda-test%2Fother-private&revision=forged');
  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toBe('no-store');
  const value = await result.json<any>();
  expect(value).toMatchObject({ candidate_id: 'captured-candidate', revision, files: { 'public/index.html': { content: '<!doctype html><title>Exact captured revision</title>', executable: false } } });
  expect(reads).toEqual(['repo:captured-fork', `commit:${revision.commit}`]);
  expect((await ledger(bindings, repo, { op: 'snapshot' })).repository.published_commit).toBe('a'.repeat(40));
});

it('rejects absent and foreign candidate IDs before reading any Artifacts source', async () => {
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
  await workspace(bindings, 'alice', { op: 'project_reserve', id: repo, name: 'Private source', policy: sitePolicy });
  await workspace(bindings, 'alice', { op: 'project_update', id: repo, status: 'ready' });
  const secret = 'a'.repeat(64);
  await workspace(bindings, 'alice', { op: 'grant_issue', id: 'grant-source-12345678', repo, label: 'Agent source test', scope: 'read', expires: Date.now() + 60000, token_hash: await sha(secret) });
  expect((await request('id=captured-candidate', { authorization: `Bearer yoneda.alice.grant-source-12345678.${secret}` })).status).toBe(403);
  expect(reads).toEqual([]);
});
