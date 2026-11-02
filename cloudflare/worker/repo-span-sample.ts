// Where a request's time went, kept for some requests: its `Server-Timing` phases as one log line
// and one Analytics Engine point, by operation, so a slow operation can be found from its id and
// compared over time. Off unless SPAN_SAMPLE is a number N: then 1 request in N, and every request
// over SLOW_MS, which a sample alone would mostly miss. SERVICE_LEVELS writes the same point, and
// no line, for the operations with service targets (shared/service-levels.ts), so a request is
// one point whichever picked it. Budget: docs/observability-plan.md.
//
// Both are written after the answer, inside the request's waitUntil, and a request that lends none
// keeps nothing: this must never make anyone wait. Phases stop when the answer's headers go out, so
// a streamed clone or push has the walk, not the pack (docs/global-scale-plan.md). A point holds the
// route's shape, the release and phase names: no repository, account or request id, which stay in
// the log line. It shares the dataset with the site's events and has its own `blob1`.
import { requestPoint, SERVICE_EVERY, serviceOperation } from '../../shared/service-levels';
import { deferred } from './background';
import { log, operationOf } from './log';
import { type Phases, withTimings } from './repo-timing';
import { currentScope } from './request-scope';
import { isOwnTraffic } from './site-events';
import type { Env } from './types';

/** Kept whatever the draw. A rule for keeping, not a target for how fast anything should be. */
const SLOW_MS = 5_000;
const GIT_ACTION = /\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const tenths = (ms: number) => Math.round(ms * 10) / 10;

/** The operation, with Git's three requests apart: a clone is not its reference listing. */
function operation(req: Request) {
  const action = GIT_ACTION.exec(new URL(req.url).pathname)?.[1];
  return action ? `${req.method} /git/:repo/${action}` : operationOf(req);
}

/** What a request kept: its log line, and how many requests its point stands for. */
type Pick = { service: ReturnType<typeof serviceOperation>; weight: number; line: boolean };

function write(env: Env, req: Request, phases: Phases, status: number, pick: Pick) {
  const name = operation(req);
  const total = tenths(phases.get('total')?.ms ?? 0);
  const spans = [...phases]
    .filter(([span]) => span !== 'total')
    .sort(([, a], [, b]) => b.ms - a.ms)
    .map(([span, p]) => ({ name: span, ms: tenths(p.ms), count: p.n }));
  if (pick.line) log.info('request.spans', { operation: name, status, total_ms: total, spans });
  env.SITE_EVENTS?.writeDataPoint(
    requestPoint({
      name,
      revision: env.BUILD_REVISION ?? '',
      own: isOwnTraffic(req),
      operation: pick.service,
      status,
      totalMs: total,
      weight: pick.weight,
      spans,
    }),
  );
}

/** SPAN_SAMPLE's N, or 0 for anything else. */
function spanEvery(setting: string | undefined) {
  if (!setting || setting === 'off') return 0;
  const every = Number(setting);
  return Number.isInteger(every) && every >= 1 ? every : 0;
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
  const every = spanEvery(env.SPAN_SAMPLE);
  const measuring = env.SERVICE_LEVELS === 'on';
  if (!every && !measuring) return;
  try {
    const scope = currentScope();
    if (!scope?.waitUntil || scope.spansTaken) return;
    const service = measuring ? serviceOperation(req.method, new URL(req.url).pathname) : null;
    if (!every && !service) return;
    const draw = random();
    const weight = service && draw * SERVICE_EVERY[service] < 1 ? SERVICE_EVERY[service] : 0;
    const slow = (phases.get('total')?.ms ?? 0) >= SLOW_MS;
    const line = every > 0 && (slow || draw * every < 1);
    if (!weight && !line) return;
    scope.spansTaken = true;
    deferred(async () => {
      await new Promise((next) => setTimeout(next, 0));
      write(env, req, phases, status, { service, weight, line });
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
