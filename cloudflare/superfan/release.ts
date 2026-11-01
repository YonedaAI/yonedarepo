// After a deploy, is the new release worse than the one before it? Each pass compares a window
// after the deploy with an equal window before it, by minute counters the tail already keeps:
// error rate, and p95 wall time by the same rules as the baseline drift. The minutes of the rollout
// are in neither window, nor are the first minutes after it, when every Durable Object wakes cold.
// Six hours on the window closes: by then the baselines have the release. A closed or thin window
// reports no number, so it can end an open finding, and never reads as worse. Off unless
// RELEASE_COMPARE is `on`: the comparison spends one ledger read per full pass and no request.
import type { SuperfanEnv } from './config';
import type { DeployRow } from './ledger-deploys';
import { tailWindow } from './ledger-tail';
import {
  type ComponentReport,
  DRIFT_FACTOR,
  DRIFT_FLOOR_MS,
  MAX_ERROR_RATE,
  MIN_INVOCATIONS,
  report,
  type Signal,
  type Snapshot,
} from './signal-rules';
import type { TailComponent, TailStats } from './tail';

const MINUTE = 60_000;
/** After the deploy ends, before its numbers count: cold starts, not the release. */
export const SETTLE_MS = 5 * MINUTE;
export const WATCH_MS = 6 * 60 * MINUTE;
/** What people wait on; job and check times vary too much with what ran. */
const COMPARED: TailComponent[] = [
  'api_worker',
  'front_worker',
  'source_repository',
  'land_queue',
  'commit_shards',
];
const ERROR_RATE = 'release_error_rate';
const LATENCY = 'release_p95_ms';

type Stats = Partial<Record<TailComponent, TailStats>>;
export interface ReleaseComparison {
  revision: string | null;
  previous: string | null;
  after: Stats;
  before: Stats;
}

export const releaseOn = (env: SuperfanEnv) => env.RELEASE_COMPARE === 'on';
/** Every finding key this comparison can file, so a switched-off comparison can end them. */
export const RELEASE_KEYS = COMPARED.flatMap((c) => [`${c}:${ERROR_RATE}`, `${c}:${LATENCY}`]);

const floor = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;
const ceil = (ms: number) => Math.ceil(ms / MINUTE) * MINUTE;

/** The windows for two deploys, newest first; null when there is nothing to compare yet. */
export function releaseWindows(current: DeployRow, previous: DeployRow, now: number) {
  if (now - current.finished_at > WATCH_MS) return null;
  const from = ceil(current.finished_at + SETTLE_MS);
  const to = floor(now);
  if (to <= from) return null;
  const end = floor(current.started_at);
  const start = Math.max(end - (to - from), ceil(previous.finished_at + SETTLE_MS));
  return end > start ? { after: [from, to], before: [start, end] } : null;
}

/** The ledger's half: the last two good deploys and their windows' counters. */
export function compareReleases(sql: SqlStorage, now: number): ReleaseComparison {
  const [current, previous] = sql
    .exec<Record<string, SqlStorageValue>>(
      "SELECT * FROM deploys WHERE outcome = 'ok' ORDER BY finished_at DESC, id DESC LIMIT 2",
    )
    .toArray() as unknown as DeployRow[];
  const names = { revision: current?.revision ?? null, previous: previous?.revision ?? null };
  const windows = previous ? releaseWindows(current, previous, now) : null;
  if (!windows) return { ...names, after: {}, before: {} };
  const read = ([start, end]: number[]) => tailWindow(sql, start, end).components;
  return { ...names, after: read(windows.after), before: read(windows.before) };
}

const rate = (t: TailStats) => (t.invocations ? t.errors / t.invocations : 0);

function signals(after?: TailStats, before?: TailStats): Signal[] {
  const enough =
    after &&
    before &&
    after.invocations >= MIN_INVOCATIONS &&
    before.invocations >= MIN_INVOCATIONS;
  const was = enough ? rate(before) : null;
  const now = enough ? rate(after) : null;
  const slow = enough ? after.p95WallMs : null;
  const usual = enough ? before.p95WallMs : null;
  return [
    {
      name: ERROR_RATE,
      value: now === null ? null : Number(now.toFixed(4)),
      unit: 'ratio',
      anomalous: now !== null && was !== null && now > MAX_ERROR_RATE && now > was * DRIFT_FACTOR,
      rule: `> ${MAX_ERROR_RATE} and > ${DRIFT_FACTOR}x the release before`,
      ...(was === null ? {} : { baseline: Number(was.toFixed(4)) }),
    },
    {
      name: LATENCY,
      value: slow,
      unit: 'ms',
      anomalous:
        slow !== null &&
        usual !== null &&
        slow > usual * DRIFT_FACTOR &&
        slow - usual >= DRIFT_FLOOR_MS,
      rule: `> ${DRIFT_FACTOR}x the release before (+${DRIFT_FLOOR_MS} ms)`,
      ...(usual === null ? {} : { baseline: usual }),
    },
  ];
}

/** One report per compared component, apart from its other signals: a release finding keeps its
 * own identity whatever else fires there. */
export function releaseReports(s: Snapshot): ComponentReport[] {
  const compared = s.release;
  if (!compared) return [];
  return COMPARED.map((c) => report(c, s, signals(compared.after[c], compared.before[c])));
}
