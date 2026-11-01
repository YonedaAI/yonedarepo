// What only Cloudflare can see during a load test, read from its GraphQL Analytics API with the
// superfan's read-only token (CF_ANALYTICS_TOKEN). One query per source, so one that fails marks
// that source unreadable and leaves the others. Queue backlog comes in 5-minute groups and
// analytics lag by minutes: read it for trends and after a settle, never for a live alarm.
const API = 'https://api.cloudflare.com/client/v4';

const QUERIES = {
  backlog: `query Backlog($account: string!, $start: Time!, $end: Time!, $queues: [string!]) {
  viewer { accounts(filter: { accountTag: $account }) {
    rows: queueBacklogAdaptiveGroups(limit: 200, orderBy: [datetimeFiveMinutes_ASC], filter: { queueId_in: $queues, datetime_geq: $start, datetime_leq: $end }) {
      avg { messages } dimensions { queueId datetimeFiveMinutes } }
  } } }`,
  workers: `query Workers($account: string!, $start: Time!, $end: Time!, $script: string!) {
  viewer { accounts(filter: { accountTag: $account }) {
    rows: workersInvocationsAdaptive(limit: 50, filter: { scriptName: $script, datetime_geq: $start, datetime_leq: $end }) {
      sum { requests errors subrequests } dimensions { status } }
  } } }`,
  objects: `query Objects($account: string!, $start: Time!, $end: Time!, $namespace: string!) {
  viewer { accounts(filter: { accountTag: $account }) {
    rows: durableObjectsPeriodicGroups(limit: 1, filter: { namespaceId: $namespace, datetime_geq: $start, datetime_leq: $end }) {
      sum { exceededCpuErrors exceededMemoryErrors fatalInternalErrors } }
  } } }`,
  d1: `query D1($account: string!, $start: Time!, $end: Time!, $database: string!) {
  viewer { accounts(filter: { accountTag: $account }) {
    rows: d1AnalyticsAdaptiveGroups(limit: 1, filter: { databaseId: $database, datetime_geq: $start, datetime_leq: $end }) {
      sum { readQueries writeQueries } quantiles { queryBatchTimeMsP90 } }
  } } }`,
};
export const QUERY_NAMES = Object.keys(QUERIES);
/** For a test: every source only reads. */
export const queryTexts = () => Object.values(QUERIES);

const total = (rows, pick) => rows.reduce((n, r) => n + (pick(r) ?? 0), 0);

/** The latest backlog of each queue; a queue with no row in the window reads 0. */
export function latestBacklog(rows, queues) {
  const latest = (id) => rows.filter((r) => r.dimensions?.queueId === id).at(-1)?.avg?.messages ?? 0;
  return Object.fromEntries(Object.entries(queues).map(([name, id]) => [name, latest(id)]));
}

/** Invocations by outcome; any status but `success` is an error the platform itself raised. */
export function workerFigures(rows) {
  const statuses = {};
  for (const r of rows) if (r.dimensions?.status !== 'success') statuses[r.dimensions?.status] = (statuses[r.dimensions?.status] ?? 0) + (r.sum?.requests ?? 0);
  return { requests: total(rows, (r) => r.sum?.requests), errors: total(rows, (r) => r.sum?.errors), subrequests: total(rows, (r) => r.sum?.subrequests), statuses };
}

/** Durable Object resource kills in the window: a Cloudflare limit error the client never sees. */
export function objectFigures(rows) {
  const sum = rows[0]?.sum ?? {};
  return { exceeded_cpu: sum.exceededCpuErrors ?? 0, exceeded_memory: sum.exceededMemoryErrors ?? 0, fatal_internal: sum.fatalInternalErrors ?? 0 };
}

/** `{name: read(window)}` per source; each read throws what made it unreadable. */
export function cloudflareReaders({ token, spec, fetchImpl = fetch }) {
  const rest = async (path) => {
    const response = await fetchImpl(`${API}/accounts/${spec.account}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success !== true) throw new Error(`GET ${path.split('?')[0]}: HTTP ${response.status}`);
    return body.result;
  };
  const graph = async (name, variables, window) => {
    const response = await fetchImpl(`${API}/graphql`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERIES[name], variables: { account: spec.account, start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString(), ...variables } }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.errors?.length || !body?.data) throw new Error(`${name}: HTTP ${response.status} ${String(body?.errors?.[0]?.message ?? '').slice(0, 160)}`);
    return body.data.viewer.accounts[0]?.rows ?? [];
  };
  // Queue and namespace ids change only with a redeploy of the stack: looked up once.
  let ids;
  const lookup = () =>
    (ids ??= (async () => {
      const [queues, settings] = await Promise.all([rest('/queues?per_page=100'), rest(`/workers/scripts/${spec.script}/settings`)]);
      const queue = (suffix) => queues.find((q) => q.queue_name === `${spec.script}-${suffix}`)?.queue_id;
      const found = { jobs: queue('jobs'), checks: queue('checks'), dead_letter: queue('dead-letter') };
      if (Object.values(found).some((id) => !id)) throw new Error('A platform queue was not found by name');
      const namespace = settings.bindings?.find((b) => b.type === 'durable_object_namespace' && b.class_name === 'SourceRepository' && !b.script_name)?.namespace_id;
      return { queues: found, namespace };
    })().catch((e) => {
      ids = undefined;
      throw e;
    }));
  return {
    backlog: async (window) => {
      const { queues } = await lookup();
      return latestBacklog(await graph('backlog', { queues: Object.values(queues) }, window), queues);
    },
    workers: async (window) => workerFigures(await graph('workers', { script: spec.script }, window)),
    objects: async (window) => objectFigures(await graph('objects', { namespace: (await lookup()).namespace }, window)),
    d1: async (window) => {
      if (!spec.d1) throw new Error('No D1 id in the generated dev config');
      const row = (await graph('d1', { database: spec.d1 }, window))[0];
      return { read_queries: row?.sum?.readQueries ?? 0, write_queries: row?.sum?.writeQueries ?? 0, batch_ms_p90: row?.quantiles?.queryBatchTimeMsP90 ?? null };
    },
  };
}
