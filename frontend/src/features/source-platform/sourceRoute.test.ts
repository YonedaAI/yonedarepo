import { describe, expect, it } from 'vitest';
import { patchRows } from './patchRows';
import { formatSourceRoute, parseSourceRoute, type SourceRoute } from './sourceRoute';

const repo = `r${'a'.repeat(20)}`;
const sha = 'b'.repeat(40);

describe('source routes', () => {
  it('round-trips every view', () => {
    const routes: SourceRoute[] = [
      { view: 'repos' },
      { view: 'files', repo, path: '', ref: 'main' },
      { view: 'files', repo, path: 'src/a b.rs', ref: 'feature/x', at: 3 },
      { view: 'history', repo, ref: 'main' },
      { view: 'history', repo, ref: 'dev' },
      { view: 'commit', repo, commit: sha },
      { view: 'transactions', repo },
    ];
    for (const route of routes) {
      const url = new URL(formatSourceRoute(route), 'https://x');
      expect(parseSourceRoute(url.pathname, url.search)).toEqual(route);
    }
  });
  it('falls back safely on malformed input', () => {
    expect(parseSourceRoute('/source/not-a-repo', '')).toEqual({ view: 'repos' });
    expect(parseSourceRoute(`/source/${repo}/commit/xyz`, '')).toMatchObject({ view: 'files' });
    expect(parseSourceRoute(`/source/${repo}`, '?at=-1')).toEqual({
      view: 'files',
      repo,
      path: '',
      ref: 'main',
    });
  });
});

describe('patch rows', () => {
  it('numbers old and new lines across hunks', () => {
    const rows = patchRows(
      '@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -9 +9,2 @@\n x\n+y\n\\ No newline at end of file\n',
    );
    expect(rows).toEqual([
      { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { kind: 'context', text: 'a', old: 1, new: 1 },
      { kind: 'delete', text: 'b', old: 2 },
      { kind: 'add', text: 'B', new: 2 },
      { kind: 'hunk', text: '@@ -9 +9,2 @@' },
      { kind: 'context', text: 'x', old: 9, new: 9 },
      { kind: 'add', text: 'y', new: 10 },
      { kind: 'note', text: 'No newline at end of file' },
    ]);
  });
});
