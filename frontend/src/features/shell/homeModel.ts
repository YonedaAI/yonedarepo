// The signed-in Home's numbers: the greeting, the stat cards, the contribution grid (days by
// hour of day, in the viewer's time zone) and the getting-started steps, from the account
// activity the platform answers (`GET /api/v1/activity`).

export type ActivitySession = {
  repo: string;
  name: string;
  id: number;
  commit: string;
  cli: string;
  model: string | null;
  summary: string;
  subject: string;
  session_id: string | null;
  at: number;
};

export type StepId = 'repository' | 'pushed' | 'cli' | 'session' | 'landed';

export type AccountActivity = {
  now: number;
  since: number;
  repositories: number;
  public: number;
  capturing: number;
  landed: number;
  /** `[hour start (ms), commits]`, oldest first. */
  commits: [number, number][];
  sessions: ActivitySession[];
  steps: Record<StepId, boolean>;
  /** Repositories whose activity the platform has not read yet. */
  pending: number;
};

/** By the viewer's local hour. */
export function greeting(hour: number) {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export type StatCard = { id: string; label: string; value: number; caption: string };

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

export function statCards(a: AccountActivity): StatCard[] {
  const share = a.repositories ? Math.round((a.public / a.repositories) * 100) : 0;
  return [
    {
      id: 'repositories',
      label: 'Repositories',
      value: a.repositories,
      caption: 'across your account and organizations',
    },
    {
      id: 'public',
      label: 'Public',
      value: a.public,
      caption: a.repositories ? `${share}% of your repositories` : 'none yet',
    },
    {
      id: 'capturing',
      label: 'Capturing',
      value: a.capturing,
      caption: `${plural(a.capturing, 'repository', 'repositories')} with agent sessions, last 30 days`,
    },
    {
      id: 'landed',
      label: 'Landed',
      value: a.landed,
      caption: `${plural(a.landed, 'change')} landed, last 30 days`,
    },
  ];
}

export const DAYS = 30;
const DAY_MS = 86_400_000;

export type ContributionDay = { key: string; label: string };
export type ContributionCell = { day: number; hour: number; count: number };
export type ContributionGrid = {
  days: ContributionDay[];
  cells: ContributionCell[];
  total: number;
  max: number;
};

/** `2026-10-28` and the hour (0-23) of `ms` in `timeZone`. */
function localParts(ms: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return {
    key: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
  };
}

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The last 30 local days (oldest first, ending today) by hour of day, each cell the commits
 * whose hour bucket starts then. Buckets are whole UTC hours, so in a zone offset by half
 * an hour a bucket counts at the local hour it starts in.
 */
export function contributionGrid(
  commits: [number, number][],
  now: number,
  timeZone = viewerZone(),
): ContributionGrid {
  const today = localParts(now, timeZone).key;
  const [y, m, d] = today.split('-').map(Number);
  const days: ContributionDay[] = [];
  for (let back = DAYS - 1; back >= 0; back--) {
    // Calendar days, not 24-hour steps: a daylight-saving day is still one column.
    const date = new Date(Date.UTC(y, m - 1, d - back));
    days.push({
      key: date.toISOString().slice(0, 10),
      label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    });
  }
  const index = new Map(days.map((day, i) => [day.key, i]));
  const counts = new Map<string, ContributionCell>();
  for (const [hourStart, n] of commits) {
    const at = localParts(hourStart, timeZone);
    const day = index.get(at.key);
    if (day === undefined || n <= 0) continue;
    const key = `${day}:${at.hour}`;
    const cell = counts.get(key) ?? { day, hour: at.hour, count: 0 };
    cell.count += n;
    counts.set(key, cell);
  }
  const cells = [...counts.values()].sort((a, b) => a.day - b.day || a.hour - b.hour);
  return {
    days,
    cells,
    total: cells.reduce((sum, c) => sum + c.count, 0),
    max: cells.reduce((top, c) => Math.max(top, c.count), 0),
  };
}

/** A bubble's radius: area grows with the count, the busiest hour fills `largest`. */
export const bubbleRadius = (count: number, max: number, largest: number) =>
  max > 0 && count > 0 ? Math.max(2, largest * Math.sqrt(count / max)) : 0;

export const STEPS: { id: StepId; label: string }[] = [
  { id: 'repository', label: 'Create or import a repository' },
  { id: 'pushed', label: 'Push a commit' },
  { id: 'cli', label: 'Install the CLI and run yoneda login' },
  { id: 'session', label: 'Record an agent session' },
  { id: 'landed', label: 'Land a change' },
];

export function gettingStarted(steps: Record<StepId, boolean> | undefined) {
  const items = STEPS.map((s) => ({ ...s, done: Boolean(steps?.[s.id]) }));
  const done = items.filter((s) => s.done).length;
  return { items, done, total: items.length, complete: done === items.length };
}

/** `3 hours ago`, `yesterday`, `Oct 2`. */
export function ago(ms: number, now: number) {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${plural(minutes, 'minute')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'hour')} ago`;
  const days = Math.round((now - ms) / DAY_MS);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
