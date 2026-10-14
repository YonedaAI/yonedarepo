import { describe, expect, it, vi } from 'vitest';
import type { GuidedSession, StartGuidedStep } from '../../../../shared/guided-runs';
import { ApiError } from '../../lib/api';
import { createGuidedStepStart, readGuidedSession } from './guidedClient';

import { sessionFixture } from './guidedFixture';

const input: Omit<StartGuidedStep, 'request_id'> = {
  session_id: 'session-1',
  profile_id: 'task-board-v1',
  step_id: 'build',
  expected_commit: 'base',
  expected_version: 1,
};

describe('explicit guided stage start', () => {
  it('reloads an uncertain saved start through reads instead of minting another paid request', async () => {
    let saved: StartGuidedStep | undefined;
    const journal = {
      read: () => saved,
      save: (request: StartGuidedStep) => {
        saved = request;
      },
      clear: () => {
        saved = undefined;
      },
    };
    const calls: unknown[] = [];
    const transport = async (_path: string, body?: unknown) => {
      if (body) {
        calls.push(body);
        throw new ApiError('REQUEST_TIMEOUT', 'lost ack');
      }
      return sessionFixture();
    };
    const first = createGuidedStepStart('fresh-repo', transport, journal);
    await expect(first.start(input)).rejects.toThrow('Refresh');
    const frozenId = saved?.request_id;
    const resumed = createGuidedStepStart('fresh-repo', transport, journal);
    await expect(resumed.start(input)).rejects.toThrow('Refresh');
    expect(calls).toHaveLength(1);
    expect(saved?.request_id).toBe(frozenId);
  });
  it('sends only the approved six fields once for duplicate clicks; no client models or budgets', async () => {
    let resolve!: (value: GuidedSession) => void;
    const calls: { path: string; body?: unknown }[] = [];
    const transport = vi.fn(async <T>(path: string, body?: unknown): Promise<T> => {
      calls.push({ path, body });
      return (await new Promise<GuidedSession>((done) => {
        resolve = done;
      })) as T;
    });
    const start = createGuidedStepStart('fresh-repo', transport);
    expect(calls).toEqual([]);
    const first = start.start(input);
    const second = start.start(input);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].body as object).sort()).toEqual(
      [
        'request_id',
        'session_id',
        'profile_id',
        'step_id',
        'expected_commit',
        'expected_version',
      ].sort(),
    );
    expect(calls[0].path).toBe('repos/fresh-repo/start_guided_step');
    const result = sessionFixture();
    result.steps[0] = { ...result.steps[0], status: 'running', run_ids: ['real-run'] };
    resolve(result);
    await expect(first).resolves.toEqual(result);
    await expect(second).resolves.toEqual(result);
  });

  it('keeps an ambiguous start frozen and performs only reads until server evidence identifies existing stage work', async () => {
    let observed = sessionFixture();
    const calls: { path: string; body?: unknown }[] = [];
    const transport = async <T>(path: string, body?: unknown): Promise<T> => {
      calls.push({ path, body });
      if (body) throw new ApiError('REQUEST_TIMEOUT', 'lost acknowledgment');
      return observed as T;
    };
    const start = createGuidedStepStart('fresh-repo', transport);
    await expect(start.start(input)).rejects.toThrow('Refresh');
    await expect(start.start({ ...input, expected_commit: 'changed' })).rejects.toThrow('Refresh');
    expect(calls.filter((call) => call.body)).toHaveLength(1);
    observed = {
      ...observed,
      steps: observed.steps.map((step) =>
        step.id === 'build' ? { ...step, status: 'running', run_ids: ['existing-run'] } : step,
      ),
    };
    await expect(start.reconcile()).resolves.toEqual(observed);
    expect(calls.filter((call) => call.body)).toHaveLength(1);
  });

  it('rejects a mismatched session/profile or fabricated duplicate stages', () => {
    expect(() =>
      readGuidedSession({ ...sessionFixture(), profile_id: 'historical-demo' }, 'session-1'),
    ).toThrow();
    expect(() => readGuidedSession(sessionFixture(), 'other-session')).toThrow();
    expect(() =>
      readGuidedSession({ ...sessionFixture(), steps: [sessionFixture().steps[0]] }, 'session-1'),
    ).toThrow();
  });
});
