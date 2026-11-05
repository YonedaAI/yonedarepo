import { expect, it } from 'vitest';
import { earlyPageReads } from './earlyPageReads';

it('uses exact defaults for lists and shares the sign-up watermark', () => {
  expect(earlyPageReads('/admin/users')).toEqual([
    '/api/v1/admin/accounts',
    '/api/v1/admin/signups?since=0',
  ]);
  expect(earlyPageReads('/admin/repos')[0]).toBe(
    '/api/v1/admin/repos?sort=database&direction=desc',
  );
  expect(earlyPageReads('/repositories')).toEqual(['/api/v1/repos']);
  expect(earlyPageReads('/source/explore')).toEqual(['/api/v1/explore?limit=50']);
  for (const path of [
    '/admin/users?q=secret',
    '/admin/accounts/another-user',
    '/unknown',
    '/admin/audit#filter',
  ])
    expect(earlyPageReads(path)).toEqual([]);
});
