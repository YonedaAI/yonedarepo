import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { YonedaEntrypoint } from '../../cloudflare/worker/entrypoint';
import { provisionMessage } from '../../cloudflare/worker/project-provisioning';
import { fetchRequest } from '../../cloudflare/worker/routes';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { interceptPlatform, platformJson, templateArtifacts } from './platform-fixture';
import { bindings, signup } from './reviewer-fixture';

afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function fixture(owner: string) {
  const cookie = await signup(owner);
  const send = vi.fn(async (_body: Envelope) => {});
  // Background setup reads the bound platform repository's head; tests may hold or fail it.
  const head = vi.fn(async (): Promise<Response | undefined> => undefined);
  const env = { ...interceptPlatform(bindings, (path) => (/^\/repos\/r[0-9a-f]{20}\/refs$/.test(path) ? head() : undefined)),
    STARTER_REPO: 'test-starter', AGENT_QUEUE: { send }, ARTIFACTS: await templateArtifacts() } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => { pending.push(promise); }) };
  const request = () => new Request('https://yoneda/api/projects', { method: 'POST', headers: { cookie },
    body: JSON.stringify({ request_id: 'background-request-1234567890', name: 'Immediate background setup' }) });
  const fetch = () => YonedaEntrypoint.prototype.fetch.call({ env, ctx } as unknown as YonedaEntrypoint, request());
  return { owner, send, head, env, pending, ctx, request, fetch };
}

it('responds while setup is blocked, starts only after durable queue confirmation, and fences overlapping queue delivery', async () => {
  const f = await fixture('background_fast');
  let sent!: () => void; let confirm!: () => void; let headStarted!: () => void; let finishHead!: () => void;
  const sending = new Promise<void>(resolve => { sent = resolve; });
  const confirmation = new Promise<void>(resolve => { confirm = resolve; });
  const started = new Promise<void>(resolve => { headStarted = resolve; });
  const releaseHead = new Promise<void>(resolve => { finishHead = resolve; });
  f.send.mockImplementationOnce(async body => {
    expect(await workspace(f.env, f.owner, { op: 'project_get', id: body.repo_id })).toMatchObject({ status: 'provisioning', stage: 'queued' });
    sent(); await confirmation;
  });
  f.head.mockImplementationOnce(async () => { headStarted(); await releaseHead; return undefined; });
  const response = f.fetch();
  await sending;
  expect(f.ctx.waitUntil).not.toHaveBeenCalled(); expect(f.head).not.toHaveBeenCalled();
  confirm();
  const result = await response;
  expect(result.status).toBe(202);
  expect(f.ctx.waitUntil).toHaveBeenCalledOnce();
  await started;
  const body = f.send.mock.calls[0][0];
  const active = await workspace(f.env, f.owner, { op: 'project_get', id: body.repo_id });
  const ack = vi.fn(); const retry = vi.fn();
  await provisionMessage(f.env, { body, ack, retry } as unknown as Message<Envelope>);
  expect(f.head).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce();
  expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
  expect((await workspace(f.env, f.owner, { op: 'project_get', id: body.repo_id })).setup_epoch).toBe(active.setup_epoch);
  finishHead();
  await Promise.all(f.pending);
  expect(await workspace(f.env, f.owner, { op: 'project_get', id: body.repo_id })).toMatchObject({ status: 'ready', setup_epoch: 1 });
});

it('preserves two-argument queue-only routing and its workspace alarm fallback', async () => {
  const f = await fixture('background_noctx');
  const result = await fetchRequest(f.request(), f.env);
  expect(result.status).toBe(202); expect(f.send).toHaveBeenCalledOnce();
  expect(f.head).not.toHaveBeenCalled();
  expect(f.pending).toHaveLength(0);
  const stub = f.env.WORKSPACES.get(f.env.WORKSPACES.idFromName(`account:${f.owner}`));
  await runInDurableObject(stub, async (_instance, state) => expect(await state.storage.getAlarm()).not.toBeNull());
});

it('catches a deleted background claim with only a safe platform error code', async () => {
  const f = await fixture('background_deleted');
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.send.mockImplementationOnce(async body => { await workspace(f.env, f.owner, { op: 'project_delete', id: body.repo_id }); });
  expect((await f.fetch()).status).toBe(202);
  expect(f.pending).toHaveLength(1);
  await expect(f.pending[0]).resolves.toBeUndefined();
  expect(f.head).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'project.background_setup_failed', error_code: 'REPOSITORY_DELETED' }));
  expect(JSON.stringify(log.mock.calls)).not.toContain('yrp_');
});

it('schedules a two-second pending background retry after the original queue delivery acknowledged its active lease', async () => {
  const f = await fixture('background_pending');
  let headStarted!: () => void; let finishHead!: () => void;
  const started = new Promise<void>(resolve => { headStarted = resolve; });
  const releaseHead = new Promise<void>(resolve => { finishHead = resolve; });
  f.head.mockImplementationOnce(async () => {
    headStarted(); await releaseHead;
    return platformJson({ error: { code: 'IMPORT_IN_PROGRESS', message: 'Synthetic pending import' } }, 409);
  });
  expect((await f.fetch()).status).toBe(202);
  await started;
  const body = f.send.mock.calls[0][0];
  const ack = vi.fn(); const retry = vi.fn();
  await provisionMessage(f.env, { body, ack, retry } as unknown as Message<Envelope>);
  expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenCalledOnce(); expect(f.head).toHaveBeenCalledOnce();
  finishHead();
  await Promise.all(f.pending);
  expect(await workspace(f.env, f.owner, { op: 'project_get', id: body.repo_id })).toMatchObject({
    status: 'provisioning', setup_epoch: 1, setup_pending_count: 1, lease_until: 0, retry_delay_seconds: 2,
  });
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.send).toHaveBeenLastCalledWith(body, { delaySeconds: 2 });
});
