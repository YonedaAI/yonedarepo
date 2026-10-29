import { describe, expect, it } from 'vitest';
import { foundNothing, recordSections, type SearchAnswer, searchPath } from './searchModel';

const repo = 'r0123456789abcdef0123';
const empty: SearchAnswer = { results: [], skipped_files: [], skipped_count: 0 };

describe('repository search', () => {
  it('asks for every group, case-insensitive', () => {
    expect(searchPath(repo, 'retry backoff')).toBe(
      `/repos/${repo}/search?query=retry%20backoff&ignore_case=true`,
    );
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
      detail: 'token:agent · src/fetch.rs',
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
