import { expect, it } from 'vitest';
import { guideNavigationUrl, guideReferences, saveGuideReference } from './guidedNavigation';

it('restores only repository/session pointers, never cached approvals or results', () => {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  saveGuideReference({ repo_id: 'fresh', session_id: 'guide-session:fresh' }, store);
  expect(guideReferences(store)).toEqual({ fresh: 'guide-session:fresh' });
  expect([...values.values()].join('')).not.toContain('complete');
  const url = guideNavigationUrl(
    'https://yonedarepo.com/?repo=old&run=old-run',
    'fresh',
    'guide-session:fresh',
  );
  expect(url.searchParams.get('repo')).toBe('fresh');
  expect(url.searchParams.get('session')).toBe('guide-session:fresh');
  expect(url.searchParams.has('run')).toBe(false);
  const other = guideNavigationUrl(url.href, 'ordinary');
  expect(other.searchParams.has('guided')).toBe(false);
  expect(other.searchParams.has('session')).toBe(false);
});
