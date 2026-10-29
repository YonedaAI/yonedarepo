// The signed-in Home: greeting by local hour, the stat cards, the contribution grid in the
// viewer's time zone (days by hour, calendar days across daylight saving), the bubble sizes,
// the getting-started steps and the empty and pending states.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HomeDashboard } from './HomeDashboard';
import {
  type AccountActivity,
  bubbleRadius,
  contributionGrid,
  gettingStarted,
  greeting,
  statCards,
} from './homeModel';

const HOUR = 3_600_000;
const empty: AccountActivity = {
  now: Date.UTC(2026, 9, 28, 18),
  since: Date.UTC(2026, 9, 28, 18) - 30 * 86_400_000,
  repositories: 0,
  public: 0,
  capturing: 0,
  landed: 0,
  commits: [],
  sessions: [],
  steps: { repository: false, pushed: false, cli: false, session: false, landed: false },
  pending: 0,
};

describe('home greeting and stat cards', () => {
  it('greets by the local hour', () => {
    expect([4, 5, 11, 12, 17, 18, 23].map(greeting)).toEqual([
      'Good evening',
      'Good morning',
      'Good morning',
      'Good afternoon',
      'Good afternoon',
      'Good evening',
      'Good evening',
    ]);
  });

  it('reads the four cards from the activity, with the public share', () => {
    const cards = statCards({ ...empty, repositories: 8, public: 2, capturing: 1, landed: 5 });
    expect(cards.map((c) => [c.label, c.value])).toEqual([
      ['Repositories', 8],
      ['Public', 2],
      ['Capturing', 1],
      ['Landed', 5],
    ]);
    expect(cards[1].caption).toBe('25% of your repositories');
    expect(cards[2].caption).toBe('repository with agent sessions, last 30 days');
    expect(cards[3].caption).toBe('changes landed, last 30 days');
    expect(statCards(empty)[1].caption).toBe('none yet');
  });
});

describe('contribution grid', () => {
  it('buckets by local day and hour in the viewer time zone', () => {
    const now = Date.UTC(2026, 9, 28, 18, 30); // 11:30 in Los Angeles (PDT)
    const commits: [number, number][] = [
      [Date.UTC(2026, 9, 28, 3), 2], // Oct 27, 20:00 in LA
      [Date.UTC(2026, 9, 28, 17), 1], // Oct 28, 10:00
      [Date.UTC(2026, 9, 28, 17), 4], // the same hour from another repository
      [Date.UTC(2026, 8, 20, 12), 9], // before the 30 days
    ];
    const la = contributionGrid(commits, now, 'America/Los_Angeles');
    expect(la.days).toHaveLength(30);
    expect(la.days.at(-1)).toEqual({ key: '2026-10-28', label: 'Oct 28' });
    expect(la.days[0].key).toBe('2026-09-29');
    expect(la.cells).toEqual([
      { day: 28, hour: 20, count: 2 },
      { day: 29, hour: 10, count: 5 },
    ]);
    expect([la.total, la.max]).toEqual([7, 5]);
    // The same instants in UTC fall on other cells.
    const utc = contributionGrid(commits, now, 'UTC');
    expect(utc.cells).toEqual([
      { day: 29, hour: 3, count: 2 },
      { day: 29, hour: 17, count: 5 },
    ]);
    // A half-hour zone counts a bucket at the local hour it starts in.
    const india = contributionGrid([[Date.UTC(2026, 9, 28, 4), 1]], now, 'Asia/Kolkata');
    // (It is already Oct 29 there: Oct 28 is the second-to-last column.)
    expect(india.cells).toEqual([{ day: 28, hour: 9, count: 1 }]);
  });

  it('keeps one column per calendar day across a daylight-saving change', () => {
    // US clocks fall back on 2026-11-01; 30 days ending Nov 15 span it.
    const grid = contributionGrid([], Date.UTC(2026, 10, 15, 20), 'America/New_York');
    const keys = grid.days.map((d) => d.key);
    expect(new Set(keys).size).toBe(30);
    expect(keys).toContain('2026-11-01');
    expect(keys[0]).toBe('2026-10-17');
    expect(grid).toMatchObject({ cells: [], total: 0, max: 0 });
  });

  it('sizes bubbles by area, the busiest hour largest', () => {
    expect(bubbleRadius(4, 4, 10)).toBe(10);
    expect(bubbleRadius(1, 4, 10)).toBe(5);
    expect(bubbleRadius(0, 4, 10)).toBe(0);
    expect(bubbleRadius(1, 400, 10)).toBe(2);
  });
});

describe('getting started', () => {
  it('counts the real steps done', () => {
    const progress = gettingStarted({ ...empty.steps, repository: true, cli: true });
    expect([progress.done, progress.total, progress.complete]).toEqual([2, 5, false]);
    expect(progress.items.map((s) => s.done)).toEqual([true, false, true, false, false]);
    expect(gettingStarted(undefined).done).toBe(0);
    const all = { repository: true, pushed: true, cli: true, session: true, landed: true };
    expect(gettingStarted(all).complete).toBe(true);
  });
});

describe('home dashboard', () => {
  const render = (activity: AccountActivity | undefined, extra: object = {}) =>
    renderToStaticMarkup(
      createElement(HomeDashboard, {
        username: 'ada',
        activity,
        loading: false,
        error: '',
        onRetry: () => {},
        navigate: () => {},
        onNew: () => {},
        ...extra,
      }),
    );

  it('greets, shows the cards in monospace and the empty states', () => {
    const html = render(empty);
    expect(html).toMatch(/Good (morning|afternoon|evening), ada/);
    expect(html).toContain('overview of your recent activity');
    expect(html.match(/class="stat-value"/g)).toHaveLength(4);
    expect(html).toContain('No commits yet');
    expect(html).toContain('No sessions recorded yet');
    expect(html).toContain('aria-labelledby="home-contributions"');
  });

  it('draws one bubble per busy hour and lists sessions with their repository', () => {
    const now = Date.now();
    const hour = now - (now % HOUR) - 2 * HOUR;
    const html = render({
      ...empty,
      now,
      repositories: 1,
      commits: [[hour, 3]],
      sessions: [
        {
          repo: 'r0000000000000000000a',
          name: 'parser',
          id: 7,
          commit: 'c'.repeat(40),
          cli: 'opencode',
          model: 'glm-5.3',
          summary: 'Added the parser',
          subject: 'parser',
          session_id: null,
          at: now - HOUR,
        },
      ],
    });
    expect(html.match(/<circle/g)).toHaveLength(1);
    expect(html).toContain('3 commits');
    expect(html).toContain('href="/source/r0000000000000000000a/agents/sessions/7"');
    expect(html).toContain('Added the parser');
    expect(html).not.toContain('No commits yet');
  });

  it('says when repositories are still being read, and when the read failed', () => {
    expect(render({ ...empty, repositories: 9, pending: 3 })).toContain(
      'Activity for 3 repositories are still being gathered',
    );
    const failed = render(undefined, { error: 'Network down' });
    expect(failed).toContain('Network down');
    expect(failed).toContain('Retry');
  });
});
