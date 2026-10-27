// Webhooks (B3): the adapter half. The authority owns hooks, the event cursor, each
// hook's ordered outbox and the delivery log (repo_store/hooks.rs); this module generates
// secrets, routes management calls, and runs the platform-jobs work: fan-out after
// landings, ref moves and checks, then one delivery job per hook that sends its payloads
// in order, signed, with retries and backoff. A job that runs out of queue retries ends
// in the platform dead-letter queue; its payload stays first in line for the next job.
import { deferred } from './background';
import { hmacHex, toHex } from './hmac';
import { ApiError, caller, type Json, type RepoContext } from './repo-ops';
import type { Env, Envelope } from './types';

const TIMEOUT_MS = 10_000;
/** Deliveries per job; a longer backlog continues in a fresh job. */
const PER_JOB = 20;
/** Fan-out rounds per job (each covers up to 100 log versions). */
const FANOUT_ROUNDS = 10;

/** A new hook's signing secret, generated here and stored only by the authority. */
export function hookSecret() {
  return `whsec_${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

const hookId = (value: unknown) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError('NOT_FOUND', 'Unknown hook');
  return id;
};

/** Management operations, shared by REST and MCP (owner or `repo:admin`). */
export const hookOperations = {
  git_hook_list: (ctx: RepoContext) => ctx.call({ op: 'repo_hooks' }),
  git_hook_create: async (ctx: RepoContext, a: Json) => {
    const secret = hookSecret();
    const created = await ctx.call({
      op: 'repo_hook_create',
      url: a.url,
      events: a.events ?? null,
      paths: a.paths ?? null,
      _secret: secret,
      _repo: ctx.repo,
      _workers_subdomain: ctx.env.WORKERS_SUBDOMAIN ?? null,
    });
    // Shown once: listings never include it.
    return { ...created, secret };
  },
  git_hook_delete: (ctx: RepoContext, a: Json) =>
    ctx.call({ op: 'repo_hook_delete', hook_id: hookId(a.id) }),
  git_hook_deliveries: (ctx: RepoContext, a: Json) =>
    ctx.call({ op: 'repo_hook_deliveries', hook_id: hookId(a.id) }),
};

/** `GET|POST /hooks`, `DELETE /hooks/:id`, `GET /hooks/:id/deliveries`. */
export async function hooksRoute(
  ctx: RepoContext,
  method: string,
  id: string | undefined,
  sub: string | undefined,
  body: () => Promise<Json>,
): Promise<Json> {
  if (!id && method === 'GET') return hookOperations.git_hook_list(ctx);
  if (!id && method === 'POST') return hookOperations.git_hook_create(ctx, await body());
  if (id && !sub && method === 'DELETE') return hookOperations.git_hook_delete(ctx, { id });
  if (id && sub === 'deliveries' && method === 'GET')
    return hookOperations.git_hook_deliveries(ctx, { id });
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}

export async function dispatchHooks(env: Env, repo: string, job = 'fanout') {
  await env.PLATFORM_QUEUE.send({ v: 1, kind: 'platform_hooks', repo_id: repo, job_id: job });
}

/** After a request moved a ref or recorded a check: a fan-out job, sent after the response
 * where the request lends its waitUntil. A lost message only delays events until the next
 * landing, ref move or check fans them out. */
export async function notifyHooks(env: Env, repo: string) {
  const send = () =>
    dispatchHooks(env, repo).catch((e) => console.warn(`hook dispatch failed: ${e?.message ?? e}`));
  if (!deferred(send)) await send();
}

/**
 * Moves the repository's event cursor (queueing payloads for subscribed hooks) and sends a
 * delivery job for each hook with payloads waiting. Never throws: hooks never fail a
 * landing or the derive job that calls this.
 */
export async function fanoutHooks(env: Env, repo: string): Promise<number[]> {
  const call = caller(env, repo, { _system: 'hooks' });
  let hooks: number[] = [];
  try {
    for (let round = 0; round < FANOUT_ROUNDS; round++) {
      const page = await call({ op: 'repo_hooks_fanout' });
      hooks = page.hooks as number[];
      if (!page.more) break;
    }
    await Promise.all(hooks.map((id) => dispatchHooks(env, repo, `hook:${id}`)));
  } catch (e: any) {
    console.error(
      JSON.stringify({
        event: 'hooks.fanout_failed',
        repo,
        code: e?.code ?? 'HOOKS',
        message: String(e?.message ?? e).slice(0, 200),
      }),
    );
  }
  return hooks;
}

type Send = (req: Request) => Promise<Response>;
type Attempt = { ok: boolean; status: number | null; ms: number; error?: string };

/** POSTs one claimed payload: signed body, 10 s timeout, redirects not followed. */
async function post(claim: Json, send: Send): Promise<Attempt> {
  const started = Date.now();
  const body = String(claim.body);
  try {
    const response = await send(
      new Request(String(claim.url), {
        method: 'POST',
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'YonedaRepo-Hooks/1',
          'x-yoneda-event': String(claim.event),
          'x-yoneda-delivery': String(claim.delivery_id),
          'x-yoneda-signature': `sha256=${await hmacHex(String(claim.secret), body)}`,
        },
      }),
    );
    await response.body?.cancel().catch(() => {});
    const ok = response.status >= 200 && response.status < 300;
    return { ok, status: response.status, ms: Date.now() - started };
  } catch (e: any) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const error = timedOut ? 'timeout' : String(e?.message ?? e).slice(0, 200);
    return { ok: false, status: null, ms: Date.now() - started, error };
  }
}

/**
 * Sends hook `id`'s payloads in order until none is left, one fails, or the job's share is
 * used. Returns `retry` (seconds) while the next payload is backing off or another job's
 * lease on it may have lapsed; the queue then redelivers this job.
 */
export async function deliverHook(
  env: Env,
  repo: string,
  id: number,
  send: Send = (req) => fetch(req),
): Promise<{ retry?: number }> {
  const call = caller(env, repo, { _system: 'hooks' });
  const seconds = (ms: unknown) => Math.max(1, Math.ceil(Number(ms) / 1000));
  for (let n = 0; n < PER_JOB; n++) {
    const claim = await call({ op: 'repo_hook_claim', hook_id: id });
    if (claim.idle) return {};
    if (claim.busy) return { retry: seconds(claim.retry_after_ms) };
    const attempt = await post(claim, send);
    const settled = await call({
      op: 'repo_hook_settle',
      hook_id: id,
      seq: claim.seq,
      attempt: claim.attempt,
      ...attempt,
    });
    if (settled.stale) return {};
    if (!settled.delivered) return settled.active ? { retry: seconds(settled.retry_after_ms) } : {};
    if (!settled.more) return {};
  }
  await dispatchHooks(env, repo, `hook:${id}`);
  return {};
}

/** The `platform_hooks` queue job: `fanout`, or `hook:<id>` deliveries. */
export async function hookJob(env: Env, envelope: Envelope): Promise<{ retry?: number }> {
  if (envelope.job_id === 'fanout') {
    await fanoutHooks(env, envelope.repo_id);
    return {};
  }
  const hook = /^hook:(\d+)$/.exec(envelope.job_id);
  if (!hook) return {};
  try {
    return await deliverHook(env, envelope.repo_id, Number(hook[1]));
  } catch (e: any) {
    // A deleted repository has nothing left to deliver.
    if (e instanceof ApiError && (e.code === 'GONE' || e.code === 'NOT_FOUND')) return {};
    throw e;
  }
}
