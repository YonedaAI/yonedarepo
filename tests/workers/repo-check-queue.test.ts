// Check runs start as soon as a container slot is free. The queue consumer that claims a
// run hands it to its CheckContainer and is free once the container is up (it used to wait
// out the whole check, so a burst of runs queued behind each other's runtime while slots
// sat idle). A run that finds no free slot is queued again without spending an attempt,
// and a run held by another executor is looked at again later as a fresh message, so
// neither can exhaust the queue's max_retries and fall into the dead-letter queue.
import { expect, it } from 'vitest';
import { type CheckInstance, launchCheck } from '../../cloudflare/worker/check-container';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

type Sent = { body: Envelope; delay?: number };

/** A platform env whose containers block until released, and whose check queue is recorded. */
function harness(options: { capacity?: () => boolean } = {}) {
  const sent: Sent[] = [];
  const background: Promise<unknown>[] = [];
  const gates: (() => void)[] = [];
  const started: string[] = [];
  const instance = (name: string): CheckInstance => ({
    async startAndWaitForPorts() {
      if (options.capacity && !options.capacity())
        throw new Error('Maximum number of running container instances exceeded. Try again later');
      started.push(name);
    },
    async containerFetch() {
      await new Promise<void>((release) => gates.push(release));
      return Response.json({ outcome: 'pass', exit_code: 0, duration_ms: 1, output_tail: 'ok\n' });
    },
    async destroy() {},
  });
  const env = {
    ...scoped,
    PLATFORM_CHECKS: {
      send: async (body: Envelope, o?: { delaySeconds?: number }) => void sent.push({ body, delay: o?.delaySeconds }),
      sendBatch: async (messages: { body: Envelope }[]) => void sent.push(...messages.map((m) => ({ body: m.body }))),
    },
    CHECK_RUNNERS: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        launch: (job: any, report: any) => launchCheck(instance(name), env, job, report, (work) => background.push(work)),
      }),
    },
  } as unknown as Env;
  const deliver = async (body: Envelope) => {
    const message = { body, attempts: 1, acked: false, retried: false, ack() { this.acked = true; }, retry() { this.retried = true; } };
    await platformJob(env, message as unknown as Message<Envelope>);
    return message;
  };
  const releaseAll = async () => {
    while (gates.length) gates.shift()?.();
    await Promise.all(background);
  };
  return { env, sent, started, deliver, releaseAll, gates };
}

async function repoWithRunner(name: string, env: Env, commits: number) {
  const cookie = await signup(name);
  const policy = { required_checks: ['unit'], approvals: 0, runners: { unit: { command: ['sh', '-c', 'test'], timeout_seconds: 60 } } };
  const created = await api('/repos', { cookie }, { body: { name, policy, files: [file('a.txt', 'a\n')], author } }, env);
  const repo = `/repos/${created.body.id}`;
  const shas: string[] = [];
  for (let i = 0; i < commits; i++) {
    const made = await api(`${repo}/commits`, { cookie }, { body: { ref: 'main', changes: [file(`f${i}.txt`, `${i}\n`)], message: `c${i}`, author } }, env);
    shas.push(made.body.commit);
  }
  const run = async (sha: string) => (await api(`${repo}/commits/${sha}`, { cookie }, {}, env)).body.check_runs[0];
  return { shas, run };
}

const within = <T>(work: Promise<T>, ms: number) =>
  Promise.race([work.then(() => 'free' as const), new Promise<'held'>((r) => setTimeout(() => r('held'), ms))]);

it('frees the consumer once the container is up, so the next run starts while the first runs', async () => {
  const h = harness();
  const { shas, run } = await repoWithRunner('queue_handoff', h.env, 2);
  // The two commits' runs (the repository's first commit queued one too).
  const messages = h.sent.splice(0).map((m) => m.body).slice(-2);

  // One consumer, two runs: the second is claimed and started while the first still runs.
  expect(await within(h.deliver(messages[0]), 2000)).toBe('free');
  expect(await within(h.deliver(messages[1]), 2000)).toBe('free');
  expect(h.started).toHaveLength(2);
  expect(h.gates).toHaveLength(2);
  for (const sha of shas) expect((await run(sha)).status).toBe('running');
  // Each started run leaves a watchdog: if its executor dies, the run is claimed again once
  // its lease (timeout + 5 min) lapses.
  expect(h.sent).toHaveLength(2);
  for (const m of h.sent) expect(m.delay).toBeGreaterThanOrEqual(60);

  await h.releaseAll();
  for (const sha of shas) expect((await run(sha)).status).toBe('passed');
  // The watchdog finds the run done and changes nothing.
  const watchdog = await h.deliver(h.sent[0].body);
  expect([watchdog.acked, watchdog.retried]).toEqual([true, false]);
});

it('queues a run again without spending an attempt while no container slot is free', async () => {
  let free = false;
  const h = harness({ capacity: () => free });
  const { shas, run } = await repoWithRunner('queue_capacity', h.env, 1);
  let message = h.sent.splice(0).at(-1)!.body;
  // More refusals than the run has attempts (3): it waits, it never errors.
  for (let i = 0; i < 5; i++) {
    const delivered = await h.deliver(message);
    expect([delivered.acked, delivered.retried]).toEqual([true, false]);
    expect(await run(shas[0])).toMatchObject({ status: 'queued', epoch: 0 });
    const again = h.sent.splice(0);
    expect(again).toHaveLength(1);
    expect(again[0].delay).toBeLessThanOrEqual(5);
    message = again[0].body;
  }
  free = true;
  await h.deliver(message);
  await h.releaseAll();
  expect(await run(shas[0])).toMatchObject({ status: 'passed', epoch: 1 });
});

it('looks at a run held by another executor again as a fresh message, never a retry', async () => {
  const h = harness();
  const { shas, run } = await repoWithRunner('queue_busy', h.env, 1);
  const message = h.sent.splice(0).at(-1)!.body;
  await h.deliver(message);
  h.sent.length = 0;
  // Duplicate deliveries while the first executor holds the lease: well past max_retries.
  for (let i = 0; i < 5; i++) {
    const duplicate = await h.deliver(message);
    expect([duplicate.acked, duplicate.retried]).toEqual([true, false]);
  }
  expect(h.sent).toHaveLength(5);
  for (const m of h.sent) expect(m.delay).toBeGreaterThan(0);
  expect((await run(shas[0])).status).toBe('running');
  await h.releaseAll();
  expect((await run(shas[0])).status).toBe('passed');
});
