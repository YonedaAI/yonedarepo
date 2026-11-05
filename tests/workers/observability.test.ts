// What the platform leaves in the logs when something goes wrong (docs/logging.md): every
// unexpected 500, one shape, one id across hops, and nothing that must not be there.
import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { executeCheck } from '../../cloudflare/worker/check-container';
import { durableJson } from '../../cloudflare/worker/durable';
import { frontFetch } from '../../cloudflare/worker/front-routes';
import { errorText, log, operationOf, scrub, served } from '../../cloudflare/worker/log';
import { PlatformEntrypoint } from '../../cloudflare/worker/platform-entrypoint';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { carriedQueue, inScope } from '../../cloudflare/worker/request-scope';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const REPO = 'r0123456789abcdef0123';

/** The structured lines `spy` received, parsed. */
const lines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([line]) => JSON.parse(String(line)));

/** A platform whose repository authority fails in a way no route expects. */
const broken = (message: string) =>
  ({
    ...bindings,
    BUILD_REVISION: 'abc1234',
    SOURCE_REPOS: {
      idFromName: () => {
        throw new Error(message);
      },
      idFromString: () => {
        throw new Error(message);
      },
      get: () => {
        throw new Error(message);
      },
    },
  }) as unknown as Env;

afterEach(() => vi.restoreAllMocks());

it('logs an unexpected 500 with its operation, code, repository, revision and id', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const res = await platformFetch(
    new Request(`https://yoneda/api/v1/repos/${REPO}/log?ref=main`, {
      headers: { authorization: 'Bearer yrp_abcdefghijklmnopqrstuvwxyz', 'cf-ray': '8f1c2d3e4a5b6c7d-SJC' },
    }),
    broken('the authority fell over'),
  );
  expect(res.status).toBe(500);
  expect(lines(logged)).toEqual([
    {
      event: 'request.failed',
      level: 'error',
      request_id: '8f1c2d3e4a5b6c7d-SJC',
      repo: REPO,
      revision: 'abc1234',
      operation: 'GET /api/v1/repos/:repo/log',
      code: 'INTERNAL',
      status: 500,
      error: 'the authority fell over',
    },
  ]);
});

it('logs what no route caught, and lets it stay an exception for Cloudflare to count', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const req = new Request(`https://yoneda/api/v1/repos/${REPO}/log`);
  await expect(
    served({ env: bindings, req }, async () => {
      throw new Error('nothing caught this');
    }),
  ).rejects.toThrow('nothing caught this');
  expect(lines(logged)).toEqual([
    expect.objectContaining({ event: 'request.failed', code: 'UNCAUGHT', status: 500, repo: REPO, error: 'nothing caught this' }),
  ]);
});

const SECRETS = [
  'Bearer yrp_abcdefghijklmnopqrstuvwxyz0123',
  'https://x:ghp_abcdef0123456789@artifacts.example.com/r.git',
  'https://example.com/?token=plain-short-value',
  'password=hunter2hunter2',
  'yoneda_account=c2Vzc2lvbi12YWx1ZS1oZXJl',
  'ada.lovelace+test@example.com',
  // Joined here so the secret scan does not take this fake for a real one.
  ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0In0', 'c2lnbmF0dXJl'].join('.'),
  'sk-ant-api03-abcdefghijklmnop',
  `${crypto.randomUUID()}${crypto.randomUUID()}`,
];

it.each(SECRETS)('never lets %s reach a log line', (secret) => {
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
  log.warn('test.secret', { error: new Error(`failed with ${secret} attached`), why: secret, reason: { message: secret } });
  const text = String(warned.mock.calls[0][0]);
  const shown = secret.replace(/^(Bearer |password=|yoneda_account=)/, '');
  expect(text).not.toContain(shown);
  expect(JSON.parse(text).event).toBe('test.secret');
});

it('keeps what an operator needs from a scrubbed message', () => {
  const sha = 'a'.repeat(40);
  expect(scrub(`commit ${sha} is missing`)).toBe(`commit ${sha} is missing`);
  expect(scrub('8f1c2d3e-4a5b-4c7d-8e9f-0123456789ab')).toBe('8f1c2d3e-4a5b-4c7d-8e9f-0123456789ab');
  expect(scrub('No answer within 500 ms')).toBe('No answer within 500 ms');
  expect(scrub('x'.repeat(9000)).length).toBeLessThanOrEqual(500);
});

it('drops every field that is not allow-listed, however it got there', () => {
  const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
  const spread = { authorization: 'Bearer x', content_b64: 'c2VjcmV0', email: 'a@b.test', objects: 3 };
  log.info('test.fields', { ...spread, fetch: { ...spread }, repo: REPO });
  expect(lines(logged)).toEqual([{ event: 'test.fields', level: 'info', repo: REPO, objects: 3, fetch: { objects: 3 } }]);
});

it('does not quote what a JSON parser failed on: that can be a file', () => {
  const failed = (() => {
    try {
      JSON.parse('private file content');
    } catch (e) {
      return e;
    }
  })();
  expect(errorText(failed)).toBe('SyntaxError');
  expect(errorText(new Error('Unexpected token \'p\', "private fi"... is not valid JSON'))).toBe('SyntaxError');
});

it('puts event first: Superfan and the SSH test match on it', () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  log.error('compaction.stalled', { repo: REPO, head: 1 });
  expect(String(logged.mock.calls[0][0])).toMatch(/^\{"event":"compaction\.stalled",/);
});

it('cannot fail or throw into the caller, and bounds a line', () => {
  const huge = vi.spyOn(console, 'log').mockImplementation(() => {});
  const fields = Object.fromEntries(['why', 'reason', 'message', 'error', 'path', 'url', 'line', 'id', 'label', 'name'].map((k) => [k, 'x y'.repeat(300)]));
  log.info('test.huge', { ...fields, tail: Array.from({ length: 20 }, () => 'x y'.repeat(300)) });
  const written = String(huge.mock.calls[0][0]);
  expect(written.length).toBeLessThanOrEqual(4000);
  expect(JSON.parse(written)).toMatchObject({ event: 'test.huge', truncated: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {
    throw new Error('the console is gone');
  });
  expect(() => log.warn('test.gone')).not.toThrow();
  const hostile = {
    get error(): unknown {
      throw new Error('a getter that throws');
    },
  };
  expect(() => log.error('test.hostile', hostile)).not.toThrow();
});

it.each([
  ['/api/v1/repos/r0123456789abcdef0123/files/secret/plan.md', 'GET /api/v1/repos/:repo/files'],
  ['/api/v1/resolve/some-handle/private-name', 'GET /api/v1/resolve/:id'],
  ['/api/v1/orgs/some-org/audit', 'GET /api/v1/orgs/:id'],
  ['/api/v1/search', 'GET /api/v1/search'],
  ['/git/r0123456789abcdef0123.git/info/refs', 'GET /git/:repo'],
  ['/some-handle/private-name.git/info/refs', 'GET /:path'],
])('names %s as a route, not a path', (path, operation) => {
  expect(operationOf(new Request(`https://yoneda${path}?token=x`))).toBe(operation);
});

const entry = (target: Env) => new PlatformEntrypoint(createExecutionContext(), target);
const on = (target: Env = bindings) => ({ ...target, REQUEST_IDS: 'on' }) as Env;

it('returns the id on every response, and only with REQUEST_IDS on', async () => {
  const health = () => new Request('https://yoneda/health', { headers: { 'cf-ray': '8f1c2d3e4a5b6c7d-SJC' } });
  expect((await entry(bindings).fetch(health())).headers.has('x-request-id')).toBe(false);
  expect((await entry(on()).fetch(health())).headers.get('x-request-id')).toBe('8f1c2d3e4a5b6c7d-SJC');
  // A redirect's headers are immutable.
  const redirect = await entry(on()).fetch(new Request('https://yoneda/explore', { redirect: 'manual' }));
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get('location')).toContain('/source/explore');
  expect(redirect.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
});

it('takes the edge ray over a sent id, a sent id over nothing, and never a malformed one', async () => {
  const id = async (headers: Record<string, string>) =>
    (await entry(on()).fetch(new Request('https://yoneda/health', { headers }))).headers.get('x-request-id');
  expect(await id({ 'cf-ray': '8f1c2d3e4a5b6c7d-SJC', 'x-request-id': 'forged-id-123' })).toBe('8f1c2d3e4a5b6c7d-SJC');
  expect(await id({ 'x-request-id': 'sent-by-the-front-1' })).toBe('sent-by-the-front-1');
  expect(await id({ 'x-request-id': 'not an id"}' })).toMatch(/^[0-9a-f-]{36}$/);
  expect(await id({ 'cf-ray': 'garbage' })).toMatch(/^[0-9a-f-]{36}$/);
});

it('carries the id over a service binding, with or without a ray', async () => {
  const seen: (string | null)[] = [];
  const platform = {
    fetch: async (req: Request) => {
      seen.push(req.headers.get('x-request-id'));
      return Response.json({ auth: req.headers.get('authorization'), body: await req.text() });
    },
  };
  const front = { ...bindings, REQUEST_IDS: 'on', PLATFORM: platform } as unknown as Env;
  const ask = (headers: Record<string, string>) =>
    new Request(`https://yoneda/api/v1/repos/${REPO}/commits`, { method: 'POST', headers, body: 'sent' });
  const res = await served({ env: front, req: ask({ 'cf-ray': '8f1c2d3e4a5b6c7d-SJC' }) }, () =>
    frontFetch(ask({ 'cf-ray': '8f1c2d3e4a5b6c7d-SJC', authorization: 'Bearer t' }), front),
  );
  expect(seen).toEqual(['8f1c2d3e4a5b6c7d-SJC']);
  expect(await res.json()).toEqual({ auth: 'Bearer t', body: 'sent' });
  expect(res.headers.get('x-request-id')).toBe('8f1c2d3e4a5b6c7d-SJC');
});

it('reaches the Durable Object: a statement that fails there logs the same id', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const owner = { cookie: await signup('observer') };
  const created = await api('/repos', owner, { body: { name: 'traced', files: [file('a.txt', 'a\n')], author } });
  await runInDurableObject(bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(created.body.id)), async (_o, state) =>
    state.storage.sql.exec('ALTER TABLE refs RENAME TO refs_gone').toArray(),
  );
  const res = await entry(on(scoped)).fetch(
    new Request(`https://yoneda/api/v1/repos/${created.body.id}/refs`, {
      headers: { cookie: owner.cookie, 'cf-ray': '8f1c2d3e4a5b6c7d-SJC' },
    }),
  );
  expect(res.status).toBe(400);
  const events = lines(errors).filter((l) => l.request_id === '8f1c2d3e4a5b6c7d-SJC').map((l) => l.event);
  expect(events).toContain('repo.command_failed');
  expect(events).toContain('request.failed');
});

it('sends nothing extra to a Durable Object with REQUEST_IDS off', async () => {
  const sent: (HeadersInit | undefined)[] = [];
  const stub = { fetch: async (_url: string, init: RequestInit) => (sent.push(init.headers), Response.json({})) };
  await durableJson(() => stub as unknown as DurableObjectStub, 'https://x/', '{}');
  expect(sent).toEqual([undefined]);
  await inScope({ env: { REQUEST_IDS: 'on' }, req: new Request('https://x', { headers: { 'cf-ray': '8f1c2d3e4a5b6c7d' } }) }, () =>
    durableJson(() => stub as unknown as DurableObjectStub, 'https://x/', '{}'),
  );
  expect(sent[1]).toEqual({ 'x-request-id': '8f1c2d3e4a5b6c7d' });
});

const fakeQueue = () => {
  const sent: any[] = [];
  return {
    sent,
    send: async (body: unknown) => void sent.push(body),
    sendBatch: async (messages: { body: unknown }[]) => void sent.push(...messages.map((m) => m.body)),
  };
};
const scopeOn = { env: { REQUEST_IDS: 'on' }, req: new Request('https://x', { headers: { 'cf-ray': '8f1c2d3e4a5b6c7d-SJC' } }) };
const body = { v: 1, kind: 'platform_objects', repo_id: REPO, job_id: 'objects' } as Envelope;

it('carries queue delay independently of request ids, sends and batches alike', async () => {
  const queue = fakeQueue();
  const typed = queue as unknown as Queue<Envelope>;
  await inScope({ env: {} }, () => carriedQueue(typed).send(body));
  await inScope(scopeOn, async () => {
    await carriedQueue(typed).send(body);
    await carriedQueue(typed).sendBatch([{ body }]);
  });
  expect(queue.sent).toEqual([{ ...body, queue_delay_ms: 0 }, { ...body, queue_delay_ms: 0, request_id: '8f1c2d3e4a5b6c7d-SJC' }, { ...body, queue_delay_ms: 0, request_id: '8f1c2d3e4a5b6c7d-SJC' }]);
});

it('carries send and per-message batch delays with Cloudflare precedence', async () => {
  const queue = fakeQueue();
  const carried = carriedQueue(queue as unknown as Queue<Envelope>);
  await carried.send(body, { delaySeconds: 43200 });
  await carried.sendBatch([{ body }, { body, delaySeconds: 5 }], { delaySeconds: 10 });
  expect(queue.sent.map((b: any) => b.queue_delay_ms)).toEqual([43200000, 10000, 5000]);
});

const failingJob = (message: object) => {
  const retry = vi.fn();
  const batch = { messages: [{ body: message, attempts: 1, ack: vi.fn(), retry }] };
  return { batch: batch as unknown as MessageBatch<Envelope>, retry };
};
it('a queue job logs the id its message carries, as a Worker from before or after a deploy reads it', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const job = { v: 1, kind: 'platform_objects', repo_id: REPO, job_id: 'objects', request_id: '8f1c2d3e4a5b6c7d-SJC', later_field: { any: 'shape' } };
  const { batch, retry } = failingJob(job);
  await entry(broken('the queue job fell over')).queue(batch);
  expect(retry).toHaveBeenCalledOnce();
  expect(lines(errors)).toContainEqual(
    expect.objectContaining({ event: 'job.failed', request_id: '8f1c2d3e4a5b6c7d-SJC', repo: REPO, job: 'objects', kind: 'platform_objects', error: 'the queue job fell over' }),
  );
});

it('a message from before the field still runs, under an id of its own', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { batch, retry } = failingJob({ v: 1, kind: 'platform_objects', repo_id: REPO, job_id: 'objects' });
  await entry(broken('the queue job fell over')).queue(batch);
  expect(retry).toHaveBeenCalledOnce();
  const [line] = lines(errors).filter((l) => l.event === 'job.failed');
  expect(line.request_id).toMatch(/^[0-9a-f-]{36}$/);
  // Nothing a producer put there can reach a log line unchecked.
  const forged = failingJob({ ...body, request_id: 'not an id"}\n' });
  await entry(broken('again')).queue(forged.batch);
  expect(lines(errors).filter((l) => l.error === 'again')[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
});

it('reaches the container on the check request, and only when the job names it', async () => {
  const asked: Headers[] = [];
  const instance = {
    startAndWaitForPorts: async () => {},
    destroy: async () => {},
    containerFetch: async (req: Request) => {
      asked.push(req.headers);
      await req.arrayBuffer();
      return Response.json({ ok: true });
    },
  };
  const job = { command: ['true'], timeout_seconds: 5, files: [] };
  await executeCheck(instance, { ...job, request_id: '8f1c2d3e4a5b6c7d-SJC' }, { secret: 's', startMs: 1 });
  await executeCheck(instance, job, { secret: 's', startMs: 1 });
  expect(asked.map((h) => h.get('x-request-id'))).toEqual(['8f1c2d3e4a5b6c7d-SJC', null]);
});
