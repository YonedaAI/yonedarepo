// The Insights page and the admin reports as people read them: words for who acted and why a
// landing failed, and the page's figures. Nothing here decides anything: the server's answer says
// who may see it.
import type { InsightsBar, RepoInsights } from '../../../../shared/repo-insights';
import type { TrafficBucket } from '../../../../shared/site-traffic';
import { type ChartBar, RANGE_LABELS } from '../admin/trafficModel';

export const INSIGHT_RANGES = Object.keys(RANGE_LABELS) as (keyof typeof RANGE_LABELS)[];

export const insightsPath = (repo: string, range: string) =>
  `/repos/${repo}/insights?range=${range}`;

const WHO: Record<string, string> = {
  person: 'People in the browser',
  agent: 'Agents',
  anonymous: 'Signed out',
  platform: 'The platform',
};
/** With agents counted apart (`separated`), a token is no longer possibly one of them. */
export const whoLabel = (key: string, separated = false) =>
  WHO[key] ?? (separated ? 'Other tokens' : 'Tokens and agents');

const REASONS: Record<string, string> = {
  rejected: 'Rejected in review',
  needs_approval: 'Waiting for approval',
  checks_failed: 'Checks failed',
  checks_missing: 'Checks not run',
  open_findings: 'Open findings',
  not_ready: 'Not ready',
  conflict: 'Conflict',
  merge_required: 'Needs a merge',
  stale_head: 'Branch moved',
  stale_parent: 'Branch moved',
  timeout: 'Timed out',
  overloaded: 'Platform busy',
  repo_full: 'Repository full',
  automation_paused: 'Automation paused',
  legal_hold: 'Legal hold',
};
export const reasonLabel = (key: string) => REASONS[key] ?? 'Something else';

const actions = (b: InsightsBar) => b.clones + b.pushes + b.landings + b.failed;
const monthDay = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The activity chart's bars: clones, pushes and landings together. */
export function activityBars(series: InsightsBar[], bucket: TrafficBucket): ChartBar[] {
  return series.map((b) => {
    const start = Date.parse(b.start);
    const axis = bucket === 'hour' ? `${b.start.slice(11, 13)}:00` : monthDay(start);
    return {
      key: b.start,
      value: actions(b),
      estimated: b.estimated,
      axis,
      label:
        bucket === 'hour'
          ? `${monthDay(start)}, ${axis} UTC`
          : bucket === 'week'
            ? `${monthDay(start)} to ${monthDay(Date.parse(b.end) - 1)}`
            : axis,
    };
  });
}

/** Whether there is nothing at all to show. */
export function insightsEmpty({ usage, contributors }: RepoInsights) {
  if (contributors.length > 0 || !usage) return false;
  return usage.clones + usage.fetches + usage.pushes + usage.landings + usage.failed_landings === 0;
}

/** Milliseconds for reading. */
export function duration(ms: number) {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return ms < 60_000 ? `${(ms / 1_000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

/** A share as a percent, with a dash when there's nothing to take it of. */
export const percent = (share: number | null) =>
  share === null ? '—' : `${Math.round(share * 100)}%`;

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Bytes for reading. */
export function byteSize(bytes: number) {
  const step = bytes > 0 ? Math.min(Math.floor(Math.log10(bytes) / 3), UNITS.length - 1) : 0;
  const value = bytes / 1000 ** step;
  return `${step === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[step]}`;
}
