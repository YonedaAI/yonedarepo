import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { provisionMessage } from '../../cloudflare/worker/project-provisioning';
import { sitePolicy } from '../../cloudflare/worker/site-policy';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';

const bindings = env as unknown as Env;
const owner = 'provision_latency';
const id = 'pending-project';
afterEach(reset);

async function fixture(code: string | number = 'FORK_IN_PROGRESS') {
  await workspace(bindings, owner, { op: 'signup', username: owner, password: 'Synthetic provisioning test password',
    salt: '01'.repeat(16), recovery_hash: 'b'.repeat(64), session_hash: 'a'.repeat(64) });
  await workspace(bindings, owner, { op: 'project_reserve', id, name: 'Pending fork latency', policy: sitePolicy });
  const send = vi.fn(async () => {});
  const get = vi.fn(async () => { throw Object.assign(new Error('Synthetic Artifacts observation'), { code }); });
  const local = { ...bindings, AGENT_QUEUE: { send }, ARTIFACTS: { get } } as unknown as Env;
  const body = { v: 1, kind: 'provision', repo_id: id, job_id: id, workspace: owner } as Envelope;
  const message = (loseAck = false) => ({ body, ack: vi.fn(() => {
    if (loseAck) throw new Error('Synthetic acknowledgment loss');
  }), retry: vi.fn() }) as unknown as Message<Envelope> & { ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> };
  const project = () => workspace(bindings, owner, { op: 'project_get', id });
  return { local, send, get, body, message, project };
}

it.each(['FORK_IN_PROGRESS', 'IMPORT_IN_PROGRESS', 'CREATE_IN_PROGRESS', 10303])(
  'queues the first explicit pending retry in two seconds before acknowledging (%s)', async code => {
    const f = await fixture(code);
    const message = f.message();
    await provisionMessage(f.local, message);
    const pending = await f.project();
    expect(pending).toMatchObject({ status: 'provisioning', lease_until: 0, retry_delay_seconds: 2, setup_pending_count: 1 });
    expect(pending.setup_retry_at - pending.updated_at).toBe(2000);
    expect(pending.next_dispatch_at).toBe(pending.setup_retry_at);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(f.body, { delaySeconds: 2 });
    expect(f.send.mock.invocationCallOrder[0]).toBeLessThan(message.ack.mock.invocationCallOrder[0]);
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
  },
);

it('does not short-poll a duplicate delivery while the native setup lease is active', async () => {
  const f = await fixture();
  const active = await workspace(bindings, owner, { op: 'project_claim', id });
  const message = f.message();
  await provisionMessage(f.local, message);
  expect(f.get).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(message.retry).not.toHaveBeenCalled();
  expect(message.ack).toHaveBeenCalledOnce();
  expect((await f.project()).setup_epoch).toBe(active.setup_epoch);
});

it('does not turn arbitrary Artifacts failures into short pending retries', async () => {
  const f = await fixture('UPSTREAM_UNAVAILABLE');
  const message = f.message();
  await provisionMessage(f.local, message);
  expect(await f.project()).toMatchObject({ status: 'failed', error_code: 'UPSTREAM_UNAVAILABLE' });
  expect(f.send).not.toHaveBeenCalled();
  expect(message.retry).not.toHaveBeenCalled();
  expect(message.ack).toHaveBeenCalledOnce();
});

it('retains durable alarm dispatch intent when the short queue send fails', async () => {
  const f = await fixture();
  f.send.mockRejectedValueOnce(new Error('Synthetic queue failure'));
  const message = f.message();
  await provisionMessage(f.local, message);
  const pending = await f.project();
  expect(pending).toMatchObject({ status: 'provisioning', setup_pending_count: 1, retry_delay_seconds: 2, lease_until: 0 });
  expect(pending.next_dispatch_at).toBe(pending.setup_retry_at);
  expect(message.ack).not.toHaveBeenCalled();
  expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 20 });
  const stub = bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${owner}`));
  await runInDurableObject(stub, async (_instance, state) => expect(await state.storage.getAlarm()).not.toBeNull());
});

it('lost acknowledgment replay does not increment pending backoff or send another early retry', async () => {
  const f = await fixture();
  await provisionMessage(f.local, f.message(true));
  const pending = await f.project();
  const replay = f.message();
  await provisionMessage(f.local, replay);
  expect(await f.project()).toEqual(pending);
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.get).toHaveBeenCalledOnce();
  expect(replay.ack).toHaveBeenCalledOnce();
  expect(replay.retry).not.toHaveBeenCalled();
  await workspace(bindings, owner, { op: 'project_delete', id });
  const deleted = f.message();
  await provisionMessage(f.local, deleted);
  expect(deleted.ack).toHaveBeenCalledOnce();
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.get).toHaveBeenCalledOnce();
});
