import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepoNotFound, repoMissing } from './RepoNotFound';
import { onRepoGone, SourceApiError, sourceApi } from './sourceApi';

const REPO = 'r0123456789abcdef0123';
afterEach(() => vi.unstubAllGlobals());

/** fetch answers every request with `status` and the platform error `code`. */
const answer = (status: number, code: string) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: { code, message: code } }, { status })),
  );

describe('a repository that is not there', () => {
  it('maps the status read of a deleted, unknown or foreign repository to not found', () => {
    for (const code of ['GONE', 'NOT_FOUND', 'FORBIDDEN']) expect(repoMissing(code)).toBe(true);
    for (const code of [undefined, 'UNAUTHORIZED', 'TIMEOUT', 'INTERNAL', 'REQUEST_FAILED'])
      expect(repoMissing(code)).toBe(false);
  });

  it('announces a deletion seen by any read under the repository', async () => {
    const seen: string[] = [];
    const stop = onRepoGone((repo) => seen.push(repo));
    answer(404, 'GONE');
    await expect(sourceApi(`/repos/${REPO}/log?ref=main`)).rejects.toBeInstanceOf(SourceApiError);
    await expect(sourceApi(`/repos/${REPO}`)).rejects.toMatchObject({ code: 'GONE' });
    // Not a repository read: nothing to announce.
    await expect(sourceApi('/ssh-keys')).rejects.toMatchObject({ code: 'GONE' });
    stop();
    await expect(sourceApi(`/repos/${REPO}`)).rejects.toMatchObject({ code: 'GONE' });
    expect(seen).toEqual([REPO, REPO]);
  });

  it('does not take a missing branch, change or commit for a missing repository', async () => {
    const seen: string[] = [];
    const stop = onRepoGone((repo) => seen.push(repo));
    answer(404, 'NOT_FOUND');
    await expect(sourceApi(`/repos/${REPO}/changes/7`)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    stop();
    expect(seen).toEqual([]);
  });

  it('shows one not-found page with a way back and a way forward', () => {
    const html = renderToStaticMarkup(
      createElement(RepoNotFound, { navigate: () => {}, onNew: () => {} }),
    );
    expect(html).toContain('Repository not found');
    expect(html).toContain('This repository doesn&#x27;t exist or was deleted');
    expect(html).toContain('href="/"');
    expect(html).toContain('New repository');
    expect(html).not.toContain('role="alert"');
  });
});
