// What the change log costs a day: Basin's own metrics at Cloudflare's list prices. Read from
// GraphQL, whose lag is minutes. A source that can't be read is named, never counted as nothing.
// Prices: https://developers.cloudflare.com/basin-pipelines/platform/pricing/
// https://developers.cloudflare.com/basin-catalog/platform/pricing/
// https://developers.cloudflare.com/basin-sql/platform/pricing/ (updated 2026-10-01) and
// https://developers.cloudflare.com/r2/pricing/ (updated 2026-10-30). Billed since 2026-08-03.
const API = 'https://api.cloudflare.com/client/v4';
export const PRICES = {
  checked: '2026-11-01',
  sql_transform_gb: 0.04,
  sink_parquet_gb: 0.06,
  pipelines_included_gb: 50,
  r2_gb_month: 0.015,
  r2_class_a_million: 4.5,
  r2_class_b_million: 0.36,
  catalog_op_million: 9,
  catalog_included_million: 1,
  sql_scanned_gb: 0.0025,
  sql_included_gb: 10,
};
const GB = 1e9;
const QUERIES = {
  operator: `query Operator($account: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: { accountTag: $account }) {
    rows: pipelinesOperatorAdaptiveGroups(limit: 1000, filter: { streamId_neq: "", datetime_geq: $start, datetime_leq: $end }) { sum { bytesIn recordsIn decodeErrors } dimensions { date pipelineId } } } } }`,
  sink: `query Sink($account: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: { accountTag: $account }) {
    rows: pipelinesSinkAdaptiveGroups(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) { sum { bytesWritten recordsWritten filesWritten uncompressedBytesWritten } dimensions { date pipelineId } } } } }`,
  dropped: `query Dropped($account: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: { accountTag: $account }) {
    rows: pipelinesUserErrorsAdaptiveGroups(limit: 100, filter: { datetime_geq: $start, datetime_leq: $end }, orderBy: [count_DESC]) { count dimensions { date pipelineId errorFamily errorType } } } } }`,
  stored: `query Stored($account: string!, $start: Time!, $end: Time!, $bucket: string!) { viewer { accounts(filter: { accountTag: $account }) {
    rows: r2StorageAdaptiveGroups(limit: 1, filter: { bucketName: $bucket, datetime_geq: $start, datetime_leq: $end }, orderBy: [datetime_DESC]) { max { objectCount payloadSize metadataSize } dimensions { datetime } } } } }`,
  operations: `query Operations($account: string!, $start: Time!, $end: Time!, $bucket: string!) { viewer { accounts(filter: { accountTag: $account }) {
    rows: r2OperationsAdaptiveGroups(limit: 100, filter: { bucketName: $bucket, datetime_geq: $start, datetime_leq: $end }) { sum { requests } dimensions { actionType } } } } }`,
};
export const queryTexts = () => Object.values(QUERIES);

/** R2 actions by class, as R2's pricing page lists them. */
const CLASS_A = /^(Put|Copy|List|Create|Complete|Upload|Abort)/;

/** Rows of `pipelineId` only, a day at a time, summed. */
export function daily(operator, sink, dropped, pipeline) {
  const days = {};
  const day = (date) => (days[date] ??= { date, records_in: 0, bytes_in: 0, decode_errors: 0, records_written: 0, uncompressed_bytes: 0, bytes_written: 0, files: 0, dropped: 0 });
  const ours = (row) => !pipeline || row.dimensions?.pipelineId === pipeline;
  for (const r of operator.filter(ours)) Object.assign(day(r.dimensions.date), { records_in: day(r.dimensions.date).records_in + (r.sum.recordsIn ?? 0), bytes_in: day(r.dimensions.date).bytes_in + (r.sum.bytesIn ?? 0), decode_errors: day(r.dimensions.date).decode_errors + (r.sum.decodeErrors ?? 0) });
  for (const r of sink.filter(ours)) {
    const d = day(r.dimensions.date);
    d.records_written += r.sum.recordsWritten ?? 0;
    d.uncompressed_bytes += r.sum.uncompressedBytesWritten ?? 0;
    d.bytes_written += r.sum.bytesWritten ?? 0;
    d.files += r.sum.filesWritten ?? 0;
  }
  for (const r of dropped.filter(ours)) day(r.dimensions.date).dropped += r.count ?? 0;
  return Object.values(days).sort((a, b) => a.date.localeCompare(b.date));
}

export function operationsByClass(rows) {
  const out = { class_a: 0, class_b: 0 };
  for (const r of rows) out[CLASS_A.test(r.dimensions?.actionType ?? '') ? 'class_a' : 'class_b'] += r.sum?.requests ?? 0;
  return out;
}

/**
 * One day's cost at list price, and that day repeated for 30 days. Basin's included amounts are
 * taken off the month; R2's free tier isn't, because the rest of the account spends it. Catalog
 * operations and the SQL we scan aren't in a metric read here, so `queries_gb_day` is what this
 * tool scanned, and catalog operations are left out and named.
 */
export function dayCost(day, { stored_bytes = 0, class_a = 0, class_b = 0, days_of_operations = 1, queries_gb_day = 0 } = {}, p = PRICES) {
  const uncompressed = day.uncompressed_bytes / GB;
  const processed = day.bytes_in / GB;
  const stored = stored_bytes / GB;
  const list = {
    sql_transform: processed * p.sql_transform_gb,
    sink: uncompressed * p.sink_parquet_gb,
    r2_storage: (stored * p.r2_gb_month) / 30,
    r2_class_a: ((class_a / days_of_operations) * p.r2_class_a_million) / 1e6,
    r2_class_b: ((class_b / days_of_operations) * p.r2_class_b_million) / 1e6,
    basin_sql: queries_gb_day * p.sql_scanned_gb,
  };
  const total = Object.values(list).reduce((a, b) => a + b, 0);
  const month = {
    sql_transform: Math.max(0, 30 * processed - p.pipelines_included_gb) * p.sql_transform_gb,
    sink: Math.max(0, 30 * uncompressed - p.pipelines_included_gb) * p.sink_parquet_gb,
    basin_sql: Math.max(0, 30 * queries_gb_day - p.sql_included_gb) * p.sql_scanned_gb,
    r2: 30 * (list.r2_storage + list.r2_class_a + list.r2_class_b),
  };
  const rounded = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v.toFixed(6))]));
  return { date: day.date, list_usd: rounded(list), list_total_usd: Number(total.toFixed(6)), month_after_included_usd: Number(Object.values(month).reduce((a, b) => a + b, 0).toFixed(4)), not_counted: ['catalog operations: no metric read here; 1M a month included, then $9 per million'] };
}

/** A landing's cost, the figure prod's budget takes: bytes per record delivered. */
export const perRecord = (days) => {
  const records = days.reduce((n, d) => n + d.records_written, 0);
  const bytes = days.reduce((n, d) => n + d.uncompressed_bytes, 0);
  return records ? Math.round(bytes / records) : null;
};

/** `{name: read(window, variables)}` per source; each read throws what made it unreadable. */
export function metricReaders({ token, account, bucket, fetchImpl = fetch }) {
  const graph = async (name, { start, end }) => {
    const response = await fetchImpl(`${API}/graphql`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERIES[name], variables: { account, bucket, start: new Date(start).toISOString(), end: new Date(end).toISOString() } }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.errors?.length || !body?.data) throw new Error(`${name}: HTTP ${response.status} ${String(body?.errors?.[0]?.message ?? '').slice(0, 160)}`);
    return body.data.viewer.accounts[0]?.rows ?? [];
  };
  return Object.fromEntries(Object.keys(QUERIES).map((name) => [name, (window) => graph(name, window)]));
}
