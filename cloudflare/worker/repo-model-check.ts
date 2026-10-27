// Model checks (policy runner kind `model`): one structured call to the platform's own
// review model on a commit's diff. Rust builds the request and maps the answer to an
// outcome (platform_model_check, platform_model_verdict); this module reads the diff, holds
// the platform's key and sends at most two requests. No tools, no agent loop, and never an
// agent-layer key: the key is the platform Worker's REVIEW_MODEL_KEY Secrets Store binding.
import { compute } from './repo-compute';
import { diff, type Json, type RepoContext } from './repo-ops';
import type { Env } from './types';

/** One model call's limit; two calls stay well inside the run's 120 s lease. */
const CALL_TIMEOUT_MS = 45_000;

async function platformKey(env: Env) {
  const binding = env.REVIEW_MODEL_KEY;
  const key = typeof binding?.get === 'function' ? await binding.get() : undefined;
  if (typeof key !== 'string' || !key)
    throw Object.assign(new Error('The platform review model key is not configured'), {
      code: 'MODEL_KEY_MISSING',
    });
  return key;
}

/** Per-run delimiter for the untrusted message and diff, so neither can close its block. */
const nonce = () =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/** One model call as Rust's verdict step reads it: the parsed body, or why there is none. */
async function call(url: string, key: string, body: Json): Promise<Json> {
  const started = Date.now();
  const took = () => Date.now() - started;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      // A redirect would carry the key elsewhere: refuse it.
      redirect: 'manual',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await response.text();
    try {
      return { http_status: response.status, body: JSON.parse(text), duration_ms: took() };
    } catch {
      return {
        http_status: response.status,
        error: 'model response is not JSON',
        duration_ms: took(),
      };
    }
  } catch (e: any) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return {
      error: timedOut
        ? `no model answer within ${CALL_TIMEOUT_MS / 1000} s`
        : `model request failed: ${String(e?.message ?? e).slice(0, 120)}`,
      duration_ms: took(),
    };
  }
}

/** Runs a claimed model check: `{outcome: pass|fail|error, evidence}` for completion. */
export async function modelCheck(env: Env, ctx: RepoContext, run: Json): Promise<Json> {
  // The same diff `GET /diff?patch=1` serves: the commit against its first parent.
  const changed = await diff(ctx, { head: run.commit, patch: true });
  const plan = compute({
    op: 'model_check_request',
    name: run.name,
    model: run.model,
    rubric: run.rubric,
    allow_truncated: run.allow_truncated === true,
    message: run.message,
    commit: run.commit,
    base: changed.base?.commit ?? null,
    changes: changed.changes,
    nonce: nonce(),
  });
  if (plan.skip) return plan.skip;
  const key = await platformKey(env);
  const attempts: Json[] = [];
  for (;;) {
    attempts.push(await call(plan.url, key, plan.body));
    // Rust decides: an outcome, or one `retry` after an unusable first answer.
    const judged = compute({ op: 'model_check_verdict', review: plan.review, attempts });
    if (judged.outcome !== 'retry') return judged;
  }
}
