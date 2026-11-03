// One authority page per region, from only repositories counted in the clicked chart.
import type { ContributionDetails } from '../../shared/contributions';
import { thisCell } from './cells';
import type { RepoActivity } from './platform-account-activity';
import { contributionSnapshot } from './platform-contribution-snapshot';
import { accountOf, listRepositories, requirePatScope } from './repo-admin';
import { ApiError, type Credentials, caller, type Json } from './repo-ops';
import type { Env } from './types';

const HOUR = 3_600_000;
const changed = () =>
  new ApiError('ACTIVITY_CHANGED', 'Activity changed. Refresh to see the latest contributions.');

function object(text: string | null): Record<string, unknown> {
  try {
    const value = JSON.parse(text ?? '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw new ApiError('INVALID_INPUT', 'Invalid contribution page');
  }
}

export async function accountContributions(
  env: Env,
  auth: Credentials,
  url: URL,
): Promise<ContributionDetails> {
  const account = accountOf(auth);
  requirePatScope(auth, 'repo:read');
  const hours = (url.searchParams.get('hours') ?? '')
    .split(',')
    .map(Number)
    .sort((a, b) => a - b);
  if (
    !hours.length ||
    hours.length > 2 ||
    new Set(hours).size !== hours.length ||
    hours.some((h) => !Number.isSafeInteger(h) || h <= 0 || h % HOUR)
  )
    throw new ApiError('INVALID_INPUT', 'Select one or two UTC hours');
  const cell = thisCell(env);
  const snapshots = object(url.searchParams.get('snapshots'));
  const cursors = object(url.searchParams.get('cursors'));
  const { repos } = await listRepositories(env, auth);
  const { results } = await env.INDEX.prepare(
    'SELECT repo,summary FROM platform_activity WHERE repo IN (SELECT value FROM json_each(?))',
  )
    .bind(JSON.stringify(repos.map((r) => r.id)))
    .all<{ repo: string; summary: string | null }>();
  const summaries = new Map<string, RepoActivity>(
    results.filter((r) => r.summary).map((r) => [r.repo, JSON.parse(r.summary as string)]),
  );
  const snapshot = await contributionSnapshot(account, repos, summaries);
  if (!snapshot || snapshots[cell] !== snapshot) throw changed();
  const counted = repos
    .map((repo) => ({ repo, summary: summaries.get(repo.id) as RepoActivity }))
    .map((row) => ({
      ...row,
      count: row.summary.commits
        .filter(([h]) => hours.includes(h))
        .reduce((n, [, count]) => n + count, 0),
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => a.repo.id.localeCompare(b.repo.id));
  const total = counted.reduce((n, row) => n + row.count, 0);
  const empty = { items: [], total, cursors: { [cell]: null } };
  if (Object.hasOwn(cursors, cell) && cursors[cell] === null) return empty;
  let index = 0;
  let after: Json | undefined;
  if (Object.hasOwn(cursors, cell)) {
    if (typeof cursors[cell] !== 'string')
      throw new ApiError('INVALID_INPUT', 'Invalid contribution cursor');
    const cursor = object(cursors[cell] as string);
    if (cursor.snapshot !== snapshot || JSON.stringify(cursor.hours) !== JSON.stringify(hours))
      throw changed();
    index = counted.findIndex(({ repo }) => repo.id === cursor.repo);
    if (index < 0) throw new ApiError('INVALID_INPUT', 'Invalid contribution cursor');
    after = cursor.after as Json | undefined;
  }
  if (!counted.length) return empty;
  const { repo, summary, count } = counted[index];
  const page = await caller(
    env,
    repo.id,
    auth,
  )({
    op: 'repo_contributions',
    hours,
    since: summary.since,
    snapshot: summary.snapshot,
    limit: 25,
    ...(after ? { after } : {}),
  });
  if (page.total !== count) throw changed();
  const more = page.next || index + 1 < counted.length;
  const nextRepo = page.next ? repo : counted[index + 1]?.repo;
  const next = more
    ? JSON.stringify({ snapshot, hours, repo: nextRepo.id, after: page.next ?? null })
    : null;
  return {
    items: page.items.map((item: Json) => ({ ...item, repo: repo.id, name: repo.name })),
    total,
    cursors: { [cell]: next },
  };
}

export function mergeContributions(parts: ContributionDetails[]): ContributionDetails {
  return {
    items: parts.flatMap((p) => p.items),
    total: parts.reduce((n, p) => n + p.total, 0),
    cursors: Object.assign({}, ...parts.map((p) => p.cursors)),
  };
}
