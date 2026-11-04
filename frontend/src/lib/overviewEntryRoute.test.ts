import { expect, it } from 'vitest';
import { RESERVED_HANDLES } from '../../../shared/account';
import { plainNamedOverview } from './overviewEntryRoute';

const route = (path: string) =>
  plainNamedOverview(new URL(path, 'https://example.test'), [...RESERVED_HANDLES]);
it('accepts only a plain initial named Overview, including its canonical trailing slash', () => {
  expect(route('/sample/MiMo-Code')).toEqual({ owner: 'sample', name: 'MiMo-Code' });
  expect(route('/sample/name_1/')).toEqual({ owner: 'sample', name: 'name_1' });
  for (const path of [
    '/agents',
    '/source/r01234567890123456789',
    '/sample/repo/files',
    '/sample/repo?ref=main',
    '/sample/repo?at=1',
    '/sample/repo#readme',
    '/bad-owner/repo',
    '/sample/.hidden',
  ])
    expect(route(path), path).toBeUndefined();
  for (const owner of RESERVED_HANDLES) expect(route(`/${owner}/repo`), owner).toBeUndefined();
});
