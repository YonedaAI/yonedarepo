// The admin charts' and Traffic page's model: bars and their geometry, figures with `≈`, each
// range's names, and the page's one line on whether the numbers can be trusted yet.
import type {
  SiteTraffic,
  TrafficBucket,
  TrafficBucketCounts,
  TrafficClass,
  TrafficRange,
} from '../../../../shared/site-traffic';

const DAY_MS = 86_400_000;

/** One bar of a chart: what hover and assistive technology read, and the axis's short name. */
export type ChartBar = {
  key: string;
  label: string;
  axis: string;
  value: number;
  estimated?: boolean;
};

/** Bar heights in percent of the busiest day; a day with any sign-up shows at least 4%. */
export function barHeights(counts: number[]) {
  const top = Math.max(0, ...counts);
  return counts.map((n) => (n > 0 ? Math.max(4, Math.round((n / top) * 100)) : 0));
}

const GAP = 2;
const ROUNDING = 3;

/** Bars across `width` and up to `height`, each with the path that draws it from a baseline, its
 * top corners rounded. A bar with no count draws nothing. */
export function barLayout(values: number[], width: number, height: number) {
  const slot = width / Math.max(values.length, 1);
  const wide = Math.max(slot - GAP, 1);
  return barHeights(values).map((percent, i) => {
    const tall = (percent / 100) * height;
    const x = i * slot + (slot - wide) / 2;
    const r = Math.min(ROUNDING, wide / 2, tall);
    return {
      x,
      width: wide,
      height: tall,
      path: (base: number) =>
        tall === 0
          ? ''
          : `M${x} ${base}V${base - tall + r}Q${x} ${base - tall} ${x + r} ${base - tall}H${x + wide - r}Q${x + wide} ${base - tall} ${x + wide} ${base - tall + r}V${base}Z`,
    };
  });
}

/** A count for reading, with `≈` when it is an estimate. */
export const figure = (n: number, estimated = false) =>
  `${estimated ? '≈' : ''}${Math.round(n).toLocaleString('en-US')}`;

export const RANGE_LABELS: Record<TrafficRange, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
};

const monthDay = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A bar's time, in full and as the axis's short name. A week names its first and last days. */
function bucketNames(b: TrafficBucketCounts, bucket: TrafficBucket) {
  const start = Date.parse(b.start);
  if (bucket === 'hour') {
    const hour = `${b.start.slice(11, 13)}:00`;
    return { label: `${monthDay(start)}, ${hour} UTC`, axis: hour };
  }
  if (bucket === 'day') return { label: monthDay(start), axis: monthDay(start) };
  return {
    label: `${monthDay(start)} to ${monthDay(Date.parse(b.end) - 1)}`,
    axis: monthDay(start),
  };
}

/** One class of a report's series as chart bars. */
export const trafficBars = (
  t: Pick<SiteTraffic, 'series' | 'bucket'>,
  who: TrafficClass,
): ChartBar[] =>
  t.series.map((b) => ({
    key: b.start,
    value: b[who],
    estimated: b.estimated.includes(who),
    ...bucketNames(b, t.bucket),
  }));

/** Counts per UTC day (`YYYY-MM-DD`) as chart bars. */
export const dayBars = (days: { day: string; count: number }[]): ChartBar[] =>
  days.map((d) => {
    const name = monthDay(Date.parse(`${d.day}T00:00:00Z`));
    return { key: d.day, label: name, axis: name, value: d.count };
  });

/** How a figure compares with the period before: one short caption. */
export function changeLabel(now: number, before: number, range: TrafficRange, estimated = false) {
  const period = `the previous ${RANGE_LABELS[range]}`;
  if (Math.round(now) === Math.round(before)) return `Level with ${period}`;
  if (before <= 0) return `Up from 0 in ${period}`;
  const percent = Math.round(((now - before) / before) * 100);
  if (percent === 0) return `Level with ${period}`;
  return `${estimated ? '≈' : ''}${percent > 0 ? '+' : '−'}${Math.abs(percent)}% on ${period}`;
}

/** The Traffic page's one line: what the numbers are, or why they can't be trusted yet. */
export function trafficNote(
  t: Pick<SiteTraffic, 'counting' | 'classed_since' | 'days' | 'headline'>,
  now = Date.now(),
) {
  if (!t.counting)
    return {
      warn: true,
      text: 'Not counting here yet: Humans and platform use are unknown, not zero.',
    };
  if (!t.classed_since) return { warn: true, text: 'Nothing counted yet.' };
  const counted = Math.floor((now - Date.parse(t.classed_since)) / DAY_MS) + 1;
  return counted < t.days
    ? { warn: true, text: `Counted since ${t.classed_since}: ${counted} of these ${t.days} days.` }
    : {
        warn: false,
        text: t.headline.estimated.length
          ? 'Page views, not unique visitors. ≈ is an estimate: counts are sampled.'
          : 'Page views, not unique visitors.',
      };
}

/** Whether the report has nothing in it at all. */
export function trafficEmpty(t: SiteTraffic) {
  const { humans, agents_site, agents_platform, bots } = t.headline;
  return (
    humans + agents_site + agents_platform + bots === 0 &&
    t.series.every((b) => b.humans + b.agents + b.bots === 0) &&
    t.signups.length === 0 &&
    t.campaigns.length === 0
  );
}
