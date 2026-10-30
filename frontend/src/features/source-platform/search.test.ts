import { describe, expect, it } from 'vitest';
import { aroundLine } from './FileText';
import {
  type CodeHit,
  foundNothing,
  highlight,
  recordSections,
  type SearchAnswer,
  searchPath,
  shownLines,
} from './searchModel';

const repo = 'r0123456789abcdef0123';
const empty: SearchAnswer = { results: [], skipped_files: [], skipped_count: 0 };

describe('a file opened at a line', () => {
  it('splits the text around the line, keeping every line ending', () => {
    const content = 'one\n\nthree\nfour\n';
    const parts = aroundLine(content, 3);
    expect(parts).toEqual({ before: ['one\n', '\n'], target: 'three', after: ['\nfour', '\n'] });
    expect(`${parts?.before.join('')}${parts?.target}${parts?.after.join('')}`).toBe(content);
  });

  it('finds no line past the end of a file that has changed since', () => {
    expect(aroundLine('one\ntwo', 3)).toBeNull();
  });
});

describe('repository search', () => {
  it('asks for every group, case-insensitive', () => {
    expect(searchPath(repo, 'retry backoff')).toBe(
      `/repos/${repo}/search?query=retry%20backoff&ignore_case=true`,
    );
    expect(searchPath(repo, 'test', true)).toBe(
      `/repos/${repo}/search?query=test&ignore_case=true&word=true`,
    );
  });

  it('marks the ranges the platform matched (UTF-16 offsets)', () => {
    expect(highlight('export function test() {}', [[16, 20]])).toEqual([
      { text: 'export function ', mark: false },
      { text: 'test', mark: true },
      { text: '() {}', mark: false },
    ]);
    expect(
      highlight('é test test', [
        [2, 6],
        [7, 11],
      ]),
    ).toEqual([
      { text: 'é ', mark: false },
      { text: 'test', mark: true },
      { text: ' ', mark: false },
      { text: 'test', mark: true },
    ]);
    expect(highlight('plain', undefined)).toEqual([{ text: 'plain', mark: false }]);
  });

  it('shows the first lines of a file and counts the matches left in it', () => {
    const line = (n: number, marks: number) => ({
      line: n,
      text: 'x',
      ranges: Array.from({ length: marks }, () => [0, 1] as [number, number]),
    });
    const hit: CodeHit = {
      path: 'src/a.ts',
      match: 'word',
      hits: 12,
      lines: [line(1, 2), line(4, 1), line(9, 1), line(10, 3), line(11, 1)],
    };
    expect(shownLines(hit, false)).toEqual({ lines: hit.lines.slice(0, 3), more: 8 });
    expect(shownLines(hit, true)).toEqual({ lines: hit.lines, more: 4 });
    expect(shownLines({ path: 'test/x.md', match: 'path', hits: 0, lines: [] }, false)).toEqual({
      lines: [],
      more: 0,
    });
  });

  it('lists commits, sessions and changes with their counts, linked to their pages', () => {
    const answer: SearchAnswer = {
      ...empty,
      commits: {
        count: 1000,
        capped: true,
        results: [
          {
            commit: 'a'.repeat(40),
            subject: 'Retry fetches',
            principal: 'token:agent',
            recorded_at: 1,
            matched: ['subject'],
            paths: ['src/fetch.rs'],
          },
        ],
      },
      sessions: {
        count: 1,
        capped: false,
        results: [
          {
            id: 7,
            commit: 'a'.repeat(40),
            cli: 'opencode',
            model: 'glm-5.3',
            session_id: 'opencode:s',
            summary: 'Added a retry budget\nmore',
            at: 1,
            matched: ['summary'],
            reads: [],
          },
        ],
      },
      changes: { count: 0, capped: false, results: [] },
    };
    const sections = recordSections(repo, answer);
    expect(sections.map((s) => [s.key, s.count])).toEqual([
      ['commits', '1000+'],
      ['sessions', '1'],
    ]);
    expect(sections[0].rows[0]).toEqual({
      key: 'a'.repeat(40),
      route: { view: 'commit', repo, commit: 'a'.repeat(40) },
      label: `${'a'.repeat(12)} Retry fetches`,
      detail: 'agent (token) · src/fetch.rs',
    });
    expect(sections[1].rows[0]).toMatchObject({
      route: { view: 'session', repo, id: 7 },
      label: 'opencode · glm-5.3',
      detail: 'Added a retry budget',
    });
    expect(foundNothing(answer)).toBe(false);
  });

  it('finds nothing only when every group is empty or not readable', () => {
    expect(
      foundNothing({
        ...empty,
        memories: null,
        commits: { count: 0, capped: false, results: [] },
        sessions: null,
        changes: null,
      }),
    ).toBe(true);
    expect(recordSections(repo, empty)).toEqual([]);
  });
});
