import { afterEach, expect, it, vi } from 'vitest';
import { prepareSiteEntry } from './SiteEntry';
import { PERSONAL_WORKSPACE_HINT, personalWorkspaceHint, signedInHint } from './signedInHint';
import { SIGNED_IN_HINT } from './siteRoute';

afterEach(() => vi.unstubAllGlobals());
it('keeps code for public pages out of repository, agents and account entry', () => {
  for (const path of ['/example/project', '/agents', '/settings', '/signin/extra'])
    expect(prepareSiteEntry(path, false)).toBeUndefined();
  expect(prepareSiteEntry('/', true)).toBeUndefined();
});
it('prepares recognized public documents without changing their route', async () => {
  for (const path of ['/', '/signin', '/signup', '/docs/guides/cli', '/blog'])
    await expect(prepareSiteEntry(path, false)).resolves.toBeUndefined();
});
it('stores only a display hint and tolerates blocked browser storage', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => values.get(k),
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
    },
  });
  expect(signedInHint()).toBe(false);
  expect(signedInHint(true)).toBe(true);
  expect([...values]).toEqual([[SIGNED_IN_HINT, '1']]);
  personalWorkspaceHint('person@example.test');
  expect(values.get(PERSONAL_WORKSPACE_HINT)).toBe('person@example.test');
  personalWorkspaceHint(null);
  expect(values.has(PERSONAL_WORKSPACE_HINT)).toBe(false);
  expect(signedInHint(false)).toBe(false);
  vi.stubGlobal('window', {
    get localStorage() {
      throw new Error('Blocked');
    },
  });
  expect(signedInHint(true)).toBe(false);
  expect(() => personalWorkspaceHint('sample')).not.toThrow();
});
