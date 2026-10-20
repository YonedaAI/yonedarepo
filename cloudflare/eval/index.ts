// The N9 eval Worker (agent-layer side, deployed separately from the platform). It runs
// fixed evaluation arms with real models and returns their metrics; it is not a model
// proxy: callers choose only an arm (provider, layout, interface, seed, sizes) and the
// repository + token it runs against, never prompts. Every request needs the bearer
// secret; the platform is reached only through its public API with that repo token.
import { promptsDigest, runArm, smoke } from './arm';
import { capOf, HARD_CAP_MICROUSD } from './ledger';
import {
  ArmError,
  type Ledger,
  type Limits,
  PROVIDERS,
  type ProviderId,
  resolveRoute,
} from './model';
import { runP9, SCHEDULERS, type Scheduler } from './p9';
import { type Api, INTERFACES, type Interface, LAYOUTS, type Layout } from './study';
import type { EvalEnv } from './types';

export { SpendLedger } from './ledger';

/** Fixed per-request and per-arm limits; callers can narrow sizes, never raise these. */
export const LIMITS = {
  maxOutputTokens: 2048,
  requestTimeoutMs: 120_000,
  maxRetries: 3,
  backoffMs: 2_000,
  armWallClockMs: 15 * 60_000,
  maxTasks: 8,
  maxTurns: 12,
  checkTimeoutMs: 5 * 60_000,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refuse = (code: string, message: string, status: number) =>
  json({ error: { code, message } }, status);

/**
 * Arms run for minutes: headers go out at once and a space every 20 s keeps the client and
 * any proxy from timing out; the JSON result (leading whitespace is valid JSON) follows.
 * Failures after validation arrive as an `error` body, since the status is already sent.
 */
function streamed(work: () => Promise<unknown>) {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const beat = setInterval(() => writer.write(encoder.encode(' ')).catch(() => {}), 20_000);
  const finish = async () => {
    let body: unknown;
    try {
      body = await work();
    } catch (e) {
      body = {
        error: { code: e instanceof ArmError ? e.code : 'INTERNAL', message: 'Eval run failed' },
      };
    }
    clearInterval(beat);
    await writer.write(encoder.encode(JSON.stringify(body)));
    await writer.close();
  };
  finish().catch(() => clearInterval(beat));
  return new Response(readable, { headers: { 'content-type': 'application/json' } });
}

async function sha256(text: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** Fails closed: no configured secret (or a short one) refuses everything. */
async function authorized(request: Request, env: EvalEnv) {
  const secret = env.EVAL_TOKEN ?? '';
  const header = request.headers.get('authorization') ?? '';
  if (secret.length < 32 || !header.startsWith('Bearer ')) return false;
  const [given, expected] = await Promise.all([sha256(header.slice(7)), sha256(secret)]);
  return crypto.subtle.timingSafeEqual(given, expected);
}

function platformApi(env: EvalEnv, repo: string, token: string): Api {
  return async (path, init = {}) => {
    const response = await env.PLATFORM.fetch(
      new Request(`https://platform/api/v1/repos/${repo}${path}`, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
    );
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
}

const ledgerOf = (env: EvalEnv): Ledger =>
  env.SPEND.get(env.SPEND.idFromName('global')) as unknown as Ledger;

function field<T>(ok: boolean, value: T, name: string): T {
  if (!ok) throw new ArmError('INVALID_INPUT', `Invalid ${name}`);
  return value;
}
const integer = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

function provider(body: Record<string, any>): ProviderId {
  return field(PROVIDERS.includes(body.provider), body.provider, 'provider');
}
function run(body: Record<string, any>): string {
  return field(typeof body.run === 'string' && /^[\w.-]{1,64}$/.test(body.run), body.run, 'run');
}
const repoId = (value: unknown) =>
  field(typeof value === 'string' && /^r[0-9a-f]{20}$/.test(value), value as string, 'repo');
const repoToken = (value: unknown) =>
  field(typeof value === 'string' && /^yrp_[\w-]{20,}$/.test(value), value as string, 'token');
const maxTurns = (value: unknown) =>
  field(integer(value ?? 10, 1, LIMITS.maxTurns), (value ?? 10) as number, 'max_turns');

function limits(deadlineMs: number, maxRequests: number, backoffMs: number): Limits {
  return {
    maxRequests,
    deadline: Date.now() + deadlineMs,
    maxOutputTokens: LIMITS.maxOutputTokens,
    requestTimeoutMs: LIMITS.requestTimeoutMs,
    maxRetries: LIMITS.maxRetries,
    backoffMs,
  };
}

export async function handle(
  request: Request,
  env: EvalEnv,
  timing = { backoffMs: LIMITS.backoffMs, pollMs: 5_000 },
) {
  if (!(await authorized(request, env))) return refuse('UNAUTHORIZED', 'Unauthorized', 401);
  const url = new URL(request.url);
  try {
    if (request.method === 'GET' && url.pathname === '/v1/spend')
      return json({
        ...(await env.SPEND.get(env.SPEND.idFromName('global')).totals()),
        hard_cap_microusd: HARD_CAP_MICROUSD,
      });
    if (request.method !== 'POST') return refuse('NOT_FOUND', 'Unknown path', 404);
    const body = (await request.json().catch(() => null)) as Record<string, any> | null;
    if (!body || typeof body !== 'object')
      throw new ArmError('INVALID_INPUT', 'JSON body required');
    if (capOf(env.EVAL_SPEND_CAP_MICROUSD) === 0)
      throw new ArmError('NOT_CONFIGURED', 'No spend cap configured');
    if (url.pathname === '/v1/smoke') {
      const route = await resolveRoute(env, provider(body));
      return json(
        await smoke(
          route,
          ledgerOf(env),
          run(body),
          limits(LIMITS.requestTimeoutMs, 1, timing.backoffMs),
        ),
      );
    }
    if (url.pathname === '/v1/arms') {
      const spec = {
        run: run(body),
        layout: field(LAYOUTS.includes(body.layout), body.layout as Layout, 'layout'),
        interface: field(
          INTERFACES.includes(body.interface),
          body.interface as Interface,
          'interface',
        ),
        seed: field(integer(body.seed, 0, 2 ** 31 - 1), body.seed as number, 'seed'),
        tasks: field(integer(body.tasks, 1, LIMITS.maxTasks), body.tasks as number, 'tasks'),
        drop_rate: field(
          typeof body.drop_rate === 'number' && body.drop_rate >= 0 && body.drop_rate <= 1,
          body.drop_rate as number,
          'drop_rate',
        ),
        max_turns: maxTurns(body.max_turns),
      };
      const repo = repoId(body.repo);
      const token = repoToken(body.token);
      const route = await resolveRoute(env, provider(body));
      // Requests include retries: each task's turns once, plus room for backoff retries.
      const maxRequests = spec.tasks * spec.max_turns + 2 * LIMITS.maxRetries;
      const api = platformApi(env, repo, token);
      return streamed(async () => ({
        ...(await runArm(
          route,
          ledgerOf(env),
          api,
          spec,
          limits(LIMITS.armWallClockMs, maxRequests, timing.backoffMs),
        )),
        prompts_sha256: await promptsDigest(),
        limits: { ...LIMITS, max_requests: maxRequests },
      }));
    }
    if (url.pathname === '/v1/p9') {
      const repo = repoId(body.repo);
      const base = body.base ?? {};
      const spec = {
        run: run(body),
        scheduler: field(
          SCHEDULERS.includes(body.scheduler),
          body.scheduler as Scheduler,
          'scheduler',
        ),
        base: {
          commit: field(/^[0-9a-f]{40}$/.test(String(base.commit)), String(base.commit), 'base'),
          version: field(integer(base.version, 0, 2 ** 31 - 1), base.version as number, 'base'),
        },
        max_turns: maxTurns(body.max_turns),
        check_timeout_ms: LIMITS.checkTimeoutMs,
      };
      const route = await resolveRoute(env, provider(body));
      // At most three agent runs (B may redo once), each within its turns, plus retries.
      const maxRequests = 3 * spec.max_turns + 2 * LIMITS.maxRetries;
      const a = platformApi(env, repo, repoToken(body.tokens?.a));
      const b = platformApi(env, repo, repoToken(body.tokens?.b));
      return streamed(async () => ({
        ...(await runP9(
          route,
          ledgerOf(env),
          a,
          b,
          spec,
          limits(LIMITS.armWallClockMs, maxRequests, timing.backoffMs),
          timing.pollMs,
        )),
        prompts_sha256: await promptsDigest(),
        limits: { ...LIMITS, max_requests: maxRequests },
      }));
    }
    return refuse('NOT_FOUND', 'Unknown path', 404);
  } catch (e) {
    if (e instanceof ArmError)
      return refuse(e.code, e.message, e.code === 'INVALID_INPUT' ? 400 : 503);
    return refuse('INTERNAL', 'Eval request failed', 500);
  }
}

export default {
  fetch: (request: Request, env: EvalEnv) => handle(request, env),
} satisfies ExportedHandler<EvalEnv>;
