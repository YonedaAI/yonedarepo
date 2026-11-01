// The Insights page as the server would render it: every section full, then the empty, loading and
// error states, and a read of the figures that failed with its contributors still there.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoInsights as Insights, RepoUsage } from '../../../../shared/repo-insights';
import type { Loaded } from './useSource';

const state: { value: Loaded<Insights>; paths: (string | null)[] } = {
  value: { loading: true, reload: () => {} },
  paths: [],
};
vi.mock('./useSource', () => ({
  useSource: (path: string | null) => {
    state.paths.push(path);
    return state.value;
  },
}));

const { RepoInsights } = await import('./RepoInsights');
const { activityBars, byteSize, duration, insightsEmpty, percent, reasonLabel, whoLabel } =
  await import('./insightsModel');

const REPO = 'r0123456789abcdef0123';
const render = () => renderToStaticMarkup(createElement(RepoInsights, { repo: REPO }));
const usage = (over: Partial<RepoUsage> = {}): RepoUsage => ({
  clones: 12,
  fetches: 3,
  pushes: 4,
  landings: 5,
  failed_landings: 2,
  estimated: false,
  bucket: 'day',
  series: [
    {
      start: '2026-10-31T00:00:00.000Z',
      end: '2026-11-01T00:00:00.000Z',
      clones: 12,
      pushes: 4,
      landings: 5,
      failed: 2,
      estimated: false,
    },
  ],
  who: [
    { key: 'token', count: 16, estimated: false },
    { key: 'person', count: 5, estimated: false },
  ],
  reasons: [{ key: 'needs_approval', count: 2, estimated: false }],
  ...over,
});
const answer = (over: Partial<Insights> = {}): Insights => ({
  range: '30d',
  ranges: ['24h', '7d', '30d', '90d'],
  usage: usage(),
  contributors: [{ principal: 'user:ada', commits: 7 }],
  more: false,
  ...over,
});
const loaded = (data: Insights) => ({ data, loading: false, reload: () => {} });

beforeEach(() => {
  state.value = { loading: true, reload: () => {} };
  state.paths.length = 0;
});

describe('the page', () => {
  it('asks for the 30 days first, and says so while it loads', () => {
    expect(render()).toContain('Loading insights');
    expect(state.paths).toEqual([`/repos/${REPO}/insights?range=30d`]);
  });

  it('shows the figures, who, why and the contributors, with no internal words', () => {
    state.value = loaded(answer());
    const html = render();
    for (const line of [
      'Clones',
      'Failed landings',
      'People in the browser',
      'Tokens and agents',
      'Waiting for approval',
      'ada',
    ])
      expect(html).toContain(line);
    expect(html).not.toMatch(/needs_approval|Analytics Engine|REPO_ANALYTICS/);
    expect(html).not.toContain('≈');
  });

  it('marks estimates', () => {
    state.value = loaded(answer({ usage: usage({ estimated: true }) }));
    expect(render()).toContain('≈12');
    expect(render()).toContain('≈ is an estimate');
  });

  it('shows the shared empty state with nothing at all', () => {
    state.value = loaded(
      answer({
        contributors: [],
        usage: usage({
          clones: 0,
          fetches: 0,
          pushes: 0,
          landings: 0,
          failed_landings: 0,
          who: [],
          reasons: [],
        }),
      }),
    );
    const html = render();
    expect(html).toContain('Nothing in this range');
    expect(html).not.toContain('Failed landings');
  });

  it('says one line for a section with nothing in it', () => {
    state.value = loaded(answer({ usage: usage({ reasons: [] }), contributors: [] }));
    const html = render();
    expect(html).toContain('None failed in this range.');
    expect(html).toContain('No commits in this range.');
    expect(html).not.toContain('Reason');
  });

  it('keeps the contributors when the figures failed, and offers a retry', () => {
    state.value = loaded(answer({ usage: null }));
    const html = render();
    expect(html).toContain('load clones, pushes and landings');
    expect(html).toContain('ada');
  });

  it('offers a way out of a failed read', () => {
    state.value = { error: 'Not found', loading: false, reload: () => {} };
    expect(render()).toContain('role="alert"');
  });
});

describe('its words', () => {
  it('names what it knows and hides what it does not', () => {
    expect(reasonLabel('checks_failed')).toBe('Checks failed');
    expect(reasonLabel('some_new_code')).toBe('Something else');
    expect(whoLabel('person')).toBe('People in the browser');
    expect(whoLabel('repo_token')).toBe('Tokens and agents');
  });

  it('adds a day up to one bar', () => {
    const [bar] = activityBars(usage().series, 'day');
    expect(bar).toMatchObject({ value: 23, axis: 'Oct 31', label: 'Oct 31' });
  });

  it('reads an empty answer only with no contributors', () => {
    expect(insightsEmpty(answer())).toBe(false);
    expect(insightsEmpty(answer({ contributors: [], usage: null }))).toBe(false);
  });

  it('writes durations, shares and sizes for reading', () => {
    expect(duration(340)).toBe('340 ms');
    expect(duration(1500)).toBe('1.5 s');
    expect(duration(90_000)).toBe('1.5 min');
    expect(percent(0.916)).toBe('92%');
    expect(percent(null)).toBe('—');
    expect(byteSize(0)).toBe('0 B');
    expect(byteSize(2_500_000)).toBe('2.5 MB');
  });
});
