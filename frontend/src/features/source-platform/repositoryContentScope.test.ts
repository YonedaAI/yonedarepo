import { expect, it } from 'vitest';
import type { RepoStatus } from './repoStatus';
import {
  repositoryContentKey,
  repositoryContentScope,
  repositoryImageKey,
  repositoryImagePlace,
} from './repositoryContentScope';

const status = () =>
  ({
    object_store: 'store-a',
    history_chain: 'chain-a',
    quarantine_epoch: 0,
    grant: null,
    visibility: 'private',
    viewer: { principal: 'user:ada', owner: true, role: null, public: false },
  }) as unknown as RepoStatus;

it('retains only a complete identical content and admission scope across fresh responses', () => {
  const a = status();
  expect(repositoryContentScope({ ...a, name: 'renamed' })).toBe(repositoryContentScope(a));
  for (const change of [
    { object_store: 'store-b' },
    { history_chain: 'chain-b' },
    { quarantine_epoch: 1 },
    { grant: ['README.md', 'assets/'] },
    { visibility: 'public' as const },
    { viewer: { ...a.viewer, principal: 'user:bea' } },
    { viewer: { ...a.viewer, owner: false } },
    { viewer: { ...a.viewer, public: true } },
    { viewer: { ...a.viewer, role: 'read' as const } },
  ])
    expect(repositoryContentScope({ ...a, ...change })).not.toBe(repositoryContentScope(a));
});

it('revalidates every fresh incomplete legacy response without remounting its ordinary rerenders', () => {
  for (const change of [
    { object_store: '' },
    { history_chain: null },
    { quarantine_epoch: Number.NaN },
    { quarantine_epoch: -1 },
    { grant: undefined },
    { viewer: undefined },
  ]) {
    const old = { ...status(), ...change } as unknown as RepoStatus;
    expect(repositoryContentScope(old)).toBe(repositoryContentScope(old));
    expect(repositoryContentScope({ ...old })).not.toBe(repositoryContentScope(old));
  }
});

it('separates repository, exact snapshot, source path and selected version without key collisions', () => {
  const place = { repo: 'rfixture', ref: 'a'.repeat(40), path: 'README.md', at: 0 };
  const key = repositoryContentKey('scope', place);
  for (const change of [
    { repo: 'rother' },
    { ref: 'b'.repeat(40) },
    { path: 'docs/README.md' },
    { at: 1 },
    { at: undefined },
  ])
    expect(repositoryContentKey('scope', { ...place, ...change })).not.toBe(key);
  expect(repositoryContentKey('other', place)).not.toBe(key);
});

const imagePlace = { repo: 'rfixture', ref: 'main', path: 'README.md' };
it('pins projected images to their valid Git commit and preserves explicit selection', () => {
  expect(repositoryImagePlace(imagePlace, { commit: 'a'.repeat(40), version: 9 })).toEqual({
    ...imagePlace,
    ref: 'a'.repeat(40),
  });
  expect(repositoryImagePlace({ ...imagePlace, at: 3 }, { commit: null, version: 9 })).toEqual({
    ...imagePlace,
    at: 3,
  });
});
it('pins an unpublished overlay to the captured version and fences subsequent versions', () => {
  const first = repositoryImagePlace(imagePlace, { commit: null, version: 5 });
  expect(first).toEqual({ ...imagePlace, at: 5 });
  const next = repositoryImagePlace(imagePlace, { commit: null, version: 6 });
  expect(repositoryContentKey('scope', first)).not.toBe(repositoryContentKey('scope', next));
  for (const version of [undefined, null, -1, 1.5, Number.NaN, Infinity, '5'])
    expect(repositoryImagePlace(imagePlace, { commit: null, version })).toEqual(imagePlace);
  for (const commit of [undefined, '', 'null', 'main', 5])
    expect(repositoryImagePlace(imagePlace, { commit, version: 0 })).toEqual({
      ...imagePlace,
      at: 0,
    });
});

it('revalidates fresh legacy file responses with neither commit nor captured version', () => {
  const file = { commit: null };
  expect(repositoryImageKey('scope', imagePlace, file)).toBe(
    repositoryImageKey('scope', imagePlace, file),
  );
  expect(repositoryImageKey('scope', imagePlace, { ...file })).not.toBe(
    repositoryImageKey('scope', imagePlace, file),
  );
});
