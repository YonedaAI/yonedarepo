// What Superfan adds to the service measurements (SERVICE_LEVELS), in the dataset the platform
// writes to (shared/service-levels.ts): requests that died before the platform could write their
// point, since a kill must count as a failure, and each synthetic result, kept longer than the
// ledger keeps it. Neither touches a request: a lost point loses that point and nothing else.
import { probePoint, requestPoint, serviceOperation } from '../../shared/service-levels';
import type { SuperfanEnv } from './config';
import type { ProbeResult } from './synthetic-checks';

const OWN_TRAFFIC_HEADER = 'x-yoneda-own-traffic';
/** Answered, or the client went away: neither is a death. */
export const NOT_DEAD = new Set(['ok', 'canceled', 'responseStreamDisconnected', 'unknown']);

export const serviceOn = (env: SuperfanEnv) => env.SERVICE_LEVELS === 'on';

/** A point for each measured request of the platform Worker that died. */
export function deadRequests(events: TraceItem[], script: string) {
  const points: ReturnType<typeof requestPoint>[] = [];
  for (const item of events) {
    if (item.scriptName !== script || item.executionModel === 'durableObject') continue;
    if (NOT_DEAD.has(item.outcome)) continue;
    const { request } = (item.event ?? {}) as Partial<TraceItemFetchEventInfo>;
    if (!request || !URL.canParse(request.url)) continue;
    const operation = serviceOperation(request.method, new URL(request.url).pathname);
    if (!operation) continue;
    points.push(
      requestPoint({
        name: `died ${operation}`,
        revision: item.scriptVersion?.tag ?? '',
        own: request.headers?.[OWN_TRAFFIC_HEADER] === '1',
        operation,
        status: 0,
        totalMs: item.wallTime,
        weight: 1,
        spans: [],
      }),
    );
  }
  return points;
}

function write(env: SuperfanEnv, points: AnalyticsEngineDataPoint[]) {
  try {
    for (const point of points) env.SITE_EVENTS?.writeDataPoint(point);
  } catch {
    // A lost point is acceptable; a failed tail batch or pass is not.
  }
}

export function recordDeaths(env: SuperfanEnv, events: TraceItem[]) {
  if (serviceOn(env)) write(env, deadRequests(events, env.WATCH_SCRIPT));
}

export function recordProbes(env: SuperfanEnv, results: ProbeResult[]) {
  if (!serviceOn(env)) return;
  write(
    env,
    results.map((r) => probePoint(r.check, r.ok, r.ms, r.revision)),
  );
}
