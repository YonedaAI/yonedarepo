// What a repository's Overview reads out of its newest commits: activity by day and who wrote
// them. One request's worth (the log's page size), so a busy repository's month can run past it.
import type { ChartBar } from '../admin/trafficModel';
import { commitTime, type LogCommit } from './commitLog';

export const OVERVIEW_COMMITS = 200;
export const MONTH_DAYS = 30;
/** Overview needs authors and dates, not every log message or changed-file count. */
export type OverviewCommit = Pick<
  LogCommit,
  'commit' | 'principal' | 'author_name' | 'authored_at'
> & {
  landed?: { landed_at: number } | null;
};

const dayKey = (at: Date) => `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;

/** Whether the log stopped at its page size, with older commits left unread. */
export const logCut = (commits: OverviewCommit[]) => commits.length >= OVERVIEW_COMMITS;

/** Commits a day over the past month, oldest first. A day the log did not reach has no bar:
 * it would read as a day with no commits. */
export function activityBars(commits: OverviewCommit[], now = Date.now()): ChartBar[] {
  const today = new Date(now);
  const counts = new Map<string, number>();
  for (const commit of commits) {
    const at = commitTime(commit);
    if (at !== undefined) {
      const key = dayKey(new Date(at));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const oldest = commitTime(commits.at(-1) ?? {});
  const reached = logCut(commits) && oldest !== undefined ? oldest : 0;
  const bars: ChartBar[] = [];
  for (let back = MONTH_DAYS - 1; back >= 0; back--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    if (end.getTime() <= reached) continue;
    bars.push({
      key: dayKey(day),
      label: day.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
      axis: day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      value: counts.get(dayKey(day)) ?? 0,
    });
  }
  return bars;
}

export type Contributor = { key: string; name?: string; principal: string; commits: number };

/** Who wrote `commits`, most commits first. A commit's author name, else the account behind it. */
export function contributors(commits: OverviewCommit[]): Contributor[] {
  const people = new Map<string, Contributor>();
  for (const { author_name, principal } of commits) {
    const name = author_name ?? undefined;
    const key = name ?? principal;
    const known = people.get(key);
    if (known) known.commits += 1;
    else people.set(key, { key, name, principal, commits: 1 });
  }
  return [...people.values()].sort((a, b) => b.commits - a.commits || a.key.localeCompare(b.key));
}
