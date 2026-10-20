// Real Worker R2/account/ledger boundaries, with synthetic immutable Artifacts SDK source.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { assertGuidedFork } from '../../cloudflare/worker/guided-project';
import { publishedGuidedProfile, type GuidedEnv } from '../../cloudflare/worker/guided-profile';
import { canonicalBundle } from '../../cloudflare/worker/test-bundle';
import { sha } from '../../cloudflare/worker/storage';
import type { Json } from '../../cloudflare/worker/types';
import { api, bindings, reviewerSignup, signup } from './reviewer-fixture';
import { provisionProject } from '../../cloudflare/worker/project-provisioning';
import { ledger } from '../../cloudflare/worker/storage';
import { workspace } from '../../cloudflare/worker/workspace';

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
  const cookie = await reviewerSignup('guided_creation');
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
  const cookie = await reviewerSignup('guided_fork_creation');
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
  expect(session.source_ready).toBe(true);
});

it('a non-reviewer cannot create a guided project and nothing is reserved or read', async () => {
  const f = await fixture();
  const owner = 'guided_ordinary_account';
  const cookie = await signup(owner);
  const response = await api(f.local, '/api/projects', cookie, {
    request_id: 'guided-ordinary-request-0001', name: 'Ordinary guide', guided_profile_id: 'task-board-v1',
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  expect((await workspace(bindings, owner, { op: 'projects' })).projects).toEqual([]);
  expect(f.get).not.toHaveBeenCalled();
  expect(f.local.AGENT_QUEUE.send).not.toHaveBeenCalled();
});

it('an old Workspace DO that ignores the private marker cannot enqueue guided provisioning', async () => {
  const f = await fixture();
  const cookie = await reviewerSignup('guided_old_workspace');
  const original = bindings.WORKSPACES;
  // Simulate the old-version command boundary: unknown _guided_project is
  // ignored. Actual workspace reservation and alarm intent still use Rust/SQL.
  f.local.WORKSPACES = { idFromName: (name: string) => original.idFromName(name),
    get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
      const command = JSON.parse(String(init.body));
      if (command.op === 'project_reserve') delete command._guided_project;
      return original.get(id).fetch(url, { ...init, body: JSON.stringify(command) });
    } }) } as unknown as DurableObjectNamespace;
  const response = await api(f.local, '/api/projects', cookie, {
    request_id: 'guided-old-workspace-request-0001', name: 'Unadopted guide', guided_profile_id: 'task-board-v1',
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'LEDGER_UPDATING' } });
  expect(f.local.AGENT_QUEUE.send).not.toHaveBeenCalled();
});

it('alarm or queue recovery of an unmarked guided policy cannot fall back to the ordinary starter', async () => {
  const f = await fixture();
  await signup('guided_old_pending');
  const profile = await publishedGuidedProfile(f.local);
  const project = await workspace(bindings, 'guided_old_pending', { op: 'project_reserve',
    id: 'unmarked-guided-project', name: 'Old guided reservation', source: null, policy: profile.policy });
  f.get.mockClear().mockRejectedValue(new Error('Ordinary starter fallback must not run'));
  const result = await provisionProject(f.local, 'guided_old_pending', project);
  expect(result).toMatchObject({ status: 'failed', error_code: 'LEDGER_UPDATING' });
  expect(f.get).not.toHaveBeenCalled();
  await expect(ledger(bindings, project.id, { op: 'repository_status' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('missing Workspace capability fails before reservation, index or starter reads', async () => {
  const f = await fixture();
  const owner = 'guided_old_capability';
  const cookie = await reviewerSignup(owner);
  const original = bindings.WORKSPACES;
  f.local.WORKSPACES = { idFromName: (name: string) => original.idFromName(name),
    get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
      const command = JSON.parse(String(init.body));
      if (command.op === 'workspace_capabilities')
        return Response.json({ error: { code: 'NOT_FOUND', message: 'Unknown workspace operation' } }, { status: 409 });
      return original.get(id).fetch(url, init);
    } }) } as unknown as DurableObjectNamespace;
  const response = await api(f.local, '/api/projects', cookie, {
    request_id: 'guided-old-capability-request-0001', name: 'No old-DO setup', guided_profile_id: 'task-board-v1',
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'LEDGER_UPDATING' } });
  expect((await workspace(bindings, owner, { op: 'projects' })).projects).toEqual([]);
  expect(f.get).not.toHaveBeenCalled();
  expect(f.local.AGENT_QUEUE.send).not.toHaveBeenCalled();
});

/** Version 2 settings name a second single-root starter with its own protected digest. */
function withVersionTwo(f: Awaited<ReturnType<typeof fixture>>, starter?: Json) {
  const v2 = starter ?? { [Symbol.dispose]() {}, info: async () => ({ name: 'guided-starter-v2', defaultBranch: 'main' }),
    log: async () => [{ hash: f.actual.hash }], readCommit: async () => f.actual };
  const original = f.get.getMockImplementation();
  f.get.mockImplementation(async (name: string) => (name === 'guided-starter-v2' ? v2 : original?.(name)) as never);
  return { ...f.local, GUIDED_TASK_BOARD_V2_STARTER_REPO: 'guided-starter-v2',
    GUIDED_TASK_BOARD_V2_BUNDLE_DIGEST: f.digest } as GuidedEnv;
}

it('new projects use version 2 once both of its settings exist; half a configuration fails closed', async () => {
  const f = await fixture();
  expect(await publishedGuidedProfile(f.local)).toMatchObject({ version: 1,
    starter: { repository: 'yoneda-test/guided-starter' } });
  const local = withVersionTwo(f);
  expect(await publishedGuidedProfile(local)).toMatchObject({ version: 2,
    starter: { repository: 'yoneda-test/guided-starter-v2' } });
  for (const missing of ['GUIDED_TASK_BOARD_V2_STARTER_REPO', 'GUIDED_TASK_BOARD_V2_BUNDLE_DIGEST'] as const)
    await expect(publishedGuidedProfile({ ...local, [missing]: undefined }))
      .rejects.toMatchObject({ code: 'GUIDED_PROFILE_UNAVAILABLE' });
});

it('a version 1 project stays pinned to version 1 after version 2 is configured', async () => {
  const f = await fixture();
  const cookie = await reviewerSignup('guided_pinned_v1');
  const body = { request_id: 'guided-pinned-request-0001', name: 'Pinned board', guided_profile_id: 'task-board-v1' };
  const project = await (await api(f.local, '/api/projects', cookie, body)).json<Json>();
  expect(project.guided_project.version).toBe(1);
  const replay = await api(withVersionTwo(f), '/api/projects', cookie, body);
  expect(await replay.json()).toEqual(project);
});

it('a version 2 project records version 2 in Native and in its guide session', async () => {
  const f = await fixture();
  let copied = false;
  const starter = { [Symbol.dispose]() {}, info: async () => ({ name: 'guided-starter-v2', defaultBranch: 'main' }),
    log: async () => [{ hash: f.actual.hash }], readCommit: async () => f.actual,
    fork: async () => { copied = true; return { token: 'synthetic-setup-only' }; } };
  const local = withVersionTwo(f, starter);
  const cookie = await reviewerSignup('guided_v2_project');
  const project = await (await api(local, '/api/projects', cookie, {
    request_id: 'guided-v2-project-request-0001', name: 'Version two board', guided_profile_id: 'task-board-v1',
  })).json<Json>();
  expect(project.guided_project).toMatchObject({ version: 2, starter: { repository: 'yoneda-test/guided-starter-v2' } });
  const target = { [Symbol.dispose]() {}, info: async () => ({ name: project.id, defaultBranch: 'main', readOnly: false,
    source: 'artifacts:yoneda-test/guided-starter-v2' }),
    log: async () => [{ hash: f.actual.hash }], readCommit: async () => f.actual,
    readTree: async () => [{ name: 'README.md', type: 'blob', hash: 'c'.repeat(40) }],
    readBlob: async () => new Blob(['Synthetic version 2 starter']),
    listTokens: async () => ({ tokens: [] }), revokeToken: async () => true };
  f.get.mockImplementation(async (name: string) => {
    if (name === 'guided-starter-v2') return starter;
    if (!copied) throw Object.assign(new Error('Target absent before copy'), { code: 'NOT_FOUND' });
    return target;
  });
  expect((await provisionProject(local, 'guided_v2_project', project)).status).toBe('ready');
  const repository = await ledger(local, project.id, { op: 'repository_status', _workspace: 'guided_v2_project' });
  expect(repository.guided_project.version).toBe(2);
  const session = await (await api(local, `/api/repos/${project.id}/guided_session`, cookie)).json<Json>();
  expect(session).toMatchObject({ version: 2 });
  expect(session.steps[0]).toMatchObject({ id: 'build', status: 'ready' });
});
