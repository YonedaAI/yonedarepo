// Real Worker R2/account/ledger boundaries, with synthetic immutable Artifacts SDK source.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { assertGuidedFork } from '../../cloudflare/worker/guided-project';
import { publishedGuidedProfile, type GuidedEnv } from '../../cloudflare/worker/guided-profile';
import { canonicalBundle } from '../../cloudflare/worker/test-bundle';
import { sha } from '../../cloudflare/worker/storage';
import type { Json } from '../../cloudflare/worker/types';
import { api, bindings, signup } from './reviewer-fixture';
import { provisionProject } from '../../cloudflare/worker/project-provisioning';
import { ledger } from '../../cloudflare/worker/storage';

afterEach(reset);
async function fixture() {
  const files = Object.fromEntries(['run.mjs', 'check.mjs', 'observe.mjs'].map(file =>
    [`fixtures/guided-task-board/oracle/${file}`, { content: '// Synthetic immutable oracle fixture', executable: false }]));
  const encoded = canonicalBundle(files).encoded;
  const digest = await sha(encoded);
  await (env as unknown as GuidedEnv).OBJECTS.put(`sha256/${digest}`, encoded);
  const actual: Json = { hash: 'a'.repeat(40), treeHash: 'b'.repeat(40), parents: [] };
  const remote = { [Symbol.dispose]() {}, info: async () => ({ name: 'guided-starter', defaultBranch: 'main' }),
    log: async () => [{ hash: 'a'.repeat(40) }], readCommit: async () => actual };
  const get = vi.fn(async (name: string) => {
    if (name !== 'guided-starter') throw Object.assign(new Error('Absent fresh target'), { code: 'NOT_FOUND' });
    return remote;
  });
  const local = { ...bindings, GUIDED_TASK_BOARD_STARTER_REPO: 'guided-starter',
    GUIDED_TASK_BOARD_BUNDLE_DIGEST: digest, ARTIFACTS: { get }, AGENT_QUEUE: { send: vi.fn(async () => {}) } } as unknown as GuidedEnv;
  return { local, digest, actual, get };
}

it('loads the digest-addressed protected checks and a single-root starter with the canonical fixed policy', async () => {
  const f = await fixture();
  const profile = await publishedGuidedProfile(f.local);
  expect(profile.starter).toEqual({ repository: 'yoneda-test/guided-starter', branch: 'main', commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
  expect(profile.policy).toMatchObject({ version: 'task-board-v1', required_checks: ['guided-task-board'],
    build: { static_dir: 'public', checks: [{ name: 'guided-task-board', argv: ['node', '/opt/yoneda/test-bundle/fixtures/guided-task-board/oracle/run.mjs'] }],
      test_bundle: { digest: f.digest, protected_paths: ['README.md', '.yoneda-guided', 'fixtures/guided-task-board/oracle'] } } });
});

it('rejects starter history and corrupted protected bytes before reserving a fresh project', async () => {
  const f = await fixture();
  f.actual.parents = ['c'.repeat(40)];
  await expect(publishedGuidedProfile(f.local)).rejects.toMatchObject({ code: 'GUIDED_PROFILE_UNAVAILABLE' });
  f.actual.parents = [];
  await bindings.OBJECTS.put(`sha256/${f.digest}`, '{}');
  await expect(publishedGuidedProfile(f.local)).rejects.toMatchObject({ code: 'GUIDED_PROFILE_UNAVAILABLE' });
});

it('fresh guide creation retains the private marker; retry does not refresh seed identity or create a new repository', async () => {
  const f = await fixture();
  const cookie = await signup('guided_creation');
  const body = { request_id: 'guided-create-request-0001', name: 'Fresh task board', guided_profile_id: 'task-board-v1' };
  const first = await api(f.local, '/api/projects', cookie, body);
  expect(first.status).toBe(202);
  const project = await first.json<Json>();
  expect(project.guided_project).toMatchObject({ profile_id: 'task-board-v1', version: 1, test_bundle_digest: f.digest });
  f.get.mockClear().mockRejectedValue(new Error('Rotated starter must not rebind old reservation'));
  const replay = await api(f.local, '/api/projects', cookie, body);
  expect(replay.status).toBe(202);
  expect(await replay.json()).toEqual(project);
  expect(f.get).not.toHaveBeenCalled();
});

it('fork readback rejects target adoption despite matching commit and tree', async () => {
  const f = await fixture();
  const profile = await publishedGuidedProfile(f.local);
  const remote = { info: async () => ({ name: 'fresh', defaultBranch: 'main', readOnly: false, source: 'artifacts:foreign/starter' }),
    log: async () => [{ hash: f.actual.hash }], readCommit: async () => f.actual } as unknown as ArtifactsRepo;
  await expect(assertGuidedFork(remote, { id: 'fresh', guided_project: profile })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});

it('a fresh guided fork is ready only after Native init retains the exact profile and policy', async () => {
  const f = await fixture();
  const cookie = await signup('guided_fork_creation');
  const response = await api(f.local, '/api/projects', cookie, {
    request_id: 'guided-full-fork-request-0001', name: 'Fresh checked starter', guided_profile_id: 'task-board-v1',
  });
  expect(response.status).toBe(202);
  const project = await response.json<Json>();
  let forked = false;
  const target = { [Symbol.dispose]() {}, info: async () => ({ name: project.id, defaultBranch: 'main', readOnly: false,
    source: 'artifacts:yoneda-test/guided-starter' }),
    log: async () => [{ hash: f.actual.hash }], readCommit: async () => f.actual,
    readTree: async () => [{ name: 'README.md', type: 'blob', hash: 'c'.repeat(40) }],
    readBlob: async () => new Blob(['Synthetic fresh starter']),
    listTokens: async () => ({ tokens: [] }), revokeToken: async () => true };
  const starter = { [Symbol.dispose]() {}, info: async () => ({ name: 'guided-starter', defaultBranch: 'main' }),
    log: async () => [{ hash: f.actual.hash }], readCommit: async () => f.actual,
    fork: async () => { forked = true; return { token: 'synthetic-setup-only' }; } };
  f.get.mockImplementation(async name => {
    if (name === 'guided-starter') return starter;
    if (!forked) throw Object.assign(new Error('Target absent before fork'), { code: 'NOT_FOUND' });
    return target;
  });
  const ready = await provisionProject(f.local, 'guided_fork_creation', project);
  expect(ready.status).toBe('ready');
  const repository = await ledger(f.local, project.id, { op: 'repository_status', _workspace: 'guided_fork_creation' });
  expect(repository.guided_project).toEqual(project.guided_project);
  expect(repository.policy).toMatchObject({ version: 'task-board-v1', required_checks: ['guided-task-board'] });
  const read = await api(f.local, `/api/repos/${project.id}/guided_session`, cookie);
  expect(read.status).toBe(200);
  const session = await read.json<Json>();
  expect(session.steps[0]).toMatchObject({ id: 'build', status: 'ready', run_ids: [] });
  expect(session.source_transport).toBe('git-native-v1');
  expect(session.source_allowlisted).toBe(false);
});
