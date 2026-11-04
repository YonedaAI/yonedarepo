// A change's route as the page renders it: the timeline's order, what it says about sessions
// and delivered context, quarantine, a cut list, and reading it when the route can't be read.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeRoute as Route } from '../../../../shared/contracts/change-route';
import type { Push } from './changeModel';
import type { Loaded } from './useSource';

const state: { route: Loaded<Route>; paths: (string | null)[] } = {
  route: { loading: true, reload: () => {} },
  paths: [],
};
vi.mock('./useSource', () => ({
  useSource: (path: string | null) => {
    state.paths.push(path);
    return state.route;
  },
}));

const { ChangeRoute } = await import('./ChangeRoute');
const { deliveredItems, deliveredLine, routeCut, routeSummary, routeTimeline, sessionBytes } =
  await import('./routeModel');

const first = 'a'.repeat(40);
const second = 'b'.repeat(40);
const push: Push = {
  version: 3,
  action: 'moved',
  before: first,
  after: second,
  actor: 'user:ada',
  at: 250,
};
const session = (over: Partial<Route['sessions'][number]> = {}) => ({
  id: 1,
  commit: first,
  cli: 'claude-code',
  model: 'opus',
  summary: 'Added the retry',
  session_id: 'claude-code:s1',
  recorded_by: 'user:ada',
  at: 300,
  fetched_bytes: 2048,
  read_bytes: 1024,
  quarantined: false,
  ...over,
});
const route = (over: Partial<Route> = {}): Route => ({
  number: 7,
  status: 'open',
  branch: 'fix',
  base: 'main',
  head: second,
  merge_base: 'c'.repeat(40),
  commits: [
    { commit: second, parents: [first], subject: 'Cap it', principal: 'user:ada', at: 200 },
    { commit: first, parents: [], subject: 'Retry', principal: 'user:ada', at: 100 },
  ],
  sessions: [session({ id: 2, commit: second, at: 400 }), session()],
  deliveries: [
    {
      seq: 1,
      session_id: 'claude-code:s1',
      trigger: 'start',
      subject: null,
      bytes: 300,
      principal: 'user:ada',
      at: 50,
      items: [
        { type: 'change', id: 3, label: '#3 Earlier' },
        { type: 'memory', id: 9, label: 'gotcha: caps at 30s' },
      ],
    },
    {
      seq: 2,
      session_id: 'claude-code:s1',
      trigger: 'read',
      subject: 'src/retry.rs',
      bytes: 40,
      principal: 'user:ada',
      at: 60,
      items: [{ type: 'memory', id: 9, label: 'gotcha: caps at 30s' }],
    },
  ],
  checks: [{ commit: second, name: 'unit', status: 'fail', principal: 'token:ci', at: 500 }],
  totals: {
    commits: 2,
    sessions: 1,
    read_bytes: 1024,
    fetched_bytes: 2048,
    delivered_bytes: 340,
    memories_delivered: 1,
  },
  truncated: { commits: false, sessions: false, deliveries: false, checks: false },
  ...over,
});
const loaded = (over: Partial<Loaded<Route>>): Loaded<Route> => ({
  loading: false,
  reload: () => {},
  ...over,
});
const view = (pushes: Push[] = [push]) =>
  renderToStaticMarkup(
    createElement(ChangeRoute, { repo: 'r1', number: 7, pushes, navigate: () => {} }),
  );

beforeEach(() => {
  state.route = { loading: true, reload: () => {} };
  state.paths = [];
});

describe('the route timeline', () => {
  it('runs oldest first, a commit before the push that brought it', () => {
    const kinds = routeTimeline(route(), [push]).map((item) => item.kind);
    expect(kinds).toEqual(['commit', 'commit', 'push', 'session', 'session', 'check']);
  });

  it('puts a coding session on its first record only, whatever its deliveries', () => {
    const sessions = routeTimeline(route(), []).flatMap((item) =>
      item.kind === 'session' ? [item] : [],
    );
    expect(sessions.map((s) => [s.session.id, s.delivered.length])).toEqual([
      [1, 2],
      [2, 0],
    ]);
  });

  it('is the pushes alone without a route', () => {
    expect(routeTimeline(undefined, [push]).map((item) => item.kind)).toEqual(['push']);
  });
});

describe('route wording', () => {
  it('counts each delivered item once, memories first', () => {
    const { deliveries } = route();
    expect(deliveredItems(deliveries).map((i) => i.type)).toEqual(['memory', 'change']);
    expect(deliveredLine(deliveries)).toBe('1 memory and 1 other item delivered · 340 B');
    expect(deliveredLine(deliveries.slice(1))).toBe('1 memory delivered · 40 B');
    const warned = (label: string) => ({ type: 'traffic', id: 5, label });
    const files = [warned('Landing #5: a.rs'), warned('Landing #5: b.rs')];
    expect(deliveredItems([{ ...deliveries[0], items: files }])).toHaveLength(2);
    expect(
      deliveredLine([{ ...deliveries[0], items: [{ type: 'change', id: 1, label: null }] }]),
    ).toBe('1 item delivered · 300 B');
  });

  it('shows bytes, and nothing where a session reported none', () => {
    expect(sessionBytes(session())).toBe('1.0 KiB read · 2.0 KiB fetched');
    expect(sessionBytes({ read_bytes: 10, fetched_bytes: null })).toBe('10 B read');
    expect(sessionBytes({ read_bytes: null, fetched_bytes: null })).toBeNull();
    expect(routeSummary(route().totals, route().sessions)).toBe(
      '2 commits · 1 session · 1.0 KiB read · 1 memory delivered',
    );
  });

  it.each([
    { name: 'all unknown', reads: [null, null], total: 0, expected: '' },
    { name: 'mixed', reads: [1024, null], total: 1024, expected: '' },
    { name: 'no records', reads: [], total: 0, expected: '' },
    { name: 'known zero', reads: [0], total: 0, expected: '0 B read · ' },
    { name: 'known bytes', reads: [1024, 2048], total: 3072, expected: '3.0 KiB read · ' },
  ])('summarizes read volume honestly with $name', ({ reads, total, expected }) => {
    const r = route({ sessions: reads.map((read_bytes) => session({ read_bytes })) });
    expect(routeSummary({ ...r.totals, read_bytes: total }, r.sessions)).toBe(
      `2 commits · 1 session · ${expected}1 memory delivered`,
    );
  });

  it('names what the server cut', () => {
    expect(routeCut(route().truncated)).toBeNull();
    const cut = { commits: true, sessions: false, deliveries: true, checks: false };
    expect(routeCut(cut)).toBe('commits, deliveries');
  });
});

describe('the Route section', () => {
  it('reads one path and lists every step', () => {
    state.route = loaded({ data: route() });
    const page = view();
    expect(state.paths).toEqual(['/repos/r1/changes/7/route']);
    expect(page).toContain('2 commits · 1 session · 1.0 KiB read · 1 memory delivered');
    expect(page).toContain('Cap it');
    expect(page).toContain('ada pushed');
    expect(page).toContain('Added the retry');
    expect(page).toContain('1.0 KiB read · 2.0 KiB fetched');
    expect(page).toContain('1 memory and 1 other item delivered · 340 B');
    expect(page).toContain('gotcha: caps at 30s');
    expect(page).toContain('<span class="chip run-bad">fail</span>');
    expect(page).not.toContain('Showing only');
  });

  it('does not turn missing session byte counters into a zero-byte route', () => {
    const r = route({
      sessions: [session({ read_bytes: null, fetched_bytes: null })],
      totals: { ...route().totals, read_bytes: 0, fetched_bytes: 0 },
    });
    state.route = loaded({ data: r });
    const page = view();
    expect(page).toContain('2 commits · 1 session · 1 memory delivered');
    expect(page).not.toContain('0 B read');
    expect(page).toContain('Added the retry');
  });

  it('marks withheld text and names what was cut', () => {
    const withheld = session({ summary: null, quarantined: true });
    state.route = loaded({
      data: route({
        sessions: [withheld],
        truncated: { commits: true, sessions: false, deliveries: false, checks: false },
      }),
    });
    const page = view();
    expect(page).toContain('Withheld by the repository owner (quarantined).');
    expect(page).toContain('Showing only the newest commits.');
  });

  it('says so while loading, and when the change has no commits of its own', () => {
    expect(view()).toContain('Loading the route…');
    state.route = loaded({
      data: route({ commits: [], sessions: [], deliveries: [], checks: [] }),
    });
    expect(view([])).toContain('Nothing on this route');
  });

  it('keeps the pushes and offers a retry when the route fails', () => {
    state.route = loaded({ error: 'The server failed' });
    const page = view();
    expect(page).toContain('The server failed');
    expect(page).toContain('Retry');
    expect(page).toContain('ada pushed');
    expect(page).not.toContain('Nothing on this route');
  });
});
