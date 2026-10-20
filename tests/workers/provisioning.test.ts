import { env } from 'cloudflare:workers';
import { reset, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { projectRoute, provisionProject, sitePolicy } from '../../cloudflare/worker/projects';
import type { Env, Json } from '../../cloudflare/worker/types';
import { ensureProjectPlatform, projectSeed } from '../../cloudflare/worker/project-platform';
import { signup } from './reviewer-fixture';
import { bindNewPlatformRepo, interceptPlatform, operator, platformJson, templateArtifacts } from './platform-fixture';
import { workspace } from '../../cloudflare/worker/workspace';
import { provisionMessage, enqueueProjects } from '../../cloudflare/worker/project-provisioning';
import { advertisedBranch, setupMessage } from '../../cloudflare/worker/project-remote';

const bindings = env as unknown as Env;
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
async function reserve(source: string | null = null) {
  await workspace(bindings, 'alice', { op: 'signup', username: 'alice', password: 'a long test password', salt: '01'.repeat(16), recovery_hash: 'b'.repeat(64), session_hash: 'a'.repeat(64) });
  return workspace(bindings, 'alice', { op: 'project_reserve', id: 'project-one', name: 'Portfolio', source, policy: sitePolicy });
}
const listed = async () => (await bindings.INDEX.prepare('SELECT COUNT(*) AS n FROM platform_repos').first<{ n: number }>())?.n;
/** The platform still importing a bound project's source: no main ref, import running. */
const importing = (env: Env, active: () => boolean, numeric = false) =>
  interceptPlatform(env, (path) => {
    if (!active()) return undefined;
    if (path.endsWith('/refs')) return platformJson({ refs: {} });
    if (path.endsWith('/import')) return platformJson({ status: numeric ? 'queued' : 'running' });
    return undefined;
  });
it('completes setup of a bound project from its platform head without creating another repository', async () => {
  const project = await reserve('https://github.com/example/project');
  const { commit } = await bindNewPlatformRepo(bindings, 'alice', project.id);
  expect(await listed()).toBe(1);
  const fake = { ...bindings, ARTIFACTS: { get: async () => { throw new Error('Setup must not read Artifacts'); } } } as unknown as Env;
  expect((await provisionProject(fake, 'alice', project)).status).toBe('ready');
  expect(await listed()).toBe(1);
  const { ledger } = await import('../../cloudflare/worker/storage');
  expect((await ledger(bindings, project.id, { op: 'snapshot', _workspace: 'alice' })).repository)
    .toMatchObject({ head_commit: commit, remote: { namespace: 'platform', name: project.id, branch: 'main' } });
});
it('keeps a project pending while its platform import is still running', async () => {
  const project = await reserve('https://github.com/example/project');
  await bindNewPlatformRepo(bindings, 'alice', project.id, null);
  const result = await provisionProject(importing(bindings, () => true, true), 'alice', project);
  expect(result).toMatchObject({ status: 'provisioning', setup_pending_count: 1, retry_delay_seconds: 2, error_code: null });
});
it('reports a ready repository with no default-branch commits instead of spinning forever', async () => {
  const project = await reserve();
  await bindNewPlatformRepo(bindings, 'alice', project.id, null);
  const result = await provisionProject(bindings, 'alice', project);
  expect(result.status).toBe('failed');
  expect(result.error_code).toBe('EMPTY_REPOSITORY');
  expect(result.error).toContain('commit');
});
it('imports the advertised default branch rather than assuming main', async () => {
  const project = await reserve('https://github.com/example/project');
  const packet = 'c'.repeat(40) + ' HEAD\0multi_ack symref=HEAD:refs/heads/master agent=test\n';
  const fetch = vi.fn(async (..._args: unknown[]) => new Response('001e# service=git-upload-pack\n0000' + (packet.length + 4).toString(16).padStart(4, '0') + packet + '0000'));
  vi.stubGlobal('fetch', fetch);
  const imports: Json[] = [];
  const fake = interceptPlatform(bindings, async (path, request) => {
    if (path !== '/repos/import') return undefined;
    imports.push(await request.json<Json>());
    return platformJson({ id: `r${'8'.repeat(20)}`, import: 'import-1', tokens: [{ name: 'yoneda-agents', token: 'yrp_import_fixture' }] });
  });
  try {
    expect(await ensureProjectPlatform(fake, operator(), 'alice', project, await projectSeed(fake, project), true)).toBe(`r${'8'.repeat(20)}`);
    expect(imports).toMatchObject([{ url: 'https://github.com/example/project', branch: 'master', workspace: 'alice' }]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://github.com/example/project.git/info/refs?service=git-upload-pack');
    expect((await workspace(bindings, 'alice', { op: 'project_get', id: project.id })).platform).toEqual({ repo: `r${'8'.repeat(20)}` });
  } finally { vi.unstubAllGlobals(); }
});
it('creates the platform repository in the owner request and schedules setup outside it', async () => {
  const cookie = await signup('alice');
  const send = vi.fn(async () => {});
  const fake = { ...bindings, AGENT_QUEUE: { send }, ARTIFACTS: await templateArtifacts() } as unknown as Env;
  const response = await projectRoute(new Request('https://yoneda/api/projects', { method: 'POST', headers: { cookie }, body: JSON.stringify({ request_id: 'request-1234567890123456', name: 'New project' }) }), fake, { role: 'user', workspace: 'alice' });
  expect(response?.status).toBe(202);
  const project = await response?.json<Json>();
  expect(project).toMatchObject({ status: 'provisioning' });
  expect((await workspace(bindings, 'alice', { op: 'project_get', id: project?.id })).platform)
    .toEqual({ repo: expect.stringMatching(/^r[0-9a-f]{20}$/) });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'provision', workspace: 'alice' }), { delaySeconds: 0 });
  // The ledger is initialized only by background setup.
  const { ledger } = await import('../../cloudflare/worker/storage');
  await expect(ledger(bindings, project?.id, { op: 'repository_status' })).rejects.toThrow();
  expect(await listed()).toBe(1);
});
it('reschedules a pending import and completes setup from its queue message without a browser', async () => {
  const project = await reserve('https://github.com/example/project');
  await bindNewPlatformRepo(bindings, 'alice', project.id);
  let pending = true;
  const send = vi.fn(async () => {});
  const fake = { ...importing(bindings, () => pending), AGENT_QUEUE: { send } } as unknown as Env;
  const ack = vi.fn(); const retry = vi.fn();
  const message = { body: { v: 1, kind: 'provision', repo_id: project.id, job_id: project.id, workspace: 'alice' }, ack, retry } as unknown as Message<any>;
  await provisionMessage(fake, message);
  expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledExactlyOnceWith(message.body, { delaySeconds: 2 });
  const intent = await workspace(bindings, 'alice', { op: 'project_get', id: project.id });
  expect(intent.status).toBe('provisioning');
  expect(intent.next_dispatch_at).toBeGreaterThan(Date.now());
  expect(intent.setup_retry_at - intent.updated_at).toBe(2000);
  pending = false;
  // Deliver at the real native not-before deadline, without sleeping for the
  // 15-second alarm or forging different JS and Rust clocks.
  await new Promise(resolve => setTimeout(resolve, Math.max(0, intent.setup_retry_at - Date.now()) + 20));
  await provisionMessage(fake, message);
  expect((await workspace(bindings, 'alice', { op: 'project_get', id: project.id })).status).toBe('ready');
  expect(ack).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledOnce();
});
it('keeps an alarm and dispatch intent when the first queue send fails', async () => {
  const project = await reserve();
  const send = vi.fn(async () => { throw new Error('Simulated queue outage'); });
  const fake = { ...bindings, AGENT_QUEUE: { send } } as unknown as Env;
  const pending = await workspace(bindings, 'alice', { op: 'project_dispatches' });
  expect(await enqueueProjects(fake, 'alice', pending.projects)).toEqual([]);
  const stub = bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName('account:alice'));
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
  await runDurableObjectAlarm(stub); // Test service deliberately withholds queue delivery.
  expect((await workspace(bindings, 'alice', { op: 'project_dispatches' })).projects).toContainEqual({ id: project.id, epoch: 0 });
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
});
it('does not repeat platform I/O while another setup attempt holds the durable lease', async () => {
  const project = await reserve();
  await bindNewPlatformRepo(bindings, 'alice', project.id);
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const startedRead = new Promise<void>((resolve) => { started = resolve; });
  let reads = 0;
  const fake = interceptPlatform(bindings, async (path) => {
    if (!path.endsWith('/refs')) return undefined;
    reads++; if (reads === 1) { started(); await waiting; }
    return undefined;
  });
  const first = provisionProject(fake, 'alice', project);
  await startedRead;
  const duplicate = await provisionProject(fake, 'alice', project);
  expect(duplicate.claimed).toBe(false); expect(reads).toBe(1);
  release(); expect((await first).status).toBe('ready');
});
it('accepts complete Git HEAD packets and does not expose opaque SDK error text', () => {
  const data = 'a'.repeat(40) + ' HEAD\0symref=HEAD:refs/heads/release/site agent=test\n';
  const packet = (data.length + 4).toString(16).padStart(4, '0') + data;
  expect(advertisedBranch(packet.slice(0, -4))).toBeNull();
  expect(advertisedBranch(packet)).toBe('release/site');
  expect(advertisedBranch('<html>symref=HEAD:refs/heads/main </html>')).toBeNull();
  expect(setupMessage(new Error('capability-token-secret'))).not.toContain('capability-token-secret');
});
