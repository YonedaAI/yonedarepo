// Shared workerd fixture for source-platform tests: real SourceRepository DO SQLite, R2
// and D1, with platform queue/check containers recorded. Scripted clients only — no agents
// or providers.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import listing from '../../cloudflare/migrations/0003_platform_repos.sql?raw';
import tokens from '../../cloudflare/migrations/0004_platform_tokens.sql?raw';
import members from '../../cloudflare/migrations/0005_platform_members.sql?raw';
import visibility from '../../cloudflare/migrations/0006_platform_repo_visibility.sql?raw';
import activity from '../../cloudflare/migrations/0007_platform_activity.sql?raw';
import handles from '../../cloudflare/migrations/0008_platform_handles.sql?raw';
import accounts from '../../cloudflare/migrations/0009_platform_accounts.sql?raw';
import activitySize from '../../cloudflare/migrations/0010_platform_activity_db_bytes.sql?raw';
import deletedRepos from '../../cloudflare/migrations/0011_platform_deleted_repos.sql?raw';
import accountRegion from '../../cloudflare/migrations/0012_platform_account_region.sql?raw';
import accountInternal from '../../cloudflare/migrations/0013_platform_account_internal.sql?raw';
import adminAuditDetail from '../../cloudflare/migrations/0015_admin_audit_detail.sql?raw';
import visitors from '../../cloudflare/migrations/0016_platform_visitors.sql?raw';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { type CheckReport, completeContainerCheck } from '../../cloudflare/worker/repo-checks';
import { HeadHolder } from '../../cloudflare/worker/repo-head-holder';
import { LandBatcher } from '../../cloudflare/worker/repo-land-batcher';
import { projectObjects } from '../../cloudflare/worker/repo-projection';
import type { Env } from '../../cloudflare/worker/types';

export const bindings = env as unknown as Env;

// Platform jobs and check containers: the queue records messages (delayed ones apart, as
// they are not delivered yet); the executor stands in for the Container by evaluating the
// shipped files (the real one is tested in Rust).
export const queued: any[] = [];
export const delayed: any[] = [];
export const executed: any[] = [];
/** Runs queued object projections (staged commits to the object store), like the consumer. */
export async function drainObjects(target: Env = scoped) {
  const jobs = queued.filter((m) => m.kind === 'platform_objects');
  queued.splice(0, queued.length, ...queued.filter((m) => m.kind !== 'platform_objects'));
  for (const message of jobs) await projectObjects(target, message.repo_id, message.job_id);
}
export const fakeQueue = {
  send: async (body: any, options?: { delaySeconds?: number }) =>
    void (options?.delaySeconds ? delayed : queued).push(body),
  sendBatch: async (messages: { body: any }[]) => void queued.push(...messages.map((m) => m.body)),
};
/** CHECK_RUNNERS standing in for the CheckContainer: `run` evaluates the shipped files at
 * once, then the run completes the way the container completes it. */
export const runners = (run: (job: any, name: string) => Promise<any>) => ({
  idFromName: (name: string) => name,
  get: (name: string) => ({
    launch: async (job: any, report: CheckReport) => completeContainerCheck(scoped, report, await run(job, name)),
  }),
});
export const fakeRunners = runners(async (job, name) => {
  executed.push({ name, job });
  const file = job.files.find((f: any) => f.path === 'a.txt');
  const ok = file && new TextDecoder().decode(file.data).startsWith('good');
  return { outcome: ok ? 'pass' : 'fail', exit_code: ok ? 0 : 1, timed_out: false, duration_ms: 5,
    output_bytes: 4, output_sha256: 'f'.repeat(64), output_tail: ok ? 'ok\n' : 'bad\n' };
});
// Land combiners run in-process too, so their post-land dispatches reach the fakes above.
// Each keeps its due timers and its running step, so a test's teardown can stop them.
type InProcess = { batcher: LandBatcher; timers: Set<ReturnType<typeof setTimeout>>; running: Promise<void> | null };
const combiners = new Map<string, InProcess>();
let combinerEnv: Env | null = null;
/** The environment in-process combiners run under, for a switch their work reads (until the
 * test ends). */
export const runCombinersUnder = (env: Env) => void (combinerEnv = env);
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
    self.batcher = new LandBatcher(combinerEnv ?? scoped, async (ms) => {
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
// The head holder role (`<repo>#head`) runs in-process as in production: isolates read
// main's head and access snapshot from it, never from the authority directly.
const holders = new Map<string, HeadHolder>();
/** Combiners asked to erase themselves, by name. */
export const erasedCombiners: string[] = [];
const holderOf = (name: string) => holders.get(name) ?? holders.set(name, new HeadHolder(scoped)).get(name)!;
export const fakeCombiners = {
  idFromName: (name: string) => name,
  get: (name: string) => ({
    wait: (repo: string, ref: string, ticket: number, timeoutMs: number) =>
      inProcess(name).batcher.wait({ repo, ref }, ticket, timeoutMs),
    submit: (repo: string, ref: string, item: Record<string, unknown>, timeoutMs: number) =>
      inProcess(name).batcher.submit({ repo, ref }, item, timeoutMs),
    head: (repo: string, minVersion: number, since?: number, accessVersion?: string) =>
      holderOf(name).head(repo, minVersion, since, accessVersion),
    access: (repo: string) => holderOf(name).access(repo),
    refresh: async (repo: string, access?: boolean) => holderOf(name).refresh(repo, access),
    trees: (repo: string, root: string, paths: string[], commit?: string) => holderOf(name).trees(repo, root, paths, commit),
    idle: () => holderOf(name).idle(),
    erase: async () => void erasedCombiners.push(name),
  }),
};
/** Stops every in-process combiner: cancels due steps and waits out the running one. */
async function quiesceCombiners() {
  for (const c of combiners.values()) for (const timer of c.timers) clearTimeout(timer);
  await Promise.all([...combiners.values()].map((c) => c.running));
  await Promise.all([...combiners.values()].map((c) => c.batcher.idle()));
  combiners.clear();
  combinerEnv = null;
  await Promise.all([...holders.values()].map((h) => h.idle()));
  holders.clear();
}
export const scoped = { ...bindings, PLATFORM_QUEUE: fakeQueue, CHECK_RUNNERS: fakeRunners, LAND_COMBINERS: fakeCombiners } as unknown as Env;

/** Registers per-test reset and the D1 schema. */
export function usePlatformFixture() {
afterEach(async () => {
  vi.restoreAllMocks();
  // A combiner step still running would meet the reset storage: let it finish first.
  await quiesceCombiners();
  return reset();
});
beforeEach(async () => {
  // Every config running these tests gets the D1 schema (listing and personal-token lookup).
  for (const migration of [listing, tokens, members, visibility, activity, handles, accounts, activitySize, deletedRepos, accountRegion, accountInternal, adminAuditDetail, visitors])
    for (const statement of migration.split(';').filter((s) => s.replace(/--.*$/gm, '').trim()))
      await bindings.INDEX
        .exec(statement.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim())
        // Both setups apply the schema; an added column is there after the first.
        .catch((e) => {
          if (!/duplicate column/i.test(String(e?.message ?? e))) throw e;
        });
  queued.length = 0;
  delayed.length = 0;
  executed.length = 0;
});
}

export async function signup(username: string) {
  const response = await bindings.SELF.fetch('https://yoneda/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Sign-up is by email; the local part (a valid name) becomes the account's handle.
    body: JSON.stringify({ email: `${username}@example.com`, password: 'long platform test password' }),
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
  return { status: response.status, body: await response.json<any>(), headers: response.headers };
}

export const file = (path: string, text: string) => ({ path, content_b64: btoa(text) });
export const author = { name: 'Scripted Client', email: 'client@example.com' };


/** `target` whose authority fails command `op` as an outage does. */
export function failingOp(target: Env, op: string) {
  const namespace = target.SOURCE_REPOS;
  const SOURCE_REPOS = {
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return {
        fetch: (url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          if ([body].flat().some((c) => c.op === op)) return Promise.reject(new Error('internal error; reference = abc123'));
          return stub.fetch(url, init);
        },
      };
    },
  };
  return { ...target, SOURCE_REPOS } as unknown as Env;
}

/** `target` with every authority and commit-shard command counted by op; `take` answers
 * the counts since the last take. */
export function countingOps(target: Env) {
  const ops = new Map<string, number>();
  const counted = (namespace: DurableObjectNamespace) => ({
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return {
        fetch: (url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          for (const c of Array.isArray(body) ? body : [body]) ops.set(c.op, (ops.get(c.op) ?? 0) + 1);
          return stub.fetch(url, init);
        },
      };
    },
  });
  const counting = {
    ...target,
    SOURCE_REPOS: counted(target.SOURCE_REPOS),
    COMMIT_SHARDS: counted(target.COMMIT_SHARDS as DurableObjectNamespace),
  } as unknown as Env;
  const take = () => {
    const seen: Record<string, number> = Object.fromEntries(ops);
    ops.clear();
    return seen;
  };
  return { env: counting, take };
}
