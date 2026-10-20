// Real Worker R2/account/ledger boundaries, with synthetic immutable Artifacts SDK source.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { bindPlatform } from '../../cloudflare/worker/agents-platform';
import { guidedProjectInput } from '../../cloudflare/worker/guided-project';
import { ensureProjectPlatform, projectSeed } from '../../cloudflare/worker/project-platform';
import { publishedGuidedProfile, type GuidedEnv } from '../../cloudflare/worker/guided-profile';
import { canonicalBundle } from '../../cloudflare/worker/test-bundle';
import { sha } from '../../cloudflare/worker/storage';
import type { Json } from '../../cloudflare/worker/types';
import { api, bindings, reviewerSignup, signup } from './reviewer-fixture';
import { provisionProject } from '../../cloudflare/worker/project-provisioning';
import { ledger } from '../../cloudflare/worker/storage';
import { workspace } from '../../cloudflare/worker/workspace';
import { bindNewPlatformRepo, operator, templateArtifacts } from './platform-fixture';

const guidedStarterFiles = {
  'README.md': '# Task board\n',
  '.yoneda-guided': 'task-board-v1\n',
  'public/index.html': '<!doctype html><title>Task board</title>\n',
  'fixtures/guided-task-board/oracle/run.mjs': '// Synthetic immutable oracle fixture\n',
};

afterEach(reset);
async function fixture() {
  const files = Object.fromEntries(['run.mjs', 'check.mjs', 'observe.mjs'].map(file =>
    [`fixtures/guided-task-board/oracle/${file}`, { content: '// Synthetic immutable oracle fixture', executable: false }]));
  const encoded = canonicalBundle(files).encoded;
  const digest = await sha(encoded);
  await (env as unknown as GuidedEnv).OBJECTS.put(`sha256/${digest}`, encoded);
  // Operator-published starters with real Git ids; the starter commit's history is mutable.
  const templates = await templateArtifacts({ 'guided-starter': guidedStarterFiles, 'guided-starter-v2': guidedStarterFiles });
  const snapshot = await templates.snapshot('guided-starter');
  const actual: Json = { hash: snapshot.commit, treeHash: snapshot.root, parents: [] };
  const starter = async (name: string) => {
    const repo = await templates.get(name);
    return { ...repo, readCommit: async (hash: string) => (hash === actual.hash ? actual : null) };
  };
  const get = vi.fn(async (name: string) => {
    if (name !== 'guided-starter') throw Object.assign(new Error('Absent fresh target'), { code: 'NOT_FOUND' });
    return starter(name);
  });
  const local = { ...bindings, GUIDED_TASK_BOARD_STARTER_REPO: 'guided-starter',
    GUIDED_TASK_BOARD_BUNDLE_DIGEST: digest, ARTIFACTS: { get }, AGENT_QUEUE: { send: vi.fn(async () => {}) } } as unknown as GuidedEnv;
  return { local, digest, actual, get, starter, templates };
}

it('loads the digest-addressed protected checks and a single-root starter with the canonical fixed policy', async () => {
  const f = await fixture();
  const profile = await publishedGuidedProfile(f.local);
  expect(profile.starter).toEqual({ repository: 'yoneda-test/guided-starter', branch: 'main', commit: f.actual.hash, tree: f.actual.treeHash });
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
  // The replay reports the first request's platform binding and never seeds another repository.
  expect(await replay.json()).toEqual({ ...project, updated_at: expect.any(Number), platform: { repo: expect.stringMatching(/^r[0-9a-f]{20}$/) } });
  expect(f.get).not.toHaveBeenCalled();
});

it('guided setup replays its first platform binding and cannot adopt another repository', async () => {
  const f = await fixture();
  await reviewerSignup('guided_binding');
  const reserve = async (id: string) => workspace(bindings, 'guided_binding', { op: 'project_reserve', id, name: 'Bound guide',
    ...(await guidedProjectInput(f.local, 'guided_binding', id, { name: 'Bound guide', guided_profile_id: 'task-board-v1' })) });
  const project = await reserve('guided-binding');
  const seed = await projectSeed(f.local, project);
  expect(seed).toEqual({ template: 'guided-starter', commit: f.actual.hash, tree: f.actual.treeHash });
  const repo = await ensureProjectPlatform(f.local, operator(), 'guided_binding', project, seed, true);
  const bound = await workspace(bindings, 'guided_binding', { op: 'project_get', id: project.id });
  expect(bound.platform).toEqual({ repo });
  expect(await ensureProjectPlatform(f.local, operator(), 'guided_binding', bound, seed, true)).toBe(repo);
  // A concurrent setup's second repository is never adopted.
  const other = await bindNewPlatformRepo(bindings, 'guided_binding', `${project.id}-other`, null);
  expect(await bindPlatform(bindings, 'guided_binding', project.id, other.repo, 'yrp_other_fixture')).toBe(repo);
  // A starter whose tree moved since the profile was pinned is not this guide.
  const moved = { ...f.local, ARTIFACTS: await templateArtifacts({ 'guided-starter': { ...guidedStarterFiles, 'README.md': 'Moved\n' } }) } as GuidedEnv;
  const fresh = await reserve('guided-moved');
  await expect(ensureProjectPlatform(moved, operator(), 'guided_binding', fresh, seed, true))
    .rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('a fresh guided project is ready only after Native init retains the exact profile and policy', async () => {
  const f = await fixture();
  const cookie = await reviewerSignup('guided_fork_creation');
  const response = await api(f.local, '/api/projects', cookie, {
    request_id: 'guided-full-fork-request-0001', name: 'Fresh checked starter', guided_profile_id: 'task-board-v1',
  });
  expect(response.status).toBe(202);
  const project = await response.json<Json>();
  const bound = await workspace(bindings, 'guided_fork_creation', { op: 'project_get', id: project.id });
  expect(bound.platform?.repo).toMatch(/^r[0-9a-f]{20}$/);
  f.get.mockClear();
  const ready = await provisionProject(f.local, 'guided_fork_creation', project);
  expect(ready.status).toBe('ready');
  expect(f.get).not.toHaveBeenCalled();
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
  // Background setup cannot create a repository; the owner's retry refuses the ordinary seed.
  const result = await provisionProject(f.local, 'guided_old_pending', project);
  expect(result).toMatchObject({ status: 'failed', error_code: 'PLATFORM_UNBOUND' });
  await expect(projectSeed(f.local, project)).rejects.toMatchObject({ code: 'LEDGER_UPDATING' });
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
function withVersionTwo(f: Awaited<ReturnType<typeof fixture>>) {
  const original = f.get.getMockImplementation();
  f.get.mockImplementation(async (name: string) => (name === 'guided-starter-v2' ? f.starter(name) : original?.(name)) as never);
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
  expect(await replay.json()).toEqual({ ...project, updated_at: expect.any(Number), platform: { repo: expect.stringMatching(/^r[0-9a-f]{20}$/) } });
});

it('a version 2 project records version 2 in Native and in its guide session', async () => {
  const f = await fixture();
  const local = withVersionTwo(f);
  const cookie = await reviewerSignup('guided_v2_project');
  const project = await (await api(local, '/api/projects', cookie, {
    request_id: 'guided-v2-project-request-0001', name: 'Version two board', guided_profile_id: 'task-board-v1',
  })).json<Json>();
  expect(project.guided_project).toMatchObject({ version: 2, starter: { repository: 'yoneda-test/guided-starter-v2' } });
  expect((await provisionProject(local, 'guided_v2_project', project)).status).toBe('ready');
  const repository = await ledger(local, project.id, { op: 'repository_status', _workspace: 'guided_v2_project' });
  expect(repository.guided_project.version).toBe(2);
  const session = await (await api(local, `/api/repos/${project.id}/guided_session`, cookie)).json<Json>();
  expect(session).toMatchObject({ version: 2 });
  expect(session.steps[0]).toMatchObject({ id: 'build', status: 'ready' });
});
