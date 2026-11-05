import { log } from './log';
import type { Env } from './types';

/** Time until the handler supplies a Response; excludes background work and body transfer. */
export async function responseTimed(env: Env, run: () => Promise<Response>) {
  if (env.RESPONSE_LATENCY !== 'on') return run();
  const started = performance.now();
  let status = 500;
  try {
    const answer = await run();
    status = answer.status;
    return answer;
  } finally {
    log.info('http.response', { elapsed_ms: Math.max(0, performance.now() - started), status });
  }
}
