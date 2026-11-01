// Where a request's time went, kept for some requests: its `Server-Timing` phases as one log line
// and one Analytics Engine point, by operation, so a slow operation can be found from its id and
// compared over time. Off unless SPAN_SAMPLE is a number N: then 1 request in N, and every request
// over SLOW_MS, which a sample alone would mostly miss. Budget: docs/observability-plan.md.
//
// Both are written after the answer, inside the request's waitUntil, and a request that lends none
// keeps nothing: this must never make anyone wait. Phases stop when the answer's headers go out, so
// a streamed clone or push has the walk, not the pack (docs/global-scale-plan.md). A point holds the
// route's shape, the release and phase names: no repository, account or request id, which stay in
// the log line. It shares the dataset with the site's events and has its own `blob1`.
import { deferred } from './background';
import { log, operationOf } from './log';
import { type Phases, withTimings } from './repo-timing';
import { currentScope } from './request-scope';
import { isOwnTraffic } from './site-events';
import type { Env } from './types';

/** Kept whatever the draw. A rule for keeping, not a target for how fast anything should be. */
const SLOW_MS = 5_000;
/** A point has 20 blobs and 20 doubles; the first four and two hold the rest. */
const POINT_SPANS = 16;
const INDEX_BYTES = 96;
const REVISION_LENGTH = 12;
const GIT_ACTION = /\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const tenths = (ms: number) => Math.round(ms * 10) / 10;

/** The operation, with Git's three requests apart: a clone is not its reference listing. */
function operation(req: Request) {
  const action = GIT_ACTION.exec(new URL(req.url).pathname)?.[1];
  return action ? `${req.method} /git/:repo/${action}` : operationOf(req);
}

function write(env: Env, req: Request, phases: Phases, status: number) {
  const name = operation(req);
  const total = tenths(phases.get('total')?.ms ?? 0);
  const spans = [...phases]
    .filter(([span]) => span !== 'total')
    .sort(([, a], [, b]) => b.ms - a.ms);
  log.info('request.spans', {
    operation: name,
    status,
    total_ms: total,
    spans: spans.map(([span, p]) => ({ name: span, ms: tenths(p.ms), count: p.n })),
  });
  const kept = spans.slice(0, POINT_SPANS);
  env.SITE_EVENTS?.writeDataPoint({
    indexes: [name.slice(0, INDEX_BYTES)],
    blobs: [
      'spans',
      name,
      (env.BUILD_REVISION ?? '').slice(0, REVISION_LENGTH),
      isOwnTraffic(req) ? 'own' : '',
      ...kept.map(([span]) => span),
    ],
    doubles: [total, status, ...kept.map(([, p]) => tenths(p.ms))],
  });
}

/** Keeps this request's phases if it is picked. Nothing here can reach the request: it returns at
 * once, and what it starts runs on the next task, after the answer. */
export function sampleSpans(
  env: Env,
  req: Request,
  phases: Phases,
  status: number,
  random = Math.random,
) {
  const setting = env.SPAN_SAMPLE;
  if (!setting || setting === 'off') return;
  try {
    const every = Number(setting);
    if (!Number.isInteger(every) || every < 1) return;
    const scope = currentScope();
    if (!scope?.waitUntil || scope.spansTaken) return;
    if ((phases.get('total')?.ms ?? 0) < SLOW_MS && random() * every >= 1) return;
    scope.spansTaken = true;
    deferred(async () => {
      await new Promise((next) => setTimeout(next, 0));
      write(env, req, phases, status);
    });
  } catch {
    // A lost sample is acceptable; a failed request is not.
  }
}

/** `handle`'s answer with its phases in `Server-Timing`, sampled if picked. */
export async function timedAnswer(env: Env, req: Request, handle: () => Promise<Response>) {
  const { value, header, phases } = await withTimings(handle);
  if (header) value.headers.set('server-timing', header);
  sampleSpans(env, req, phases, value.status);
  return value;
}
