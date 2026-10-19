// Shared workerd fixture for source-platform tests: real SourceRepository DO SQLite, R2
// and D1, with Artifacts faked at its binding and receive-pack endpoint, and platform
// queue/check containers recorded. Scripted clients only — no agents or providers.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import listing from '../../cloudflare/migrations/0003_platform_repos.sql?raw';
import { fetchRequest } from '../../cloudflare/worker/routes';
import type { Env } from '../../cloudflare/worker/types';

export const bindings = env as unknown as Env;

export const misses: string[] = [];
export const fakeArtifacts = {
  create: async (name: string) => ({ name }),
  get: async (name: string) => ({
    [Symbol.dispose]() {},
    info: async () => ({ remote: `https://artifacts.test/${name}` }),
    createToken: async () => ({ id: 'token-1', plaintext: 'artifact-write-token' }),
    revokeToken: async () => true,
    // Stands in for "the store holds what was pushed": the pushed commit's cache copy.
    readCommit: async (id: string) => {
      const object = await bindings.OBJECTS.get(`platform/v1/${name.slice(3)}/objects/${id}`);
      if (!object) return null;
      const commit = await object.json<{ tree: string; parents: string[] }>();
      return { hash: id, treeHash: commit.tree, parents: commit.parents };
    },
    readTree: async (id: string) => {
      misses.push(`tree:${id}`);
      return null;
    },
    readBlob: async (id: string) => {
      misses.push(`blob:${id}`);
      return null;
    },
  }),
};
// Platform jobs and check containers: the queue records messages; the executor stands in
// for the Container by evaluating the shipped files (the real one is tested in Rust).
export const queued: any[] = [];
export const executed: any[] = [];
export const fakeQueue = {
  send: async (body: any) => void queued.push(body),
  sendBatch: async (messages: { body: any }[]) => void queued.push(...messages.map((m) => m.body)),
};
/** Ref updates the fake Artifacts receive-pack saw (`old new ref`), and refs it refuses. */
export const pushes: string[] = [];
export const refusals = new Set<string>();
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
export const scoped = { ...bindings, ARTIFACTS: fakeArtifacts, PLATFORM_QUEUE: fakeQueue, CHECK_RUNNERS: fakeRunners } as unknown as Env;

/** Registers per-test reset, the D1 listing schema and the Artifacts push endpoint. */
export function usePlatformFixture() {
afterEach(() => {
  vi.restoreAllMocks();
  return reset();
});
beforeEach(async () => {
  for (const statement of listing.split(';').filter((s) => s.trim())) await bindings.INDEX.exec(statement.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim());
  misses.length = 0;
  pushes.length = 0;
  refusals.clear();
  queued.length = 0;
  executed.length = 0;
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://artifacts.test/')) return original(input, init);
    expect(url).toMatch(/\/git-receive-pack$/);
    const body = new Uint8Array(init?.body as ArrayBuffer);
    const command = new TextDecoder().decode(body.subarray(4, body.indexOf(0)));
    const ref = command.split(' ')[2];
    pushes.push(command);
    const ok = refusals.has(ref) ? `ng ${ref} stale info\n` : `ok ${ref}\n`;
    const report = `000eunpack ok\n${(ok.length + 4).toString(16).padStart(4, '0')}${ok}0000`;
    return new Response(report, { headers: { 'content-type': 'application/x-git-receive-pack-result' } });
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
  const response = await fetchRequest(
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

