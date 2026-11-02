// What only Cloudflare can see of a repository, read from outside the platform (dev-checks.mjs):
// D1 rows, R2 keys, the repository objects' ids, and analytics. Reads only:
// `d1` refuses anything but a SELECT, and nothing here writes. A probe that fails throws: only a
// clean answer of nothing may ever count as gone. The token arrives from a 0600 file, goes in a
// header or the child's environment, and appears in no argument or log.
import { keyKind, LIMITS } from './dev-checks-lib.mjs';

const API = 'https://api.cloudflare.com/client/v4';

const QUERIES = {
  r2: `query R2($account: string!, $start: Time!, $end: Time!, $bucket: string!) {
  viewer { accounts(filter: { accountTag: $account }) {
    rows: r2OperationsAdaptiveGroups(limit: 100, filter: { bucketName: $bucket, datetime_geq: $start, datetime_leq: $end }) {
      sum { requests } dimensions { actionType } }
  } } }`,
  object: `query Object($account: string!, $start: Time!, $end: Time!, $object: string!) {
  viewer { accounts(filter: { accountTag: $account }) {
    rows: durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: { objectId: $object, datetime_geq: $start, datetime_leq: $end }) {
      sum { requests } }
  } } }`,
  kills: `query Kills($account: string!, $start: Time!, $end: Time!, $namespace: string!) {
  viewer { accounts(filter: { accountTag: $account }) {
    rows: durableObjectsPeriodicGroups(limit: 1, filter: { namespaceId: $namespace, datetime_geq: $start, datetime_leq: $end }) {
      sum { exceededCpuErrors exceededMemoryErrors fatalInternalErrors } }
  } } }`,
};
/** For a test: every query only reads. */
export const queryTexts = () => Object.values(QUERIES);

export function cloudflare({ token, analyticsToken, account, database, bucket, script, fetchImpl = fetch }) {
  const rest = async (method, path, body) => {
    const response = await fetchImpl(`${API}/accounts/${account}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const answer = await response.json().catch(() => null);
    if (!response.ok || answer?.success !== true) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${response.status}`);
    return answer;
  };
  const graph = async (name, variables, window) => {
    const response = await fetchImpl(`${API}/graphql`, {
      method: 'POST',
      headers: { authorization: `Bearer ${analyticsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERIES[name], variables: { account, start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString(), ...variables } }),
      signal: AbortSignal.timeout(30_000),
    });
    const answer = await response.json().catch(() => null);
    if (!response.ok || answer?.errors?.length || !answer?.data) throw new Error(`${name}: HTTP ${response.status}`);
    return answer.data.viewer.accounts[0]?.rows ?? [];
  };
  let namespace;
  const repoNamespace = async () => {
    if (namespace) return namespace;
    const { result } = await rest('GET', '/workers/durable_objects/namespaces?per_page=1000');
    namespace = result.find((n) => n.class === 'SourceRepository' && n.script === script)?.id;
    if (!namespace) throw new Error(`No repository namespace in ${script}`);
    return namespace;
  };
  return {
    /** Rows of one read. */
    async d1(sql, params = []) {
      if (!/^SELECT\s/i.test(sql) || sql.includes(';')) throw new Error('Reads only');
      const { result } = await rest('POST', `/d1/database/${database}/query`, { sql, params });
      if (result?.[0]?.success !== true) throw new Error('D1 read failed');
      return result[0].results;
    },
    /** Keys and bytes under `prefix`, by folder, and the pages it took. */
    async r2(prefix) {
      const seen = { keys: 0, bytes: 0, kinds: {}, pages: 0 };
      for (let cursor = ''; ; ) {
        const after = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const page = await rest('GET', `/r2/buckets/${bucket}/objects?prefix=${encodeURIComponent(prefix)}&per_page=${LIMITS.r2Page}${after}`);
        seen.pages++;
        for (const object of page.result ?? []) {
          seen.keys++;
          seen.bytes += object.size ?? 0;
          seen.kinds[keyKind(object.key)] = (seen.kinds[keyKind(object.key)] ?? 0) + 1;
        }
        cursor = page.result_info?.is_truncated ? page.result_info.cursor : '';
        if (!cursor) return seen;
      }
    },
    /** The ids of every repository object holding data. */
    async objects() {
      const id = await repoNamespace();
      const ids = new Set();
      for (let cursor = ''; ; ) {
        const after = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const page = await rest('GET', `/workers/durable_objects/namespaces/${id}/objects?limit=1000${after}`);
        for (const object of page.result ?? []) if (object.hasStoredData) ids.add(object.id);
        cursor = page.result_info?.cursor ?? '';
        if (!cursor) return ids;
      }
    },
    /** What analytics say of `window`: each source alone, one that fails reads `unreadable`. */
    async analytics(window, object) {
      const read = (work) => work().catch((e) => ({ unreadable: String(e?.message ?? e) }));
      return {
        r2_bucket_shared: await read(async () => Object.fromEntries((await graph('r2', { bucket }, window)).map((r) => [r.dimensions.actionType, r.sum.requests]))),
        object_requests: object ? await read(async () => (await graph('object', { object }, window))[0]?.sum?.requests ?? 0) : null,
        object_kills_shared: await read(async () => (await graph('kills', { namespace: await repoNamespace() }, window))[0]?.sum ?? {}),
      };
    },
  };
}
