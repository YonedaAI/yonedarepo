import { describe, expect, it } from 'vitest';
import {
  EXPLORE_PAGE,
  type ExploreRepo,
  exploreList,
  explorePath,
  ownerName,
} from './exploreModel';

const repo = (n: number, created_at = 1_000_000 - n): ExploreRepo => ({
  id: `r${String(n).padStart(20, '0')}`,
  name: `repo-${n}`,
  owner: 'ada',
  created_at,
  visibility: 'public',
});
const page = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => repo(from + i));

describe('explore list', () => {
  it('asks for a page, then the page before the oldest shown', () => {
    expect(explorePath()).toBe(`/explore?limit=${EXPLORE_PAGE}`);
    expect(explorePath(1700000000000)).toBe(`/explore?limit=${EXPLORE_PAGE}&before=1700000000000`);
    expect(explorePath(0)).toBe(`/explore?limit=${EXPLORE_PAGE}&before=0`);
  });

  it('is empty, with nothing more, before any repository is public', () => {
    expect(exploreList([])).toEqual({ repos: [] });
    expect(exploreList([[]])).toEqual({ repos: [] });
  });

  it('offers more while the last page was full, from its oldest repository', () => {
    const first = page(0, EXPLORE_PAGE);
    const listed = exploreList([first]);
    expect(listed.repos).toHaveLength(EXPLORE_PAGE);
    expect(listed.next).toBe(first[EXPLORE_PAGE - 1].created_at);
    const done = exploreList([first, page(EXPLORE_PAGE, 3)]);
    expect(done.repos).toHaveLength(EXPLORE_PAGE + 3);
    expect(done.next).toBeUndefined();
  });

  it('keeps order and drops a repository read twice across pages', () => {
    const first = page(0, EXPLORE_PAGE);
    const second = [first[EXPLORE_PAGE - 1], repo(99)];
    const { repos } = exploreList([first, second]);
    expect(repos).toHaveLength(EXPLORE_PAGE + 1);
    expect(repos.at(-1)?.name).toBe('repo-99');
  });
});

describe('explore owner', () => {
  it('names the owner by handle, and an email-named owner without one as hidden', () => {
    expect(ownerName({ ...repo(1), owner: 'ada', owner_handle: 'ada' })).toBe('ada');
    // The public list sends `owner: null` while an email-named owner has no handle.
    expect(ownerName({ ...repo(1), owner: null, owner_handle: null })).toBe('member');
    expect(ownerName({ ...repo(1), owner: 'ada@example.com' })).toBe('member');
  });
});
