import { env } from 'cloudflare:workers';
import { reset, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { projectRoute, provisionProject, sitePolicy } from '../../cloudflare/worker/projects';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { provisionMessage, enqueueProjects } from '../../cloudflare/worker/project-provisioning';
import { advertisedBranch, setupMessage } from '../../cloudflare/worker/project-remote';

const bindings = env as unknown as Env;
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
async function reserve(source: string | null = null) {
  await workspace(bindings, 'alice', { op: 'signup', username: 'alice', password: 'a long test password', salt: '01'.repeat(16), recovery_hash: 'b'.repeat(64), session_hash: 'a'.repeat(64) });
  return workspace(bindings, 'alice', { op: 'project_reserve', id: 'project-one', name: 'Portfolio', source, policy: sitePolicy });
}
function remote(head = 'c'.repeat(40)) {
  return { [Symbol.dispose]() {}, info: async () => ({ defaultBranch: 'main' }), log: async () => head ? [{ hash: head }] : [], listTokens: async () => ({ tokens: [] }), revokeToken: async () => true, readCommit: async () => ({ treeHash: 'd'.repeat(40) }), readTree: async () => [{ name: 'README.md', type: 'blob', hash: 'e'.repeat(40) }], readBlob: async () => new Blob(['Source']) };
}
it('does not restart an import when its deterministic target already exists', async () => {
  const project = await reserve('https://github.com/example/project');
  const start = vi.fn(async () => ({ token: 'initial' }));
  const fake = { ...bindings, ARTIFACTS: { get: async () => remote(), import: start } } as unknown as Env;
  expect((await provisionProject(fake, 'alice', project)).status).toBe('ready');
  expect(start).not.toHaveBeenCalled();
});
it('recognizes the numeric Artifacts import-in-progress code without creating again', async () => {
  const project = await reserve('https://github.com/example/project');
  const start = vi.fn(async () => { throw Object.assign(new Error('import pending'), { code: 10302 }); });
  const fake = { ...bindings, ARTIFACTS: { get: async () => { throw Object.assign(new Error('import pending'), { code: 10302 }); }, import: start } } as unknown as Env;
  expect((await provisionProject(fake, 'alice', project)).status).toBe('provisioning');
  expect(start).not.toHaveBeenCalled();
});
it('reports a ready repository with no default-branch commits instead of spinning forever', async () => {
  const project = await reserve();
  const fake = { ...bindings, ARTIFACTS: { get: async () => remote(''), import: async () => ({ token: 'initial' }) } } as unknown as Env;
  const result = await provisionProject(fake, 'alice', project);
  expect(result.status).toBe('failed');
  expect(result.error_code).toBe('EMPTY_REPOSITORY');
  expect(result.error).toContain('commit');
});
it('recovers an imported master branch when Artifacts metadata incorrectly reports main', async () => {
  const project = await reserve('https://github.com/example/project');
  const packet = 'c'.repeat(40) + ' HEAD\0multi_ack symref=HEAD:refs/heads/master agent=test\n';
  const fetch = vi.fn(async (..._args: unknown[]) => new Response('001e# service=git-upload-pack\n0000' + (packet.length + 4).toString(16).padStart(4, '0') + packet + '0000'));
  vi.stubGlobal('fetch', fetch);
  const target = { ...remote(), log: async ({ ref }: { ref: string }) => ref === 'master' ? [{ hash: 'c'.repeat(40) }] : [] };
  try {
    const fake = { ...bindings, ARTIFACTS: { get: async () => target } } as unknown as Env;
    const result = await provisionProject(fake, 'alice', project);
    expect(result.status).toBe('ready');
    const { ledger } = await import('../../cloudflare/worker/storage');
    expect((await ledger(bindings, project.id, { op: 'snapshot', _workspace: 'alice' })).repository.remote.branch).toBe('master');
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://github.com/example/project.git/info/refs?service=git-upload-pack');
  } finally { vi.unstubAllGlobals(); }
});
it('returns a reserved project immediately and schedules setup outside the browser request', async () => {
  await reserve();
  const send = vi.fn(async () => {});
  const get = vi.fn(async () => { throw new Error('Browser must not wait for Artifacts'); });
  const fake = { ...bindings, AGENT_QUEUE: { send }, ARTIFACTS: { get } } as unknown as Env;
  const response = await projectRoute(new Request('https://yoneda/api/projects', { method: 'POST', body: JSON.stringify({ request_id: 'request-1234567890123456', name: 'New project' }) }), fake, { role: 'user', workspace: 'alice' });
  expect(response?.status).toBe(202);
  expect(await response?.json()).toMatchObject({ status: 'provisioning' });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'provision', workspace: 'alice' }), { delaySeconds: 0 });
  expect(get).not.toHaveBeenCalled();
});
it('reschedules a pending import and completes setup from its queue message without a browser', async () => {
  const project = await reserve();
  let importing = true;
  const send = vi.fn(async () => {});
  const fake = { ...bindings, AGENT_QUEUE: { send }, ARTIFACTS: { get: async () => {
    if (importing) throw Object.assign(new Error('Pending import'), { code: 'IMPORT_IN_PROGRESS' });
    return remote();
  } } } as unknown as Env;
  const ack = vi.fn(); const retry = vi.fn();
  const message = { body: { v: 1, kind: 'provision', repo_id: project.id, job_id: project.id, workspace: 'alice' }, ack, retry } as unknown as Message<any>;
  await provisionMessage(fake, message);
  expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  const intent = await workspace(bindings, 'alice', { op: 'project_get', id: project.id });
  expect(intent.status).toBe('provisioning');
  expect(intent.next_dispatch_at).toBeGreaterThan(Date.now());
  importing = false;
  await provisionMessage(fake, message);
  expect((await workspace(bindings, 'alice', { op: 'project_get', id: project.id })).status).toBe('ready');
  expect(ack).toHaveBeenCalledTimes(2); expect(send).not.toHaveBeenCalled();
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
it('does not repeat Artifacts I/O while another setup attempt holds the durable lease', async () => {
  const project = await reserve();
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const startedRead = new Promise<void>((resolve) => { started = resolve; });
  let reads = 0;
  const fake = { ...bindings, ARTIFACTS: { get: async () => {
    reads++; if (reads === 1) { started(); await waiting; }
    return remote();
  } } } as unknown as Env;
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
