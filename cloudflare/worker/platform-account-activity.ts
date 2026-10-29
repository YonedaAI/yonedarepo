// The signed-in Home's account activity (`GET /api/v1/activity`): the account's
// repositories, how many are public, which recorded agent sessions in the last 30 days,
// changes landed and commits per hour in that window, the newest sessions across them, and
// the getting-started steps. Each repository's numbers come from its D1 summary (the
// authority's `repo_activity` answer); a view re-reads at most REFRESHES authorities whose
// summary is missing, touched since or old, and reports the rest as pending.
import { accountOf, listRepositories } from './repo-admin';
import { type Credentials, caller, type Json } from './repo-ops';
import type { Env } from './types';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WINDOW_MS = 30 * DAY_MS;
/** Authorities one view may read. */
const REFRESHES = 4;
/** A summary older than this is re-read: its 30-day window has moved on. */
const MAX_AGE_MS = HOUR_MS;
const SESSIONS = 10;
const SUMMARY_TEXT = 280;

export type RepoSession = {
  id: number;
  commit: string;
  cli: string;
  model: string | null;
  summary: string;
  subject: string;
  session_id: string | null;
  at: number;
};

/** One repository's `repo_activity` answer as kept in D1. */
export type RepoActivity = {
  since: number;
  commits: [number, number][];
  commits_total: number;
  sessions: RepoSession[];
  last_session_at: number | null;
  changes_landed: number[];
  changes_landed_total: number;
  pushed: boolean;
};

export type ListedRepo = { id: string; name: string; visibility?: string };

export type AccountActivity = {
  now: number;
  since: number;
  repositories: number;
  public: number;
  /** Repositories with an agent session recorded in the window. */
  capturing: number;
  /** Changes landed in the window. */
  landed: number;
  /** `[hour start (ms), commits]`, oldest first. */
  commits: [number, number][];
  sessions: (RepoSession & { repo: string; name: string })[];
  steps: { repository: boolean; pushed: boolean; cli: boolean; session: boolean; landed: boolean };
  /** Repositories whose activity is not read yet. */
  pending: number;
};

const clip = (text: unknown, max: number) => {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** The authority's answer, narrowed to what the Home shows. */
function kept(answer: Json): RepoActivity {
  return {
    since: Number(answer.since),
    commits: (answer.commits as [number, number][]).map(([h, n]) => [Number(h), Number(n)]),
    commits_total: Number(answer.commits_total ?? 0),
    sessions: (answer.sessions as Json[]).slice(0, SESSIONS).map((s) => ({
      id: Number(s.id),
      commit: String(s.commit),
      cli: String(s.cli),
      model: s.model ?? null,
      summary: clip(s.summary, SUMMARY_TEXT),
      subject: clip(s.subject, 200),
      session_id: s.session_id ?? null,
      at: Number(s.at),
    })),
    last_session_at: answer.last_session_at ?? null,
    changes_landed: (answer.changes_landed as unknown[]).map(Number),
    changes_landed_total: Number(answer.changes_landed_total ?? 0),
    pushed: answer.pushed === true,
  };
}

/** Reads the authority's activity and keeps it; `refreshed_at` is the read's start, so a
 * touch while it runs leaves the row due again. */
async function refresh(env: Env, repo: string, now: number): Promise<RepoActivity> {
  const answer = await caller(env, repo, { _system: 'derive' })({
    op: 'repo_activity',
    since: now - WINDOW_MS,
  });
  const summary = kept(answer);
  await env.INDEX.prepare(
    `INSERT INTO platform_activity(repo,refreshed_at,summary) VALUES(?1,?2,?3)
       ON CONFLICT(repo) DO UPDATE SET refreshed_at=?2, summary=?3`,
  )
    .bind(repo, now, JSON.stringify(summary))
    .run();
  return summary;
}

type Row = { repo: string; touched_at: number; refreshed_at: number; summary: string | null };

/** `GET /activity`: the account (session or personal token) only. */
export async function accountActivity(
  env: Env,
  auth: Credentials,
  now = Date.now(),
): Promise<AccountActivity> {
  const account = accountOf(auth);
  const { repos } = await listRepositories(env, auth);
  const ids = repos.map((r) => r.id);
  // One JSON parameter, not one per repository: D1 binds at most 100.
  const [rows, tokens] = await Promise.all([
    env.INDEX.prepare(
      'SELECT repo,touched_at,refreshed_at,summary FROM platform_activity WHERE repo IN (SELECT value FROM json_each(?))',
    )
      .bind(JSON.stringify(ids))
      .all<Row>(),
    env.INDEX.prepare(
      'SELECT COUNT(*) AS n FROM platform_tokens WHERE workspace=? AND expires_at>?',
    )
      .bind(account, now)
      .first<{ n: number }>(),
  ]);
  const byRepo = new Map(rows.results.map((r) => [r.repo, r]));
  const summaries = new Map<string, RepoActivity>();
  for (const r of rows.results) if (r.summary) summaries.set(r.repo, JSON.parse(r.summary));
  const due = (id: string) => {
    const row = byRepo.get(id);
    return (
      !row?.summary || row.touched_at >= row.refreshed_at || row.refreshed_at < now - MAX_AGE_MS
    );
  };
  // Unread repositories first, then the most recently touched.
  const order = (id: string) =>
    byRepo.get(id)?.summary ? (byRepo.get(id)?.touched_at ?? 0) : Infinity;
  const read = ids
    .filter(due)
    .sort((a, b) => order(b) - order(a))
    .slice(0, REFRESHES);
  await Promise.all(
    read.map((id) =>
      refresh(env, id, now).then(
        (summary) => summaries.set(id, summary),
        (e) => console.warn(`activity read failed for ${id}: ${e?.message ?? e}`),
      ),
    ),
  );
  return summarize(repos, summaries, now, (tokens?.n ?? 0) > 0);
}

/** The Home's numbers from the repositories' summaries (pure). */
export function summarize(
  repos: ListedRepo[],
  summaries: Map<string, RepoActivity>,
  now: number,
  cli: boolean,
): AccountActivity {
  const since = now - WINDOW_MS;
  const firstHour = since - (since % HOUR_MS);
  const hours = new Map<number, number>();
  const sessions: AccountActivity['sessions'] = [];
  let capturing = 0;
  let landed = 0;
  let pending = 0;
  const steps = { repository: repos.length > 0, pushed: false, cli, session: false, landed: false };
  for (const repo of repos) {
    const s = summaries.get(repo.id);
    if (!s) {
      pending++;
      continue;
    }
    for (const [hour, n] of s.commits)
      if (hour >= firstHour) hours.set(hour, (hours.get(hour) ?? 0) + n);
    if (s.last_session_at !== null && s.last_session_at >= since) capturing++;
    landed += s.changes_landed.filter((at) => at >= since).length;
    for (const session of s.sessions) sessions.push({ ...session, repo: repo.id, name: repo.name });
    steps.pushed ||= s.pushed;
    steps.session ||= s.last_session_at !== null;
    steps.landed ||= s.changes_landed_total > 0;
  }
  return {
    now,
    since,
    repositories: repos.length,
    public: repos.filter((r) => r.visibility === 'public').length,
    capturing,
    landed,
    commits: [...hours.entries()].sort(([a], [b]) => a - b),
    sessions: sessions.sort((a, b) => b.at - a.at || b.id - a.id).slice(0, SESSIONS),
    steps,
    pending,
  };
}
