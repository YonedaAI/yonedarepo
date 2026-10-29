// The signed-in Home's account activity (workerd): totals, public and capturing
// repositories, commits per hour, the newest sessions across repositories and the getting
// started steps, from D1 summaries. A page view reads at most a few authorities (the rest
// stay pending for the next view), a session record marks its repository for re-reading,
// another account sees none of it, and a repository token cannot ask.
import { expect, it } from 'vitest';
import { summarize } from '../../cloudflare/worker/platform-account-activity';
import { api, author, countingOps, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const DAY = 86_400_000;
const HOUR = 3_600_000;

it('summarizes the account from bounded authority reads', async () => {
  const cookie = await signup('activity_owner');
  const make = async (name: string, visibility = 'private') =>
    (await api('/repos', { cookie }, { body: { name, visibility, policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } })).body.id as string;
  const ids = [await make('one', 'public'), await make('two')];
  for (const n of [3, 4, 5, 6]) ids.push(await make(`r${n}`));

  // Six repositories without summaries: one view reads four authorities, the rest wait.
  const counting = countingOps(scoped);
  counting.take();
  const first = await api('/activity', { cookie }, {}, counting.env);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(counting.take().repo_activity).toBe(4);
  expect(first.body).toMatchObject({ repositories: 6, public: 1, capturing: 0, landed: 0, pending: 2 });
  expect(first.body.steps).toEqual({ repository: true, pushed: false, cli: false, session: false, landed: false });
  const second = await api('/activity', { cookie }, {}, counting.env);
  expect(counting.take().repo_activity).toBe(2);
  expect(second.body.pending).toBe(0);
  // Every seed commit is counted in an hour bucket inside the last 30 days.
  const commits = second.body.commits as [number, number][];
  expect(commits.reduce((n, [, c]) => n + c, 0)).toBe(6);
  expect(commits.every(([hour]) => hour % HOUR === 0 && hour > Date.now() - 31 * DAY)).toBe(true);
  // Nothing changed since: the next view reads no authority.
  await api('/activity', { cookie }, {}, counting.env);
  expect(counting.take().repo_activity ?? 0).toBe(0);

  // A commit (staged for main, set as a branch) with a session record: the repository is re-read on the
  // next view.
  const agent = (await api(`/repos/${ids[1]}/tokens`, { cookie }, { body: { name: 'agent', scopes: ['read', 'write'] } })).body.token as string;
  const made = await api(`/repos/${ids[1]}/commits`, { token: agent }, { body: { ref: 'main', changes: [file('b.md', 'b\n')], message: 'add b\n\nbody', author } });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const moved = await api(`/repos/${ids[1]}/refs/batch`, { token: agent }, { body: { updates: [{ ref: 'work', commit: made.body.commit, expected: null }] } });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  const posted = await api(`/repos/${ids[1]}/commits/${made.body.commit}/sessions`, { token: agent }, { body: { cli: 'opencode', model: 'glm-5.3', summary: 'added b', session_id: 'opencode:ses_9' } });
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  const third = await api('/activity', { cookie }, {}, counting.env);
  expect(counting.take().repo_activity).toBe(1);
  expect(third.body).toMatchObject({ repositories: 6, capturing: 1, pending: 0 });
  expect(third.body.steps).toMatchObject({ pushed: true, session: true, landed: false });
  expect(third.body.sessions).toHaveLength(1);
  expect(third.body.sessions[0]).toMatchObject({ repo: ids[1], name: 'two', cli: 'opencode', model: 'glm-5.3', summary: 'added b', subject: 'add b', commit: made.body.commit });

  // A personal token (what `yoneda login` mints) completes the CLI step.
  const pat = await api('/tokens', { cookie }, { body: { name: 'cli', scopes: ['repo:read'] } });
  expect(pat.status, JSON.stringify(pat.body)).toBe(200);
  expect((await api('/activity', { cookie })).body.steps.cli).toBe(true);
  expect((await api('/activity', { token: pat.body.token })).body.repositories).toBe(6);

  // Another account sees none of it; a repository token is not an account.
  const stranger = await signup('activity_other');
  expect((await api('/activity', { cookie: stranger })).body).toMatchObject({ repositories: 0, sessions: [], commits: [], pending: 0 });
  expect((await api('/activity', { token: agent })).status).toBe(403);
  expect((await api('/activity', {})).status).toBe(401);
});

it('counts only the last 30 days and the newest sessions across repositories', () => {
  const now = Date.UTC(2026, 9, 28, 18, 30);
  const since = now - 30 * DAY;
  const session = (id: number, at: number) => ({ id, commit: 'c'.repeat(40), cli: 'opencode', model: null, summary: `s${id}`, subject: 'x', session_id: null, at });
  const summary = (over: object) => ({ since: 0, commits: [], commits_total: 1, sessions: [], last_session_at: null, changes_landed: [], changes_landed_total: 0, pushed: false, ...over });
  const out = summarize(
    [
      { id: 'ra', name: 'a', visibility: 'public' },
      { id: 'rb', name: 'b', visibility: 'private' },
      { id: 'rc', name: 'c', visibility: 'private' },
    ],
    new Map([
      // Sessions 40 days ago do not make a repository capturing; its old landings and
      // hour buckets fall outside the window.
      ['ra', summary({ commits: [[since - 2 * HOUR, 3], [since - (since % HOUR), 2], [now - (now % HOUR), 1]], sessions: [session(1, now - 40 * DAY)], last_session_at: now - 40 * DAY, changes_landed: [since - 1, since + 1], changes_landed_total: 2, pushed: true })],
      ['rb', summary({ sessions: Array.from({ length: 10 }, (_, i) => session(i + 10, now - i * HOUR)), last_session_at: now })],
    ]),
    now,
    false,
  );
  expect(out).toMatchObject({ repositories: 3, public: 1, capturing: 1, landed: 1, pending: 1 });
  // The bucket holding `since` still counts; earlier ones do not.
  expect(out.commits).toEqual([[since - (since % HOUR), 2], [now - (now % HOUR), 1]]);
  expect(out.sessions).toHaveLength(10);
  expect(out.sessions[0]).toMatchObject({ repo: 'rb', name: 'b', id: 10 });
  expect(out.sessions.some((s) => s.repo === 'ra')).toBe(false);
  expect(out.steps).toEqual({ repository: true, pushed: true, cli: false, session: true, landed: true });
});
