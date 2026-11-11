import { expect, it, vi } from 'vitest';
import { sshKeepAlive } from '../../cloudflare/worker/platform-ssh-gateway';
import { log } from '../../cloudflare/worker/log';
import type { Env } from '../../cloudflare/worker/types';
const closed = () => new Error('Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.');
function environment(errors: Error[]) {
  let gets = 0;
  const env = { SSH_FRONT_DOOR: 'tunnel', SSH_GATEWAYS: { idFromName: () => 'gateway', get: () => {
    const index = gets++;
    return { keepAlive: async () => { if (errors[index]) throw errors[index]; return { started: false }; } };
  } } } as unknown as Env;
  return { env, gets: () => gets };
}
it('reconnects to the same gateway through a fresh stub after an inactive-instance failure', async () => {
  const error = vi.spyOn(log, 'error');
  try { const e = environment([closed()]);const result = await sshKeepAlive(e.env, 'cron');
    expect(e.gets()).toBe(2);expect(result).toMatchObject({ status: 'ok' });expect(error).not.toHaveBeenCalled();
  } finally { error.mockRestore(); }
});
it('reports an exhausted recovery once and does not retry permanent errors or overload', async () => {
  const error = vi.spyOn(log, 'error');
  try { for (const [failures, attempts] of [[ [closed(), closed()], 2 ], [ [new Error('SSH gateway secrets are not configured')], 1 ], [ [Object.assign(closed(), { overloaded: true, retryable: true })], 1 ]] as const) {
      error.mockClear();const e = environment([...failures]);const result = await sshKeepAlive(e.env, 'health');
      expect(e.gets()).toBe(attempts);expect(result).toMatchObject({ status: 'failed' });expect(error).toHaveBeenCalledTimes(1);
    }
  } finally { error.mockRestore(); }
});
