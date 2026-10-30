import { describe, expect, it } from 'vitest';
import type { PlatformRepo } from '../shell/repoRows';
import type { SearchAnswer } from '../source-platform/searchModel';
import { SourceApiError } from '../source-platform/sourceApi';
import {
  askRepository,
  CONCURRENCY,
  capNote,
  fanOut,
  isTyping,
  matched,
  REPO_CAP,
  searchPlan,
} from './searchAllModel';

const id = (n: number) => `r${String(n).padStart(20, '0')}`;
const repo = (n: number, created_at = n): PlatformRepo => ({
  id: id(n),
  name: `repo-${n}`,
  created_at,
});
const nothing: SearchAnswer = { results: [], skipped_files: [], skipped_count: 0 };
const hit: SearchAnswer = { ...nothing, results: [{ path: 'a.rs', hits: 1, lines: [] }] };

describe('the repositories an all-repositories search asks', () => {
  it('asks the ones with the newest sessions first, then the newest created', () => {
    const plan = searchPlan(
      [repo(1), repo(2), repo(3), repo(4)],
      [
        { repo: id(1), at: 50 },
        { repo: id(3), at: 90 },
        { repo: id(1), at: 10 },
      ],
    );
    expect(plan).toEqual({ repos: [id(3), id(1), id(4), id(2)], capped: false });
  });

  it('asks every repository up to the cap', () => {
    const repos = Array.from({ length: REPO_CAP }, (_, i) => repo(i));
    expect(searchPlan(repos, []).capped).toBe(false);
    expect(searchPlan(repos, []).repos).toHaveLength(REPO_CAP);
    expect(capNote(searchPlan(repos, []))).toBeUndefined();
  });

  it('stops at the cap and says so', () => {
    const repos = Array.from({ length: REPO_CAP + 1 }, (_, i) => repo(i));
    const plan = searchPlan(repos, [{ repo: id(0), at: 1 }]);
    expect(plan.capped).toBe(true);
    expect(plan.repos).toHaveLength(REPO_CAP);
    expect(plan.repos[0]).toBe(id(0));
    expect(plan.repos).not.toContain(id(1));
    expect(capNote(plan)).toBe(
      'Searched your 25 most recent repositories. Pick one to search it fully.',
    );
  });
});

describe('fanning out', () => {
  /** Runs the fan-out by hand: each `run` waits until the test finishes it. */
  function held(items: string[], signal = new AbortController().signal) {
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    let running = 0;
    let most = 0;
    const done = fanOut(
      items,
      (item) =>
        new Promise<void>((resolve) => {
          started.push(item);
          most = Math.max(most, ++running);
          finish.set(item, () => {
            running--;
            resolve();
          });
        }),
      signal,
    );
    return { started, finish, done, most: () => most };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  const items = Array.from({ length: 10 }, (_, i) => id(i));

  it('asks in order, never more than the limit at once', async () => {
    const run = held(items);
    expect(run.started).toEqual(items.slice(0, CONCURRENCY));
    for (const item of items) {
      await settle();
      run.finish.get(item)?.();
    }
    await run.done;
    expect(run.started).toEqual(items);
    expect(run.most()).toBe(CONCURRENCY);
  });

  it('starts nothing more once aborted', async () => {
    const controller = new AbortController();
    const run = held(items, controller.signal);
    controller.abort();
    for (const finish of [...run.finish.values()]) finish();
    await run.done;
    expect(run.started).toEqual(items.slice(0, CONCURRENCY));
  });

  it('keeps going past a repository that fails', async () => {
    const asked: string[] = [];
    const seen: string[] = [];
    await fanOut(
      items.slice(0, 6),
      async (item) => {
        const answer = await askRepository(item, 'retry', new AbortController().signal, (path) => {
          asked.push(path);
          return Promise.reject(new Error('down'));
        });
        seen.push(answer?.kind ?? '');
      },
      new AbortController().signal,
    );
    expect(asked).toHaveLength(6);
    expect(seen).toEqual(Array(6).fill('failed'));
  });
});

describe('one repository’s answer', () => {
  const live = new AbortController().signal;
  const failing = (error: unknown) => () => Promise.reject(error);

  it('sorts answers into matches and none', async () => {
    expect(await askRepository(id(1), 'retry', live, async () => hit)).toEqual({
      repo: id(1),
      kind: 'found',
      answer: hit,
    });
    expect(await askRepository(id(1), 'retry', live, async () => nothing)).toEqual({
      repo: id(1),
      kind: 'none',
    });
  });

  it('asks the existing search API', async () => {
    let path = '';
    await askRepository(id(1), 'a b', live, async (asked) => {
      path = asked;
      return nothing;
    });
    expect(path).toBe(`/repos/${id(1)}/search?query=a%20b&ignore_case=true`);
  });

  it('tells a repository with nothing to read from a failure', async () => {
    const missing = new SourceApiError('NOT_FOUND', 'main does not exist', 404);
    expect(await askRepository(id(1), 'retry', live, failing(missing))).toEqual({
      repo: id(1),
      kind: 'unreadable',
    });
    const down = new SourceApiError('OVERLOADED', 'Something went wrong on our side.', 503);
    expect(await askRepository(id(1), 'retry', live, failing(down))).toEqual({
      repo: id(1),
      kind: 'failed',
      error: 'Something went wrong on our side.',
    });
  });

  it('answers nothing for a cancelled search', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await askRepository(id(1), 'retry', controller.signal, failing(new Error('x')))).toBe(
      null,
    );
  });

  it('counts the repositories that matched', () => {
    expect(
      matched([
        { repo: id(1), kind: 'found', answer: hit },
        { repo: id(2), kind: 'none' },
        { repo: id(3), kind: 'failed', error: 'x' },
      ]),
    ).toEqual([{ repo: id(1), kind: 'found', answer: hit }]);
  });
});

describe('the / shortcut', () => {
  it('leaves typing alone', () => {
    expect(isTyping({ tagName: 'INPUT' })).toBe(true);
    expect(isTyping({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTyping({ tagName: 'SELECT' })).toBe(true);
    expect(isTyping({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTyping({ tagName: 'BODY' })).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});
