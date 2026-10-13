import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { createRunStart } from './runStart';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('one start per brief', () => {
  it.each(['ALREADY_EXISTS', 'HEAD_MOVED', 'POLICY_CHANGED', 'SPEND_LIMIT'])(
    'keeps the timed-out draft frozen when a late commit races NOT_FOUND and the retry returns %s',
    async (code) => {
      vi.useFakeTimers();
      let id = '';
      let committed = false;
      const posts: Record<string, unknown>[] = [];
      const fetch = vi.fn(async (path: string, init: RequestInit) => {
        if (init.method === 'POST') {
          const body = JSON.parse(String(init.body));
          posts.push(body);
          if (posts.length === 1) {
            id = body.id;
            return new Promise<Response>(() => {});
          }
          // The original request committed after the first readback, before this duplicate.
          committed = true;
          return Response.json(
            { error: { code, message: 'Retry rejected after original run committed' } },
            { status: 409 },
          );
        }
        expect(path).toBe(`/api/repos/repo/run_detail?run_id=${id}`);
        if (committed) return Response.json({ run: { id } });
        return Response.json(
          { error: { code: 'NOT_FOUND', message: 'Unknown run' } },
          { status: 404 },
        );
      });
      vi.stubGlobal('fetch', fetch);
      const launcher = createRunStart('repo');
      const brief = {
        intent: 'Fix booking persistence',
        working_branch_id: 'booking-work',
        expected_working_commit: 'original-head',
        expected_working_version: 1,
        adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'testing' }] },
      };
      const first = launcher.start(brief);
      const timeout = expect(first).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(20_000);
      await timeout;
      await expect(launcher.start({ intent: 'edited after timeout' })).rejects.toMatchObject({
        code,
      });
      expect(launcher.uncertain).toBe(true);
      expect(posts).toHaveLength(2);
      expect(posts[1]).toEqual(posts[0]);
      expect(await launcher.start({ intent: 'edited again' })).toBe(id);
      expect(launcher.uncertain).toBe(false);
      expect(posts).toHaveLength(2);
      expect(fetch.mock.calls.map(([, init]) => init.method)).toEqual([
        'POST',
        'GET',
        'POST',
        'GET',
      ]);
    },
  );
  it.each(['HEAD_MOVED', 'POLICY_CHANGED', 'SPEND_LIMIT', 'INVALID_INPUT'])(
    'keeps a definite first-attempt %s rejection editable without inventing a new run ID',
    async (code) => {
      const send = vi
        .fn()
        .mockRejectedValueOnce(new ApiError(code, 'initial validation rejected'))
        .mockResolvedValueOnce({});
      const launcher = createRunStart('repo', send);
      await expect(launcher.start({ intent: 'Original brief' })).rejects.toMatchObject({ code });
      expect(launcher.uncertain).toBe(false);
      const id = await launcher.start({ intent: 'Corrected brief' });
      expect(send.mock.calls.map(([path]) => path)).toEqual([
        'repos/repo/start_run',
        'repos/repo/start_run',
      ]);
      expect(send.mock.calls[0][1]).toMatchObject({ id, intent: 'Original brief' });
      expect(send.mock.calls[1][1]).toMatchObject({ id, intent: 'Corrected brief' });
    },
  );
  it('retains ambiguity after a definitive retry rejection until an authoritative read resolves the original start', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('REQUEST_TIMEOUT', 'timeout'))
      .mockRejectedValueOnce(new ApiError('NOT_FOUND', 'not committed yet'))
      .mockRejectedValueOnce(new ApiError('BUDGET_EXHAUSTED', 'retry rejected'))
      .mockRejectedValueOnce(new ApiError('FORBIDDEN', 'readback denied'));
    const launcher = createRunStart('repo', send);
    await expect(launcher.start({ intent: 'original brief' })).rejects.toThrow('timeout');
    await expect(launcher.start({ intent: 'edited brief' })).rejects.toThrow('retry rejected');
    expect(launcher.uncertain).toBe(true);
    await expect(launcher.start({ intent: 'edited again' })).rejects.toThrow('readback denied');
    expect(launcher.uncertain).toBe(true);
    const posts = send.mock.calls.filter(([path]) => path.endsWith('start_run'));
    expect(posts).toHaveLength(2);
    expect(posts[1][1]).toEqual(posts[0][1]);
  });
  it('uses the actual 20-second API deadline and reconciles a committed start without reposting', async () => {
    vi.useFakeTimers();
    let accepted = '';
    const fetch = vi.fn(async (path: string, init: RequestInit) => {
      if (init.method === 'POST') {
        accepted = JSON.parse(String(init.body)).id;
        return new Promise<Response>(() => {});
      }
      expect(path).toBe(`/api/repos/repo/run_detail?run_id=${accepted}`);
      return new Response(JSON.stringify({ run: { id: accepted } }));
    });
    vi.stubGlobal('fetch', fetch);
    const launcher = createRunStart('repo');
    const pending = launcher.start({ intent: 'Fix persistence' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    expect(launcher.start({ intent: 'double click' })).toBe(pending);
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(launcher.uncertain).toBe(true);
    expect(await launcher.start({ intent: 'edited' })).toBe(accepted);
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });
  it('reposts only after authoritative NOT_FOUND, using the identical ID, body and preferences', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('REQUEST_TIMEOUT', 'timeout'))
      .mockRejectedValueOnce(new ApiError('NOT_FOUND', 'unknown run'))
      .mockResolvedValueOnce({});
    const launcher = createRunStart('repo', send);
    const brief = {
      intent: 'Fix bug',
      adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'testing' }] },
    };
    await expect(launcher.start(brief)).rejects.toThrow('timeout');
    const first = structuredClone(send.mock.calls[0][1]);
    brief.adaptive_team.requested_agents[0].role = 'backend';
    const id = await launcher.start({ intent: 'new text' });
    expect(send.mock.calls[2][1]).toEqual(first);
    expect(id).toBe(first.id);
  });
  it('stops if readback is forbidden or incomplete, instead of guessing that no run exists', async () => {
    for (const response of [new ApiError('FORBIDDEN', 'forbidden'), { run: { id: 'different' } }]) {
      const send = vi.fn().mockRejectedValueOnce(new ApiError('REQUEST_TIMEOUT', 'timeout'));
      if (response instanceof Error) send.mockRejectedValueOnce(response);
      else send.mockResolvedValueOnce(response);
      const launcher = createRunStart('repo', send);
      await expect(launcher.start({ intent: 'work' })).rejects.toThrow();
      await expect(launcher.start({ intent: 'work' })).rejects.toThrow();
      expect(send.mock.calls.filter(([path]) => path.endsWith('start_run'))).toHaveLength(1);
    }
  });
});
