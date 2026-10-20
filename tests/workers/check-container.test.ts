// A check container runs untrusted code exactly once and must be gone afterwards. The
// runtime is PID 1 without a SIGTERM handler, so a polite stop is ignored and the instance
// would hold one of the few container slots forever: every outcome must end in a kill.
import { expect, it } from 'vitest';
import { type CheckInstance, runCheckOnce } from '../../cloudflare/worker/check-container';

function instance(behavior: { start?: Error; status?: number }) {
  const calls: string[] = [];
  const fake: CheckInstance = {
    async startAndWaitForPorts() {
      calls.push('start');
      if (behavior.start) throw behavior.start;
    },
    async containerFetch() {
      calls.push('fetch');
      const status = behavior.status ?? 200;
      return Response.json(status === 200 ? { outcome: 'pass' } : { error: { code: 'X', message: 'bad' } }, { status });
    },
    async destroy() {
      calls.push('destroy');
    },
  };
  return { fake, calls };
}
const job = { command: ['true'], timeout_seconds: 5, files: [] };

it('kills the instance after a finished check', async () => {
  const { fake, calls } = instance({});
  expect(await runCheckOnce(fake, job)).toEqual({ outcome: 'pass' });
  expect(calls).toEqual(['start', 'fetch', 'destroy']);
});

it('kills the instance when the check executor fails', async () => {
  const { fake, calls } = instance({ status: 500 });
  await expect(runCheckOnce(fake, job)).rejects.toThrow('bad');
  expect(calls.at(-1)).toBe('destroy');
});

it('kills the instance when it never became ready', async () => {
  const { fake, calls } = instance({ start: new Error('port timeout') });
  await expect(runCheckOnce(fake, job)).rejects.toThrow('port timeout');
  expect(calls).toEqual(['start', 'destroy']);
});

it('ends a stalled check epoch itself, well before its lease, and kills the instance', async () => {
  const { withDeadline, executorDeadlineMs } = await import('../../cloudflare/worker/repo-checks');
  let killed = false;
  const stalled = new Promise<never>(() => {});
  await expect(
    withDeadline(stalled, 10, async () => {
      killed = true;
    }),
  ).rejects.toMatchObject({ code: 'CHECK_TIMEOUT' });
  expect(killed).toBe(true);
  // The lease is the runner's timeout plus five minutes.
  for (const timeout of [60, 600]) expect(executorDeadlineMs(timeout)).toBeLessThan((timeout + 300) * 1000);
});
