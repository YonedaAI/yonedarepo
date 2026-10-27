import { describe, expect, it } from 'vitest';
import { selectRepository, withoutRepositoryLink } from './repositorySelection';

const available = [{ id: 'repo-a' }, { id: 'repo-b' }];

describe('repository selection after discovery', () => {
  it('reports a deep link to a repository that is not in the workspace', () => {
    expect(
      selectRepository({ requested: 'repo-x', current: 'repo-x', available, deleted: new Set() }),
    ).toEqual({ id: 'repo-a', missing: true });
  });

  it('ignores the original link once it has been followed', () => {
    expect(
      selectRepository({
        requested: 'repo-x',
        current: 'repo-b',
        available,
        deleted: new Set(),
        linkFollowed: true,
      }),
    ).toEqual({ id: 'repo-b', missing: false });
  });

  it('moves on without an error when the linked repository was deleted in this session', () => {
    expect(
      selectRepository({
        requested: 'repo-x',
        current: '',
        available,
        deleted: new Set(['repo-x']),
      }),
    ).toEqual({ id: 'repo-a', missing: false });
  });

  it('keeps the current selection when it still exists', () => {
    expect(
      selectRepository({ requested: '', current: 'repo-b', available, deleted: new Set() }),
    ).toEqual({ id: 'repo-b', missing: false });
  });
});

describe('repository link cleanup', () => {
  it('drops repository and run parameters and keeps the rest', () => {
    expect(withoutRepositoryLink('https://yonedarepo.com/?repo=repo-x&run=r1&tab=runs#top')).toBe(
      'https://yonedarepo.com/?tab=runs#top',
    );
  });
});
