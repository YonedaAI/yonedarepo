// A check container runs untrusted code exactly once and must be gone afterwards. The
// runtime is PID 1 without a SIGTERM handler, so a polite stop is ignored and the instance
// would hold one of the few container slots forever: every outcome must end in a kill.
import { expect, it } from 'vitest';
import { type CheckInstance, type CheckJob, executeCheck, startCheck } from '../../cloudflare/worker/check-container';

const runCheckOnce = async (instance: CheckInstance, job: CheckJob) => executeCheck(instance, job, await startCheck(instance));

function instance(behavior: { start?: Error; status?: number; noStream?: boolean }) {
  const calls: string[] = [];
  const requests: Request[] = [];
  const fake: CheckInstance = {
    async startAndWaitForPorts() {
      calls.push('start');
      if (behavior.start) throw behavior.start;
    },
    async containerFetch(request) {
      calls.push('fetch');
      requests.push(request);
      if (behavior.noStream && new URL(request.url).pathname === '/check/stream')
        return new Response('not found', { status: 404 });
      const status = behavior.status ?? 200;
      return Response.json(status === 200 ? { outcome: 'pass' } : { error: { code: 'X', message: 'bad' } }, { status });
    },
    async destroy() {
      calls.push('destroy');
    },
  };
  return { fake, calls, requests };
}
const job = { command: ['true'], timeout_seconds: 5, files: [] };

it('kills the instance after a finished check', async () => {
  const { fake, calls } = instance({});
  expect(await runCheckOnce(fake, job)).toEqual({ outcome: 'pass', start_ms: expect.any(Number) });
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

/** Parses a streamed check body the way the runtime's FrameReader does. */
function frames(body: Uint8Array) {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const text = (from: number, to: number) => new TextDecoder().decode(body.subarray(from, to));
  expect(text(0, 6)).toBe('YCHK1\n');
  const headerLength = view.getUint32(6);
  let at = 10 + headerLength;
  const header = JSON.parse(text(10, at));
  const files: { kind: number; path: string; data: string }[] = [];
  for (;;) {
    const kind = body[at++];
    if (kind === 0) break;
    const pathLength = view.getUint16(at);
    const path = text(at + 2, at + 2 + pathLength);
    at += 2 + pathLength;
    const dataLength = view.getUint32(at);
    files.push({ kind, path, data: text(at + 4, at + 4 + dataLength) });
    at += 4 + dataLength;
  }
  expect(at).toBe(body.length);
  return { header, files };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const shipped = {
  command: ['sh', '-c', 'test'],
  timeout_seconds: 7,
  files: [
    { path: 'a.txt', type: 'blob', data: bytes('good\n') },
    { path: 'bin/run', type: 'exec', data: bytes('#!/bin/sh\n') },
    { path: 'link', type: 'symlink', data: bytes('a.txt') },
    { path: 'empty', type: 'blob', data: new Uint8Array() },
  ],
};

it('streams the files as raw binary frames, not base64 JSON', async () => {
  const { fake, requests } = instance({});
  await runCheckOnce(fake, shipped);
  expect(requests.map((r) => new URL(r.url).pathname)).toEqual(['/check/stream']);
  expect(requests[0].headers.get('content-type')).toBe('application/vnd.yoneda.check-stream');
  const { header, files } = frames(new Uint8Array(await requests[0].arrayBuffer()));
  expect(header).toEqual({ command: ['sh', '-c', 'test'], timeout_seconds: 7 });
  expect(files).toEqual([
    { kind: 1, path: 'a.txt', data: 'good\n' },
    { kind: 2, path: 'bin/run', data: '#!/bin/sh\n' },
    { kind: 3, path: 'link', data: 'a.txt' },
    { kind: 1, path: 'empty', data: '' },
  ]);
});

it('falls back to the JSON form on a runtime image without the stream route', async () => {
  const { fake, calls, requests } = instance({ noStream: true });
  expect(await runCheckOnce(fake, shipped)).toMatchObject({ outcome: 'pass' });
  expect(requests.map((r) => new URL(r.url).pathname)).toEqual(['/check/stream', '/check']);
  const body = await requests[1].json<any>();
  expect(body.files[0]).toEqual({ path: 'a.txt', type: 'blob', data_b64: btoa('good\n') });
  expect(body.files[3]).toEqual({ path: 'empty', type: 'blob', data_b64: '' });
  expect(calls.at(-1)).toBe('destroy');
});
