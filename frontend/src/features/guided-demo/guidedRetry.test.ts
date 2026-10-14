import { describe, expect, it } from 'vitest';
import type { GuidedSession, StartGuidedStep } from '../../../../shared/guided-runs';
import { ApiError } from '../../lib/api';
import type { Repository } from '../../lib/types';
import { createGuidedStepStart, readGuidedSession } from './guidedClient';
import { sessionFixture } from './guidedFixture';
import { guidedStartJournal } from './guidedStartJournal';
import { guidedRetryInput } from './guidedStepInput';

const repository = { status: 'ready', head_commit: 'published', version: 1 } as Repository;
/** Synthetic UI state: the build step's only run ended without complete evidence. */
function failedBuild(): GuidedSession {
  const session = sessionFixture();
  session.working_revision = { repository: 'artifacts', commit: 'checked' };
  session.working_version = 0;
  session.steps[0] = {
    ...session.steps[0],
    status: 'needs_attention',
    run_ids: ['first-run'],
    attempt: 1,
    next_action: null,
  };
  return session;
}
function memoryStore() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe('guided step retry', () => {
  it('builds a retry request only for a step that needs attention on the checked lease', () => {
    expect(guidedRetryInput(failedBuild(), 'build', repository)).toEqual({
      session_id: 'session-1',
      profile_id: 'task-board-v1',
      step_id: 'build',
      expected_commit: 'checked',
      expected_version: 0,
      retry: true,
    });
    expect(() => guidedRetryInput(sessionFixture(), 'build', repository)).toThrow('Refresh');
    const running = failedBuild();
    running.steps[0].status = 'running';
    expect(() => guidedRetryInput(running, 'build', repository)).toThrow('Refresh');
  });

  it('sends retry once and confirms a lost acknowledgment only from an advanced attempt', async () => {
    let observed = failedBuild();
    const posts: unknown[] = [];
    const transport = async <T>(_path: string, body?: unknown): Promise<T> => {
      if (body) {
        posts.push(body);
        throw new ApiError('REQUEST_TIMEOUT', 'lost acknowledgment');
      }
      return observed as T;
    };
    const store = memoryStore();
    const journal = guidedStartJournal('fresh-repo', 'session-1', 'build', store, 1);
    const retry = createGuidedStepStart('fresh-repo', transport, journal, 1);
    await expect(retry.start(guidedRetryInput(observed, 'build', repository))).rejects.toThrow(
      'Refresh',
    );
    expect(posts).toHaveLength(1);
    expect((posts[0] as StartGuidedStep).retry).toBe(true);
    // The unchanged failed attempt is not proof that the retry happened.
    await expect(retry.reconcile()).rejects.toThrow('Refresh');
    const resumed = createGuidedStepStart(
      'fresh-repo',
      transport,
      guidedStartJournal('fresh-repo', 'session-1', 'build', store, 1),
      1,
    );
    expect(resumed.uncertain).toBe(true);
    observed = failedBuild();
    observed.steps[0] = {
      ...observed.steps[0],
      status: 'running',
      attempt: 2,
      run_ids: ['first-run-r2'],
      previous_run_ids: ['first-run'],
    };
    await expect(resumed.reconcile()).resolves.toEqual(observed);
    expect(posts).toHaveLength(1);
  });

  it('keeps retry and first-start journals apart and rejects an altered saved retry', () => {
    const store = memoryStore();
    const start = guidedStartJournal('repo', 'session-1', 'build', store);
    const retry = guidedStartJournal('repo', 'session-1', 'build', store, 1);
    const request: StartGuidedStep = {
      request_id: 'retry-1',
      session_id: 'session-1',
      profile_id: 'task-board-v1',
      step_id: 'build',
      expected_commit: 'checked',
      expected_version: 0,
      retry: true,
    };
    retry.save(request);
    expect(start.read()).toBeUndefined();
    expect(retry.read()).toEqual(request);
    for (const [key] of store.items)
      store.items.set(key, JSON.stringify({ ...request, retry: false }));
    expect(() => retry.read()).toThrow('could not be verified');
  });

  it('verifies attempt history from the server response', () => {
    const session = failedBuild();
    expect(readGuidedSession(session, 'session-1').steps[0].attempt).toBe(1);
    for (const change of [{ attempt: 0 }, { attempt: '2' }, { previous_run_ids: [''] }]) {
      const bad = failedBuild();
      bad.steps[0] = { ...bad.steps[0], ...change } as (typeof bad.steps)[number];
      expect(() => readGuidedSession(bad, 'session-1')).toThrow();
    }
  });
});
