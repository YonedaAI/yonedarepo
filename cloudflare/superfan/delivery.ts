// Was a queue left unserved? A gap between consumer invocations means nothing on an idle queue, and
// a backlog alone means nothing after a burst. A stall is both together, with proof the messages
// sat: no consumer ran or started for over GAP_MS, a backlog was there, and what was delivered when
// the gap ended had waited over WAITED_MS. Gaps come from tail events, whose times are exact;
// backlog and wait come from queue analytics, which stop at the minute and arrive minutes late, so
// this reads a past stall and a pass may have to wait for its evidence. Webhook deliveries are jobs
// on this same queue, so it speaks for them too. Budget: docs/observability-plan.md.
import type { AnalyticsSource } from './analytics';
import type { SuperfanLedger } from './ledger';
import { type ComponentReport, report, type Signal, type Snapshot } from './signal-rules';

const MINUTE = 60_000;
/** Over the 14.6 s the longest normal gap measured on dev; a real stall was 70.7 s. */
export const GAP_MS = 60_000;
export const WAITED_MS = 30_000;
/** Longer than the hourly pass's reach, so a pass off the wide watch sees each stall. */
const LOOKBACK_MS = 70 * MINUTE;
const KEEP_MS = 2 * 60 * MINUTE;
const SIGNAL = 'delivery_gap';

export interface Delivery {
  queue: string;
  start: number;
  end: number;
}
export interface QueueGap {
  queue: string;
  from: number;
  to: number;
}
/** Per minute (epoch ms): messages waiting, and how long reads' messages had waited. */
export interface QueueMinutes {
  waiting: Record<number, number>;
  waited: Record<number, number>;
}
export interface Stall {
  queue: string;
  gapMs: number;
  waiting: number;
  waitedMs: number;
}

/** The platform jobs queue's consumer invocations in one tail batch. */
export function deliveries(events: TraceItem[], script: string): Delivery[] {
  const jobs = `${script}-jobs`;
  const found: Delivery[] = [];
  for (const item of events) {
    const { queue } = (item.event ?? {}) as { queue?: unknown };
    if (item.scriptName !== script || queue !== jobs) continue;
    const start = item.eventTimestamp ?? 0;
    found.push({ queue: jobs, start, end: start + item.wallTime });
  }
  return found;
}

/** Notes each gap. The gap runs from the latest end, so a long job isn't one; an event that
 * arrives late is older than that end, and can't make one. */
export function recordDeliveries(sql: SqlStorage, rows: Delivery[], now: number) {
  if (!rows.length) return;
  for (const { queue, start, end } of [...rows].sort((a, b) => a.start - b.start)) {
    const last = sql
      .exec<{ last_end: number }>('SELECT last_end FROM queue_consumers WHERE queue = ?', queue)
      .toArray()[0]?.last_end;
    if (last !== undefined && start - last > GAP_MS)
      sql.exec(
        'INSERT INTO queue_gaps (queue, from_at, to_at) VALUES (?, ?, ?)',
        queue,
        last,
        start,
      );
    sql.exec(
      `INSERT INTO queue_consumers (queue, last_end) VALUES (?, ?)
       ON CONFLICT(queue) DO UPDATE SET last_end = MAX(last_end, excluded.last_end)`,
      queue,
      end,
    );
  }
  sql.exec('DELETE FROM queue_gaps WHERE to_at < ?', now - KEEP_MS);
}

export const gapsSince = (sql: SqlStorage, since: number): QueueGap[] =>
  sql
    .exec<{ queue: string; from_at: number; to_at: number }>(
      'SELECT queue, from_at, to_at FROM queue_gaps WHERE to_at >= ? ORDER BY to_at',
      since,
    )
    .toArray()
    .map((r) => ({ queue: r.queue, from: r.from_at, to: r.to_at }));

const minuteOf = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;

/** The worst gap with its evidence, or null. Backlog counts from the minute the gap began; the
 * wait is read where delivery came back, and in the minute after, which can hold the rest. */
export function stallIn(gaps: QueueGap[], { waiting, waited }: QueueMinutes): Stall | null {
  let worst: Stall | null = null;
  for (const { queue, from, to } of gaps) {
    const back = minuteOf(to);
    const waitedMs = Math.max(waited[back] ?? 0, waited[back + MINUTE] ?? 0);
    // An idle queue is no stall: the gap counts from the minute before anything was seen waiting,
    // as a backlog shows up a sample late.
    let most = 0;
    let waitingFrom = to;
    for (let at = minuteOf(from); at <= back; at += MINUTE) {
      most = Math.max(most, waiting[at] ?? 0);
      if (waiting[at] && waitingFrom === to) waitingFrom = Math.max(from, at - MINUTE);
    }
    const gapMs = to - waitingFrom;
    if (gapMs > GAP_MS && waitedMs > WAITED_MS && gapMs > (worst?.gapMs ?? 0))
      worst = { queue, gapMs, waiting: Math.ceil(most), waitedMs };
  }
  return worst;
}

export const DELIVERY_QUERY = `query QueueDelivery($account: string!, $start: Time!, $end: Time!, $queues: [string!]) {
  viewer { accounts(filter: { accountTag: $account }) {
    waiting: queueBacklogAdaptiveGroups(limit: 200, orderBy: [datetimeMinute_ASC], filter: { queueId_in: $queues, datetime_geq: $start, datetime_leq: $end }) {
      avg { messages } dimensions { queueId datetimeMinute } }
    waited: queueMessageOperationsAdaptiveGroups(limit: 500, orderBy: [datetimeMinute_ASC], filter: { queueId_in: $queues, datetime_geq: $start, datetime_leq: $end }) {
      avg { lagTime } dimensions { queueId actionType datetimeMinute } }
  } }
}`;

type Row = Record<string, any>;

/** Shapes the delivery query's account. Deletes also carry a lag; only a read says a wait. */
export function queueMinutes(account: Row): QueueMinutes {
  const minutes: QueueMinutes = { waiting: {}, waited: {} };
  const at = (r: Row) => Date.parse(String(r.dimensions?.datetimeMinute));
  for (const r of (account.waiting ?? []) as Row[])
    minutes.waiting[at(r)] = Number(r.avg?.messages) || 0;
  for (const r of (account.waited ?? []) as Row[])
    if (r.dimensions?.actionType === 'ReadMessage')
      minutes.waited[at(r)] = Number(r.avg?.lagTime) || 0;
  return minutes;
}

/** The worst stall the window holds, null for none; undefined where nothing can read one. */
export async function readDelivery(
  source: AnalyticsSource,
  ledger: DurableObjectStub<SuperfanLedger>,
  now: number,
): Promise<Stall | null | undefined> {
  if (!source.delivery) return undefined;
  const gaps = (await ledger.queueGaps(now - LOOKBACK_MS)) as QueueGap[];
  if (!gaps.length) return null;
  const start = new Date(Math.min(...gaps.map((g) => g.from)) - MINUTE).toISOString();
  return stallIn(gaps, await source.delivery(start, new Date(now).toISOString()));
}

/** Its own report, so the finding keeps one identity whatever else fires on the jobs queue. */
export function deliveryReports(s: Snapshot): ComponentReport[] {
  if (s.delivery === undefined) return [];
  const stall = s.delivery;
  const signal: Signal = {
    name: SIGNAL,
    value: stall && Number((stall.gapMs / 1000).toFixed(1)),
    unit: 'seconds',
    anomalous: Boolean(stall),
    rule: `no consumer for over ${GAP_MS / 1000} s with messages waiting`,
    ...(stall
      ? {
          detail: `${stall.queue}: ${stall.waiting} waiting, ${(stall.waitedMs / 1000).toFixed(1)} s waited`,
        }
      : {}),
  };
  return [report('derived_jobs', s, [signal])];
}
