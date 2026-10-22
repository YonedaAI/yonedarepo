// Shared workerd fixture for source-platform tests: real SourceRepository DO SQLite, R2
// and D1, with Artifacts faked at its binding and receive-pack endpoint, and platform
// queue/check containers recorded. Scripted clients only — no agents or providers.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import listing from '../../cloudflare/migrations/0003_platform_repos.sql?raw';
import tokens from '../../cloudflare/migrations/0004_platform_tokens.sql?raw';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { compute } from '../../cloudflare/worker/repo-compute';
import { toBase64 } from '../../cloudflare/worker/repo-objects';
import { LandBatcher } from '../../cloudflare/worker/repo-land-combiner';
import { projectObjects } from '../../cloudflare/worker/repo-projection';
import { PushBatcher } from '../../cloudflare/worker/repo-push-queue';
import type { Env } from '../../cloudflare/worker/types';

export const bindings = env as unknown as Env;

export const misses: string[] = [];
/** What each fake Artifacts repository received, by name then object id. */
export const artifacts = new Map<string, Map<string, any>>();
const held = (name: string) => artifacts.get(name) ?? artifacts.set(name, new Map()).get(name)!;
export const fakeArtifacts = {
  create: async (name: string) => ({ name }),
  get: async (name: string) => ({
    [Symbol.dispose]() {},
    info: async () => ({ remote: `https://artifacts.test/${name}` }),
    createToken: async () => ({ id: 'token-1', plaintext: 'artifact-write-token' }),
    revokeToken: async () => true,
    readCommit: async (id: string) => {
      const commit = held(name).get(id);
      return commit?.kind === 'commit' ? { hash: id, treeHash: commit.tree, parents: commit.parents } : null;
    },
    readTree: async (id: string) => {
      const tree = held(name).get(id);
      if (tree?.kind === 'tree') return tree.entries.map((e: any) => ({ name: e.name, type: e.type, hash: e.id }));
      misses.push(`tree:${id}`);
      return null;
    },
    readBlob: async (id: string) => {
      const blob = held(name).get(id);
      if (blob?.kind === 'blob') return new Blob([Uint8Array.from(atob(blob.data_b64), (c) => c.charCodeAt(0))]);
      misses.push(`blob:${id}`);
      return null;
    },
  }),
};
/** Unpacks a receive-pack body's objects (like the store) with platform compute. */
function unpack(body: Uint8Array, first: string) {
  const at = body.findIndex((_, i) => body[i] === 0x50 && new TextDecoder().decode(body.subarray(i, i + 4)) === 'PACK');
  if (at < 0) return [];
  const line = `${first}\0report-status\n`;
  const head = new TextEncoder().encode(`${(line.length + 4).toString(16).padStart(4, '0')}${line}0000`);
  const single = new Uint8Array(head.length + body.length - at);
  single.set(head);
  single.set(body.subarray(at), head.length);
  return compute({ op: 'receive_pack', body_b64: toBase64(single) }).objects as any[];
}
// Platform jobs and check containers: the queue records messages; the executor stands in
// for the Container by evaluating the shipped files (the real one is tested in Rust).
export const queued: any[] = [];
export const executed: any[] = [];
/** Runs queued object projections (staged commits to the object store), like the consumer. */
export async function drainObjects(target: Env = scoped) {
  const jobs = queued.filter((m) => m.kind === 'platform_objects');
  queued.splice(0, queued.length, ...queued.filter((m) => m.kind !== 'platform_objects'));
  for (const message of jobs) await projectObjects(target, message.repo_id, message.job_id);
}
export const fakeQueue = {
  send: async (body: any) => void queued.push(body),
  sendBatch: async (messages: { body: any }[]) => void queued.push(...messages.map((m) => m.body)),
};
/** Ref updates the fake Artifacts receive-pack saw (`old new ref`), and refs it refuses. */
export const pushes: string[] = [];
export const refusals = new Set<string>();
/** Receive-pack requests the fake saw, how many more it answers "busy" like Artifacts,
 * whether it is down (answers 503), and a gate that holds each answer until it settles. */
export const receivePacks = { requests: 0, busy: 0, down: false, hold: null as Promise<void> | null };
const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
/** The ref-update commands of a receive-pack body, up to its flush packet. */
function commands(body: Uint8Array) {
  const out: string[] = [];
  for (let at = 0; ; ) {
    const length = Number.parseInt(new TextDecoder().decode(body.subarray(at, at + 4)), 16);
    if (!length) return out;
    out.push(new TextDecoder().decode(body.subarray(at + 4, at + length)).split('\0')[0].trim());
    at += length;
  }
}
export const fakeRunners = {
  idFromName: (name: string) => name,
  get: (name: string) => ({
    run: async (job: any) => {
      executed.push({ name, job });
      const file = job.files.find((f: any) => f.path === 'a.txt');
      const ok = file && atob(file.data_b64).startsWith('good');
      return { outcome: ok ? 'pass' : 'fail', exit_code: ok ? 0 : 1, timed_out: false, duration_ms: 5,
        output_bytes: 4, output_sha256: 'f'.repeat(64), output_tail: ok ? 'ok\n' : 'bad\n' };
    },
  }),
};
// The push queue's batching runs in-process, so its receive-packs reach the fake endpoint.
const batchers = new Map<string, PushBatcher>();
export const fakePushQueues = {
  idFromName: (name: string) => name,
  get: (name: string) => {
    if (!batchers.has(name)) batchers.set(name, new PushBatcher());
    return batchers.get(name);
  },
};
// Platform tests choose their object store explicitly; the agent-layer default is R2.
// Land combiners run in-process too, so their post-land dispatches reach the fakes above.
// Each keeps its due timers and its running step, so a test's teardown can stop them.
type InProcess = { batcher: LandBatcher; timers: Set<ReturnType<typeof setTimeout>>; running: Promise<void> | null };
const combiners = new Map<string, InProcess>();
function inProcess(name: string): InProcess {
  let combiner = combiners.get(name);
  if (!combiner) {
    const self: InProcess = { batcher: undefined as unknown as LandBatcher, timers: new Set(), running: null };
    let again = false;
    const run = async () => {
      do {
        again = false;
        await self.batcher.step();
      } while (again);
    };
    self.batcher = new LandBatcher(scoped, async (ms) => {
      const timer = setTimeout(() => {
        self.timers.delete(timer);
        if (self.running) return void (again = true);
        self.running = run().finally(() => {
          self.running = null;
        });
      }, ms);
      self.timers.add(timer);
    });
    combiners.set(name, (combiner = self));
  }
  return combiner;
}
export const fakeCombiners = {
  idFromName: (name: string) => name,
  get: (name: string) => ({
    wait: (repo: string, ref: string, ticket: number, timeoutMs: number) =>
      inProcess(name).batcher.wait({ repo, ref }, ticket, timeoutMs),
    submit: (repo: string, ref: string, item: Record<string, unknown>, timeoutMs: number) =>
      inProcess(name).batcher.submit({ repo, ref }, item, timeoutMs),
  }),
};
/** Stops every in-process combiner: cancels due steps and waits out the running one. */
async function quiesceCombiners() {
  for (const c of combiners.values()) for (const timer of c.timers) clearTimeout(timer);
  await Promise.all([...combiners.values()].map((c) => c.running));
  await Promise.all([...combiners.values()].map((c) => c.batcher.idle()));
  combiners.clear();
}
export const scoped = { ...bindings, PLATFORM_OBJECT_STORE: undefined, ARTIFACTS: fakeArtifacts, PLATFORM_QUEUE: fakeQueue, CHECK_RUNNERS: fakeRunners, OBJECT_PUSHES: fakePushQueues, LAND_COMBINERS: fakeCombiners } as unknown as Env;

/** Registers per-test reset, the D1 schema and the Artifacts push endpoint. */
export function usePlatformFixture() {
afterEach(async () => {
  vi.restoreAllMocks();
  // A combiner step still running would meet the reset storage: let it finish first.
  await quiesceCombiners();
  return reset();
});
beforeEach(async () => {
  // Every config running these tests gets the D1 schema (listing and personal-token lookup).
  for (const migration of [listing, tokens])
    for (const statement of migration.split(';').filter((s) => s.replace(/--.*$/gm, '').trim()))
      await bindings.INDEX.exec(statement.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim());
  misses.length = 0;
  artifacts.clear();
  pushes.length = 0;
  refusals.clear();
  receivePacks.requests = 0;
  receivePacks.busy = 0;
  receivePacks.down = false;
  receivePacks.hold = null;
  queued.length = 0;
  executed.length = 0;
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://artifacts.test/')) return original(input, init);
    expect(url).toMatch(/\/git-receive-pack$/);
    const body = new Uint8Array(init?.body as ArrayBuffer);
    receivePacks.requests++;
    if (receivePacks.hold) await receivePacks.hold;
    if (receivePacks.down) return new Response('unavailable', { status: 503 });
    const headers = { 'content-type': 'application/x-git-receive-pack-result' };
    if (receivePacks.busy > 0) {
      receivePacks.busy--;
      return new Response(pkt('ERR artifacts_git_receive_pack_busy'), { headers });
    }
    const name = url.slice('https://artifacts.test/'.length).split('/')[0];
    const received = commands(body);
    if (received[0]) for (const object of unpack(body, received[0])) held(name).set(object.id, object);
    let report = pkt('unpack ok\n');
    for (const command of received) {
      const ref = command.split(' ')[2];
      pushes.push(command);
      report += pkt(refusals.has(ref) ? `ng ${ref} stale info\n` : `ok ${ref}\n`);
    }
    return new Response(`${report}0000`, { headers });
  });
});
}

export async function signup(username: string) {
  const response = await bindings.SELF.fetch('https://yoneda/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'long platform test password' }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}

export async function api(
  path: string,
  auth: { cookie?: string; token?: string },
  init: { method?: string; body?: unknown } = {},
  target: Env = scoped,
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth.cookie) headers.cookie = auth.cookie;
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  const response = await platformFetch(
    new Request(`https://yoneda/api/v1${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    }),
    target,
  );
  return { status: response.status, body: await response.json<any>() };
}

export const file = (path: string, text: string) => ({ path, content_b64: btoa(text) });
export const author = { name: 'Scripted Client', email: 'client@example.com' };

