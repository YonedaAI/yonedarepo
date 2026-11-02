import { describe, expect, it } from 'vitest';
import type { LogCommit } from './commitLog';
import { activityBars, contributors, logCut, OVERVIEW_COMMITS } from './overviewModel';

const NOW = new Date(2026, 9, 31, 12).getTime();
const DAY = 86_400_000;
const commit = (at: number, author_name: string | null = 'Ada', principal = 'user:ada') =>
  ({ commit: 'c', message: 'm', principal, author_name, authored_at: at }) as LogCommit;

describe('activityBars', () => {
  it('counts commits by day over the past month, today last', () => {
    const bars = activityBars([commit(NOW), commit(NOW - 1000), commit(NOW - 2 * DAY)], NOW);
    expect(bars).toHaveLength(30);
    expect(bars.at(-1)?.value).toBe(2);
    expect(bars.at(-2)?.value).toBe(0);
    expect(bars.at(-3)?.value).toBe(1);
  });

  it('leaves out commits older than the month', () => {
    const bars = activityBars([commit(NOW - 40 * DAY)], NOW);
    expect(bars.reduce((sum, b) => sum + b.value, 0)).toBe(0);
  });

  it('falls back to when a commit landed', () => {
    const landed = { commit: 'c', message: 'm', principal: 'user:a', landed: { landed_at: NOW } };
    expect(activityBars([landed as LogCommit], NOW).at(-1)?.value).toBe(1);
  });

  it('draws no bar for days a cut-off log did not reach: they are not days without commits', () => {
    const full = Array.from({ length: OVERVIEW_COMMITS }, () => commit(NOW - 3 * DAY));
    expect(logCut(full)).toBe(true);
    const bars = activityBars(full, NOW);
    expect(bars).toHaveLength(4);
    expect(bars[0].value).toBe(OVERVIEW_COMMITS);
  });

  it('keeps the whole month when a cut-off log reaches past it', () => {
    const full = Array.from({ length: OVERVIEW_COMMITS }, () => commit(NOW - 40 * DAY));
    expect(activityBars(full, NOW)).toHaveLength(30);
  });
});

describe('contributors', () => {
  it('counts by author, most commits first, and uses the account without a name', () => {
    const people = contributors([
      commit(NOW, 'Lin'),
      commit(NOW, 'Ada'),
      commit(NOW, 'Ada'),
      commit(NOW, null, 'user:bot'),
    ]);
    expect(people.map((p) => [p.key, p.commits])).toEqual([
      ['Ada', 2],
      ['Lin', 1],
      ['user:bot', 1],
    ]);
    expect(people[2].name).toBeUndefined();
  });
});
