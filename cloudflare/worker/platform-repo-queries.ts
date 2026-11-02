// The SQL behind repository figures (repo-usage.ts), one statement per answer. Counts sum
// `_sample_interval`, so they stay right when Analytics Engine samples; `sampling` above 1 marks
// an estimate. A repository's own figures read by `index1`, which each of its points carries.
import type { TrafficSpan } from './platform-traffic-queries';
import {
  SITE_EVENT_BLOBS as B,
  SITE_EVENT_BYTES,
  SITE_EVENT_DURATION,
  SITE_EVENT_MARKED,
  SITE_EVENT_QUEUE,
  SITE_EVENT_RETRIES,
} from './site-events';

const REPO = /^r[0-9a-f]{20}$/;
const TOP = 25;
/** Every action a repository's figures count: clones and fetches that carried a pack, pushes with
 * commands, and landings that went somewhere. */
export const CLONES = ['clone', 'fetch'];
export const PUSHES = ['base', 'branch'];
export const LANDINGS = ['landed', 'already', 'refused', 'failed'];
const CHECKS = ['check:pass', 'check:fail'];
const ACTIONS = [...CLONES, ...PUSHES, ...LANDINGS];

const list = (values: string[]) => values.map((v) => `'${v}'`).join(', ');
const POINTS = `${B.event} IN ('client', 'repo') AND ${SITE_EVENT_MARKED} = 1`;
const from = (ms: number) => `timestamp >= toDateTime(${Math.floor(ms / 1000)})`;
const SAMPLING = 'MAX(_sample_interval) AS sampling';

/** One repository's actions by bar, operation, who and how they went. */
export function insightsQuery(dataset: string, repo: string, span: TrafficSpan) {
  if (!REPO.test(repo)) throw new Error('Invalid repository id');
  const unit = span.bucket === 'hour' ? 'HOUR' : 'DAY';
  return `SELECT formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' ${unit}), '%Y-%m-%dT%H') AS bucket, ${B.actor} AS actor, ${B.reason} AS reason, ${B.detail} AS detail, SUM(_sample_interval) AS count, ${SAMPLING} FROM ${dataset} WHERE index1 = '${repo}' AND ${POINTS} AND ${B.detail} IN (${list(ACTIONS)}) AND ${from(span.start)} GROUP BY bucket, actor, reason, detail ORDER BY bucket ASC FORMAT JSON`;
}

/** Landing, check and push counts across repositories, by reason. */
export function landingTotalsQuery(dataset: string, span: TrafficSpan) {
  const kept = [...PUSHES, ...LANDINGS, ...CHECKS];
  return `SELECT ${B.reason} AS reason, ${B.detail} AS detail, SUM(_sample_interval) AS count, SUM(_sample_interval * ${SITE_EVENT_RETRIES}) AS retries, ${SAMPLING} FROM ${dataset} WHERE ${POINTS} AND ${B.detail} IN (${list(kept)}) AND ${from(span.start)} GROUP BY reason, detail ORDER BY count DESC LIMIT 200 FORMAT JSON`;
}

/** How long landings that landed took, and waited in line. A job's landing has no such times. */
export function landingLatencyQuery(dataset: string, span: TrafficSpan) {
  const quantile = (q: number, of: string, name: string) =>
    `quantileExactWeighted(${q})(${of}, _sample_interval) AS ${name}`;
  const figures = [
    quantile(0.5, SITE_EVENT_DURATION, 'p50'),
    quantile(0.95, SITE_EVENT_DURATION, 'p95'),
    quantile(0.99, SITE_EVENT_DURATION, 'p99'),
    quantile(0.5, SITE_EVENT_QUEUE, 'queue_p50'),
    quantile(0.95, SITE_EVENT_QUEUE, 'queue_p95'),
  ];
  return `SELECT ${figures.join(', ')} FROM ${dataset} WHERE ${POINTS} AND ${B.detail} = 'landed' AND ${B.client} != 'platform' AND ${from(span.start)} FORMAT JSON`;
}

/** Repositories by `order`: their actions, and bytes pushed. */
export function repoUsageQuery(
  dataset: string,
  span: TrafficSpan,
  order: 'actions' | 'pushed_bytes',
  limit = TOP * 2,
) {
  const pushed = `SUM(_sample_interval * if(${B.detail} IN (${list(PUSHES)}), ${SITE_EVENT_BYTES}, 0))`;
  return `SELECT ${B.repo} AS repo, SUM(_sample_interval) AS actions, ${pushed} AS pushed_bytes, ${SAMPLING} FROM ${dataset} WHERE ${POINTS} AND ${B.repo} != '' AND ${B.detail} IN (${list(ACTIONS)}) AND ${from(span.start)} GROUP BY repo ORDER BY ${order} DESC LIMIT ${limit} FORMAT JSON`;
}
