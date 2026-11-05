// Budget: authorize every request, then reuse a completed snapshot for at most 15s.
// A cold Traffic report still costs its 10 SQL + 1 GraphQL queries; a hit costs none.
// No Cache API, HTTP caching, browser persistence, tokens or request headers are stored.
import { askedHere } from './cell-route';
import { log } from './log';
import { currentScope } from './request-scope';
import type { Env, Json } from './types';

export class AdminReadCache {
  private entries = new Map<string, { until: number; value: Json }>();
  private epoch = 0;
  constructor(private now = Date.now) {}
  clear() {
    this.epoch++;
    this.entries.clear();
  }
  async read<T extends Json>(key: string, load: () => Promise<T>): Promise<T> {
    const old = this.entries.get(key);
    if (old && old.until > this.now()) return structuredClone(old.value) as T;
    const epoch = this.epoch;
    // I/O and in-flight promises belong to this invocation, never another request.
    const value = await load();
    if (
      epoch === this.epoch &&
      value.ok !== false &&
      !value.partial &&
      value.traffic?.web_analytics?.reason !== 'query_failed'
    ) {
      if (this.entries.size >= 32) this.entries.delete(this.entries.keys().next().value ?? '');
      this.entries.set(key, { until: this.now() + 15_000, value: structuredClone(value) });
    }
    return value;
  }
}
const cache = new AdminReadCache();
export const clearAdminReads = () => cache.clear();

/** Caller MUST have passed operator authorization. Never memoize a Response or credentials. */
export async function adminRead<T extends Json>(
  env: Env,
  actor: string,
  path: string,
  load: () => Promise<T>,
) {
  if (env.ADMIN_READ_CACHE !== 'on') return load();
  const req = currentScope()?.req;
  const key = JSON.stringify([
    env.WEB_ORIGIN,
    env.CF_ACCOUNT_ID,
    env.CELL,
    env.CELLS,
    Boolean(req && askedHere(req)),
    actor,
    path,
    env.TRAFFIC_REPORT,
    env.TRAFFIC_EVENTS,
    env.SITE_EVENTS_DATASET,
    env.NEWSLETTER,
    env.ADMIN_BILLING,
  ]);
  const start = Date.now();
  let fetched = false;
  const value = await cache.read(key, () => {
    fetched = true;
    return load();
  });
  log.info('admin.report', {
    kind: path.split('?')[0],
    cache: fetched ? 'miss' : 'hit',
    ms: Date.now() - start,
  });
  return value;
}

/** Only read-only lists and aggregate reports; never balances, credentials, repairs or detail. */
export function memoizedAdminRead(section: string, id?: string) {
  return (
    (!id &&
      [
        'accounts',
        'repos',
        'signups',
        'audit',
        'visitors',
        'agents',
        'operations',
        'revenue',
      ].includes(section)) ||
    (section === 'traffic' && id === 'landings')
  );
}
